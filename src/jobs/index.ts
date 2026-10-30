import { Store } from '../storage/index.js';
import { ArticleService } from '../providers/service.js';
import { Exporter } from '../export/index.js';
import type { Article, Counts, FetchResult, Job, JobItem, JobState } from '../shared/model.js';
import { abort, failure, id, now, Serial, sleep, WxError } from '../shared/util.js';

const TERMINAL: JobState[] = ['completed', 'completed_with_errors', 'failed', 'cancelled'];
export const emptyCounts = (): Counts => ({ checked_count: 0, accepted_count: 0, success_count: 0, partial_count: 0, filtered_count: 0, failed_count: 0, duplicate_count: 0, stale_count: 0 });
export class JobRunner {
  private queue = new Serial(); private active = new Map<string, { job: Job; controller: AbortController; started: boolean; task?: Promise<unknown> }>(); private tasks = new Set<Promise<unknown>>(); private closed = false;
  exporter: Exporter;
  constructor(private store: Store, private service: ArticleService) { this.exporter = new Exporter(store); }
  private base(kind: Job['kind'], config: any): Job {
    return { job_id: id('job'), kind, state: 'queued', config, created_at: now(), updated_at: now(), counts: emptyCounts(), coverage: { provider: kind === 'export' ? 'local_library' : config.input.type === 'urls' ? 'public_http/opencli_browser' : 'opencli_sogou', mode: kind === 'export' ? 'local_library' : config.input.type === 'urls' ? 'url_list' : 'search_results', checked_count: 0, returned_count: 0, truncated: false, may_have_gaps: kind !== 'export' && config.input.type !== 'urls', has_more: null, next_cursor: null, stop_reason: 'queued' }, items: [], checkpoint: { query_index: 0, page: 1, pages_read: 0, files: [], media_bytes: 0 }, elapsed_ms: 0 };
  }
  startCollection(config: any, key?: string) {
    if (config.input.type === 'account') throw new WxError('UNSUPPORTED_CAPABILITY', '未启用公众号历史来源');
    if (config.published_from && config.published_before && config.published_from >= config.published_before) throw new WxError('INVALID_INPUT', '日期区间起点必须早于终点');
    const j = this.base('collection', config);
    if (config.input.type === 'urls') j.items = config.input.urls.map((url: string, index: number) => ({ index, input: url, status: 'pending' }));
    const result = this.store.createJob(j, { kind: 'collection', config }, key); if (result.created) this.schedule(j); return result.job;
  }
  startExport(config: any, key?: string) {
    // Idempotency compares the user's selector and options, not mutable latest versions.
    const request = { ...config }; let articles: Article[];
    if (config.job_id) { const source = this.store.job(config.job_id); articles = source.items.filter(i => ['success', 'partial'].includes(i.status) && i.article_id).map(i => this.store.article(i.article_id!, i.content_version)); }
    else articles = [...new Set<string>(config.article_ids)].map(x => this.store.article(x));
    const snapshots = [...new Map(articles.map(a => [`${a.article_id}/${a.content_version}`, a])).values()].map(a => ({ article_id: a.article_id, content_version: a.content_version }));
    if (!snapshots.length) throw new WxError('INVALID_INPUT', '没有可导出的文章');
    const j = this.base('export', { ...config, articles: snapshots, export_id: id('export') });
    j.items = snapshots.map((a, index) => ({ index, input: a.article_id, ...a, status: 'pending' }));
    const result = this.store.createJob(j, { kind: 'export', request }, key); if (result.created) this.schedule(j); return result.job;
  }
  private schedule(j: Job) {
    if (this.closed) throw new WxError('CONFLICT', '服务正在停止');
    const controller = new AbortController(); const active = { job: j, controller, started: false, task: undefined as Promise<unknown> | undefined }; this.active.set(j.job_id, active);
    const task = this.queue.run(async () => { if (j.state !== 'queued' || controller.signal.aborted) return; active.started = true; await this.run(j, controller); }).finally(() => { if (this.active.get(j.job_id)?.controller === controller) this.active.delete(j.job_id); }); active.task = task;
    this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => {});
  }
  async control(jobId: string, action: 'pause' | 'resume' | 'cancel') {
    const current = this.active.get(jobId); const j = current?.job ?? this.store.job(jobId);
    if (TERMINAL.includes(j.state)) throw new WxError('CONFLICT', '终态任务不能恢复、暂停或取消，请创建新任务');
    if (action === 'resume') {
      if (['queued', 'running', 'backoff'].includes(j.state)) throw new WxError('CONFLICT', '任务已在执行队列');
      if (j.next_attempt_at && Date.parse(j.next_attempt_at) > Date.now()) throw new WxError('RATE_LIMITED', '来源冷却时间尚未结束', true, '等待 next_attempt_at 后显式恢复', Math.ceil((Date.parse(j.next_attempt_at)-Date.now())/1000));
      // Await the previous safe boundary before scheduling the same persisted checkpoint.
      if (current) { current.controller.abort(); if (current.started && current.task) await current.task; }
      await this.service.status(true); j.state = 'queued'; j.error = undefined; j.next_attempt_at = undefined;
      j.coverage.truncated = Boolean(j.checkpoint.budget_stop_reason); j.coverage.stop_reason = j.checkpoint.budget_stop_reason ?? 'queued';
      for (const item of j.items) if (item.status === 'waiting') item.status = 'pending';
      this.store.saveJob(j); this.schedule(j);
    } else {
      if (action === 'pause' && j.state === 'paused') throw new WxError('CONFLICT', '任务已经暂停');
      j.state = action === 'pause' ? 'paused' : 'cancelled'; j.coverage.stop_reason = j.state; j.coverage.truncated = true; this.store.saveJob(j); current?.controller.abort();
      if (j.kind === 'export') j.result = await this.exporter.manifest(j, false);
      this.store.saveJob(j);
    }
    return j;
  }
  private count(j: Job) {
    const c = emptyCounts();
    for (const i of j.items) {
      if (i.status !== 'pending') c.checked_count++;
      if (i.status === 'success') c.success_count++; if (i.status === 'partial') c.partial_count++;
      if (i.status === 'filtered') c.filtered_count++; if (i.status === 'failed') c.failed_count++; if (i.status === 'duplicate') c.duplicate_count++; if (i.stale) c.stale_count++;
    }
    c.accepted_count = c.success_count + c.partial_count; j.counts = c; j.coverage.checked_count = c.checked_count; j.coverage.returned_count = c.accepted_count;
  }
  private async discover(j: Job, signal: AbortSignal): Promise<boolean> {
    const c = j.config, cp = j.checkpoint;
    if (c.input.type !== 'search' || cp.query_index >= c.input.queries.length) return false;
    cp.pages_read ??= 0;
    if (cp.pages_read >= c.max_pages) { j.coverage.truncated = true; j.coverage.stop_reason = cp.budget_stop_reason = 'max_pages'; return false; }
    const result = await this.service.search(c.input.queries[cp.query_index], cp.page, Math.min(10, c.max_discovered - j.counts.checked_count), signal);
    cp.pages_read++;
    for (const candidate of result.candidates) j.items.push({ index: j.items.length, input: candidate.discovered_url, status: 'pending' });
    if (!result.candidates.length) { cp.query_index++; cp.page = 1; } else cp.page++;
    if (cp.pages_read >= c.max_pages && cp.query_index < c.input.queries.length) { j.coverage.truncated = true; j.coverage.stop_reason = cp.budget_stop_reason = 'max_pages'; }
    this.store.saveJob(j); return result.candidates.length > 0 || cp.query_index < c.input.queries.length;
  }
  private filter(a: Article, c: any): string | undefined {
    if (c.require_complete && a.content_status !== 'complete') return 'require_complete:partial_content';
    if (c.account_id && a.account_id !== c.account_id) return a.account_id ? 'account_mismatch' : 'account_unverifiable';
    if (c.account_name && a.account_name !== c.account_name) return a.account_name ? 'account_name_mismatch' : 'account_name_unverifiable';
    if ((c.published_from || c.published_before) && !a.published_at) return 'published_at_unverifiable';
    if (c.published_from && a.published_at! < c.published_from || c.published_before && a.published_at! >= c.published_before) return 'published_out_of_range';
  }
  private async collect(j: Job, item: JobItem, signal: AbortSignal) {
    const cfg = j.config; const url = await this.service.resolve(item.input, signal);
    const cached = this.store.cached(url); let result: FetchResult | undefined; let parsed: Awaited<ReturnType<ArticleService['draft']>> | undefined;
    if (cached && !cfg.refresh) result = { article: cached, cache_hit: true, stale: false };
    else {
      try { parsed = await this.service.draft(url, signal); }
      catch (e) {
        abort(signal); if (!cached) throw e; const err = failure(e); this.store.attempt(cached.article_id, err);
        item.stale = true; item.article_id = cached.article_id; item.content_version = cached.content_version;
        if (['AUTH_REQUIRED','VERIFICATION_REQUIRED','NETWORK_ERROR','RATE_LIMITED','SOURCE_UNAVAILABLE'].includes(err.code)) throw e;
        result = { article: cached, cache_hit: true, stale: true, last_attempt: this.store.lastAttempt(cached.article_id) };
      }
    }
    const a = result?.article ?? parsed!.draft;
    const duplicate = j.items.some(i => i !== item && ['success', 'partial'].includes(i.status) && i.article_id === a.article_id);
    if (duplicate) { item.status = 'duplicate'; item.article_id = a.article_id; return; }
    const reason = this.filter(a, cfg);
    if (reason) { item.status = 'filtered'; item.reason = reason; return; }
    if (result?.stale && cfg.refresh) { item.status = 'failed'; item.stale = true; item.error = result.last_attempt!.error; item.article_id = a.article_id; item.content_version = a.content_version; return; }
    if (parsed) { if (cfg.download_images) { const budget = { bytes: j.checkpoint.media_bytes }; await this.service.download(parsed.draft, budget, signal); j.checkpoint.media_bytes = budget.bytes; } abort(signal); result = { article: await this.store.saveArticle(parsed.draft, [...parsed.aliases, item.input]), cache_hit: false, stale: false }; }
    else if (cfg.download_images && a.media_status !== 'complete') {
      const draft = { ...a, snapshot: '' }; const budget = { bytes: j.checkpoint.media_bytes }; await this.service.download(draft, budget, signal); j.checkpoint.media_bytes = budget.bytes;
      // Reuse the original sanitized snapshot rather than overwrite it with a fabricated page.
      const { readFile } = await import('node:fs/promises'); const { inside } = await import('../shared/util.js');
      draft.snapshot = await readFile(inside(this.store.cfg.data_dir, 'articles', a.article_id, a.content_version, 'snapshot.html'), 'utf8'); result!.article = await this.store.saveArticle(draft, [item.input, url]);
    }
    item.article_id = result!.article.article_id; item.content_version = result!.article.content_version; item.status = result!.article.content_status === 'complete' ? 'success' : 'partial'; item.stale = false; item.error = undefined;
  }
  private waiting(j: Job, e: unknown, item?: JobItem) {
    const error = failure(e); j.error = error;
    j.state = error.code === 'AUTH_REQUIRED' ? 'waiting_auth' : error.code === 'VERIFICATION_REQUIRED' ? 'waiting_verification' : 'waiting_source';
    if (item) { item.status = 'waiting'; item.error = error; } j.coverage.stop_reason = j.state; this.store.saveJob(j);
  }
  private async run(j: Job, controller: AbortController) {
    const start = Date.now(); let last = start;
    const tick = () => { const t = Date.now(); j.elapsed_ms += t - last; last = t; };
    j.state = 'running'; this.store.saveJob(j);
    const remaining = j.kind === 'collection' ? j.config.max_duration_seconds * 1000 - j.elapsed_ms : 3600000;
    const timer = setTimeout(() => controller.abort(new WxError('CANCELLED', '任务达到执行时间上限')), Math.max(1, remaining));
    const signal = controller.signal;
    try {
      if (j.kind === 'export') j.result = await this.exporter.manifest(j);
      while (j.state === 'running') {
        abort(signal); this.count(j);
        const pending = j.items.some(i => i.status === 'pending');
        if (j.kind === 'collection' && !pending && (j.config.input.type === 'urls' || j.checkpoint.query_index >= j.config.input.queries.length)) break;
        if (j.kind === 'collection' && (j.counts.accepted_count >= j.config.max_articles || j.counts.checked_count >= j.config.max_discovered)) { j.coverage.truncated = true; j.coverage.stop_reason = j.counts.accepted_count >= j.config.max_articles ? 'max_articles' : 'max_discovered'; break; }
        const item = j.items.find(i => i.status === 'pending');
        if (!item) { if (j.kind === 'collection' && await this.discover(j, signal)) continue; break; }
        let done = false;
        for (let attempt = 0; attempt <= this.store.cfg.retry.max_retries; attempt++) {
          abort(signal); item.attempts = (item.attempts ?? 0) + 1;
          try {
            if (j.kind === 'export') { const a = this.store.article(item.article_id!, item.content_version); const files = await this.exporter.item(j, a); abort(signal); j.checkpoint.files.push(...files); item.status = 'success'; }
            else await this.collect(j, item, signal);
            done = true; break;
          } catch (e) {
            abort(signal); const err = failure(e); item.error = err;
            if (err.code === 'AUTH_REQUIRED' || err.code === 'VERIFICATION_REQUIRED') { this.waiting(j, e, item); return; }
            if (err.retryable && attempt < this.store.cfg.retry.max_retries) {
              const wait = Math.max(1000 * 2 ** attempt, (err.retry_after_seconds ?? 0) * 1000); j.next_attempt_at = new Date(Date.now() + wait).toISOString(); tick();
              if (j.kind === 'collection' && wait >= j.config.max_duration_seconds * 1000 - j.elapsed_ms) { this.waiting(j, e, item); return; }
              j.state = 'backoff'; this.store.saveJob(j); await sleep(wait, signal); j.state = 'running'; j.next_attempt_at = undefined; continue;
            }
            if (['NETWORK_ERROR', 'RATE_LIMITED', 'SOURCE_UNAVAILABLE'].includes(err.code)) { this.waiting(j, e, item); return; }
            item.status = 'failed'; done = true; break;
          }
        }
        this.count(j); tick(); this.store.saveJob(j); if (!done) break;
      }
      if (j.state === 'running') {
        j.state = j.counts.failed_count || j.counts.partial_count ? 'completed_with_errors' : 'completed';
        if (!j.coverage.truncated) j.coverage.stop_reason = 'input_exhausted'; j.coverage.has_more = j.coverage.truncated ? null : false;
        if (j.kind === 'export') { j.result = await this.exporter.finish(j); if (!j.result.complete) j.state = 'completed_with_errors'; }
      }
    } catch (e) {
      if (['running', 'backoff'].includes(j.state)) {
        if (signal.aborted && !this.closed) { j.coverage.truncated = true; j.coverage.stop_reason = 'max_duration'; j.state = j.counts.failed_count || j.counts.partial_count ? 'completed_with_errors' : 'completed'; }
        else if (this.closed) j.state = 'interrupted';
        else if (j.kind === 'collection' && ['AUTH_REQUIRED','VERIFICATION_REQUIRED','SOURCE_UNAVAILABLE','NETWORK_ERROR','RATE_LIMITED'].includes(failure(e).code)) this.waiting(j, e);
        else { j.state = 'failed'; j.error = failure(e); }
      }
    } finally {
      clearTimeout(timer); tick(); this.count(j); if(!['waiting_source'].includes(j.state)) j.next_attempt_at = undefined;
      if (j.kind === 'export' && !['completed', 'completed_with_errors'].includes(j.state)) j.result = await this.exporter.manifest(j, false);
      this.store.saveJob(j);
    }
  }
  async close() { this.closed = true; for (const { job, controller } of this.active.values()) { if (!TERMINAL.includes(job.state) && !['paused', 'waiting_auth', 'waiting_verification', 'waiting_source'].includes(job.state)) { job.state = 'interrupted'; this.store.saveJob(job); } controller.abort(); } await Promise.allSettled([...this.tasks]); }
}
