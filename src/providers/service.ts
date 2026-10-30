import { BrowserSource } from './browser.js';
import { PublicHttp } from './http.js';
import { parseArticle } from '../parser/article.js';
import { Store } from '../storage/index.js';
import type { Config } from '../config/index.js';
import { articleUrl, discoveryUrl } from '../resolver/url.js';
import { abort, atomic, failure, hash, id, inside, now, Serial, WxError } from '../shared/util.js';
import { readFile, stat } from 'node:fs/promises';
import type { Article, Candidate, Coverage, Draft, FetchResult } from '../shared/model.js';

export class ArticleService {
  http: PublicHttp; browser: BrowserSource; private serial = new Serial();
  private shutdown=new AbortController();
  private signal(signal?:AbortSignal){return signal?AbortSignal.any([signal,this.shutdown.signal]):this.shutdown.signal;}
  async close(){this.shutdown.abort(new WxError('CANCELLED','服务正在停止'));await this.browser.close();await this.serial.run(async()=>{});}
  private states: Record<string, any> = {}; private circuit: Record<string, { failures: number; until: number }> = {};
  private browserDiagnostics: Record<string, unknown> | null = null;
  constructor(public store: Store, public cfg: Config) { this.http = new PublicHttp(cfg); this.browser = new BrowserSource(cfg); }
  private mark(source: string, err?: unknown) {
    const error = err ? failure(err) : undefined; const c = this.circuit[source] ??= { failures: 0, until: 0 };
    if (error) { c.failures++; if (c.failures >= 3) c.until = Date.now() + 60000; } else { c.failures = 0; c.until = 0; }
    this.states[source] = { status: !error ? 'available' : error.code === 'AUTH_REQUIRED' ? 'needs_auth' : 'temporarily_unavailable', checked_at: now(), reason: error?.message ?? '最近真实请求通过', required_action: error?.required_action, circuit_until: c.until ? new Date(c.until).toISOString() : null };
  }
  private check(source: string) { if ((this.circuit[source]?.until ?? 0) > Date.now()) throw new WxError('SOURCE_UNAVAILABLE', '来源已暂时熔断', true, '等待一分钟后重试'); }
  async status(check = false, signal?: AbortSignal) {
    signal=this.signal(signal);
    if (check && this.cfg.browser.enabled) { try { this.browserDiagnostics = await this.browser.run('status', {}, signal); this.mark('browser_connection'); } catch (e) { this.mark('browser_connection', e); } }
    const unverified = { status: 'unverified', checked_at: null, reason: '尚未通过真实请求验证' };
    const unsupported = { status: 'unsupported', checked_at: null, reason: '未配置经过验证的账号历史来源' };
    const usable = this.cfg.browser.enabled && this.cfg.browser.backend === 'managed_chrome';
    const browserUnsupported = { ...unsupported, reason: !this.cfg.browser.enabled ? '浏览器已禁用' : 'OpenCLI Bridge 缺少网络拦截，仅提供连接诊断；请使用 managed_chrome' };
    return { version: '0.1.0', node: process.version, transport: 'stdio', storage: { data_dir: this.cfg.data_dir, export_dir: this.cfg.export_dir, writable: true, sqlite: 'node:sqlite', migration: 1 }, browser: { enabled: this.cfg.browser.enabled, session: this.cfg.browser.session, ...(await this.browser.fingerprint()), connection: this.states.browser_connection ?? unverified, diagnostics: this.browserDiagnostics }, sources: [
      { provider: 'public_http', capabilities: { fetch_article: this.states.public_http ?? unverified, discover_articles: unsupported, resolve_account: unsupported, fetch_latest: unsupported, list_history: unsupported, incremental_sync: unsupported } },
      { provider: 'opencli_sogou', browser_backend: this.cfg.browser.backend, capabilities: { discover_articles: usable ? this.states.opencli_sogou ?? unverified : browserUnsupported, fetch_article: unsupported, resolve_account: unsupported, fetch_latest: unsupported, list_history: unsupported, incremental_sync: unsupported } },
      { provider: 'opencli_browser', browser_backend: this.cfg.browser.backend, capabilities: { fetch_article: usable ? this.states.opencli_browser ?? unverified : browserUnsupported, resolve_account: unsupported, discover_articles: unsupported, fetch_latest: unsupported, list_history: unsupported, incremental_sync: unsupported } }
    ] };
  }
  async search(query: string, page: number, limit: number, signal?: AbortSignal): Promise<{ candidates: Candidate[]; coverage: Coverage }> {
    signal=this.signal(signal);abort(signal);
    this.check('opencli_sogou');
    try {
      const rows = await this.browser.run('search', { query, page, limit }, signal); abort(signal);
      const candidates: Candidate[] = rows.map((r: any) => ({ candidate_id: id('cand'), title: r.title, discovered_url: discoveryUrl(r.url), summary: r.summary, published_raw: r.publish_time, metadata_verified: false, discovered_at: now(), query, page, provider: 'opencli_sogou', browser_backend: this.cfg.browser.backend }));
      candidates.forEach(c => this.store.saveCandidate(c)); this.mark('opencli_sogou');
      return { candidates, coverage: { provider: 'opencli_sogou', mode: 'search_results', checked_count: candidates.length, returned_count: candidates.length, truncated: candidates.length === limit, may_have_gaps: true, has_more: candidates.length ? null : false, next_cursor: null, stop_reason: candidates.length ? 'page_limit' : 'no_results' } };
    } catch (e) { this.mark('opencli_sogou', e); throw e; }
  }
  async resolve(raw: string, signal?: AbortSignal) { signal=this.signal(signal);abort(signal);const url = discoveryUrl(raw); if (new URL(url).hostname === 'mp.weixin.qq.com') return articleUrl(url); const result = await this.browser.run('resolve', { url }, signal);abort(signal);return articleUrl(result.url); }
  async draft(raw: string, signal?: AbortSignal): Promise<{ draft: Draft; aliases: string[]; fallback_reason?: string }> {
    signal=this.signal(signal);abort(signal);
    const url = await this.resolve(raw, signal); abort(signal);
    let reason: string | undefined;
    try { this.check('public_http'); const response = await this.http.get(url, 'article', signal); const draft = parseArticle(response.body.toString('utf8'), response.url); draft.discovered_url = raw; this.mark('public_http'); return { draft, aliases: [raw, url, response.url] }; }
    catch (e) {
      abort(signal); const err = failure(e); this.mark('public_http', e);
      // Permission, payment and verification gates never trigger an automatic alternate path.
      if (!this.cfg.browser.enabled || !['NETWORK_ERROR', 'PARSE_FAILED', 'SOURCE_UNAVAILABLE'].includes(err.code)) throw e;
      reason = err.code;
    }
    this.check('opencli_browser');
    try { const data = await this.browser.run('article', { url }, signal); abort(signal); const draft = parseArticle(data.html, data.url, this.cfg.browser.backend); draft.discovered_url = raw; draft.warnings.push(`http_fallback:${reason}`); this.mark('opencli_browser'); return { draft, aliases: [raw, url, data.url], fallback_reason: reason }; }
    catch (e) { this.mark('opencli_browser', e); throw e; }
  }
  async download(draft: Draft, budget: { bytes: number }, signal?: AbortSignal) {
    signal=this.signal(signal);abort(signal);
    for (const asset of draft.assets) {
      abort(signal);
      try {
        if (asset.status === 'complete' && asset.local_path) { try { await stat(inside(this.cfg.data_dir, asset.local_path)); continue; } catch { asset.status = 'failed'; } }
        if (budget.bytes >= this.cfg.media.max_total_bytes_per_job) throw new WxError('SOURCE_UNAVAILABLE', '媒体总量达到任务上限');
        const transfer = { bytes:budget.bytes,max_bytes:this.cfg.media.max_total_bytes_per_job };
        let r: Awaited<ReturnType<PublicHttp['get']>>;
        try { r = await this.http.get(asset.url, 'media', signal, transfer); } finally { budget.bytes = transfer.bytes; }
        const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' } as Record<string, string>)[r.type.split(';')[0]!.toLowerCase()] || 'img';
        const digest = hash(r.body); asset.local_path = `assets/${digest}.${ext}`; await atomic(inside(this.cfg.data_dir, asset.local_path), r.body); asset.status = 'complete'; asset.bytes = r.body.length;
        this.store.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?)').run(digest, asset.local_path, r.body.length);
      } catch (e) { abort(signal); asset.status = 'failed'; asset.error = failure(e).message; }
    }
    const success = draft.assets.filter(a => a.status === 'complete').length;
    draft.media_status = !draft.assets.length || success === draft.assets.length ? 'complete' : success ? 'partial' : 'failed';
    if (success !== draft.assets.length) draft.warnings.push('media_download_incomplete');
  }
  fetch(raw: string, refresh: boolean, images: boolean, signal?: AbortSignal): Promise<FetchResult> {
    signal=this.signal(signal);
    // Serialize cache recheck and commit to prevent duplicate writes through aliases.
    return this.serial.run(async () => {
      abort(signal); const input = discoveryUrl(raw); const old = this.store.cached(input);
      if (old && !refresh && (!images || old.media_status === 'complete')) return { article: old, cache_hit: true, stale: false };
      if (old && !refresh && images) {
        const draft = { ...structuredClone(old), snapshot: await readFile(inside(this.cfg.data_dir, 'articles', old.article_id, old.content_version, 'snapshot.html'), 'utf8') };
        await this.download(draft, { bytes: 0 }, signal); abort(signal); const article = await this.store.saveArticle(draft, [input]);
        return { article, cache_hit: true, stale: false };
      }
      try { const result = await this.draft(input, signal); if (images) await this.download(result.draft, { bytes: 0 }, signal); abort(signal); const article = await this.store.saveArticle(result.draft, result.aliases); return { article, cache_hit: false, stale: false, fallback_reason: result.fallback_reason }; }
      catch (e) { abort(signal); const err = failure(e); this.store.recordFailure(input, err); if (!old) throw e; this.store.attempt(old.article_id, err); return { article: old, cache_hit: true, stale: true, last_attempt: this.store.lastAttempt(old.article_id) }; }
    });
  }
  summary(a: Article) { const { blocks, markdown, text, external_links, assets, ...metadata } = a; return { ...metadata, block_count: blocks.length, image_count: assets.length, external_link_count: external_links.length }; }
}
