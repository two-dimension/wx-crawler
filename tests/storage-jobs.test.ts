import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, setup, stub, URL1, waitJob } from './helpers.js';
import { collectionSchema } from '../src/tools/schema.js';
import { parseArticle } from '../src/parser/article.js';
import { WxError, sleep } from '../src/shared/util.js';
import { Store } from '../src/storage/index.js';
const config = (urls = [URL1], extra = {}) => collectionSchema.parse({ input: { type: 'urls', urls }, ...extra });
test('archive identities, versions, literal Chinese substring search and stale refresh', async () => {
  const app = await setup(); try {
    const html = await fixture(); stub(app, html);
    const [a, b] = await Promise.all([app.service.fetch(URL1, false, false), app.service.fetch(URL1, false, false)]);
    assert.equal(a.article.article_id, b.article.article_id); assert.equal(b.cache_hit, true);
    const alias = 'https://mp.weixin.qq.com/s/test-alias'; const c = await app.service.fetch(alias, true, false); assert.equal(c.article.article_id, a.article.article_id);
    const refreshed = parseArticle(html.replace('温度','气温'), URL1); await app.store.saveArticle(refreshed, [URL1]); assert.notEqual(refreshed.content_version, a.article.content_version); assert.match(app.store.article(a.article.article_id, a.article.content_version).markdown, /温度/);
    assert.equal(app.store.search('中文词组').length, 1); assert.equal(app.store.search("%' OR 1=1 --").length, 0);
    app.service.draft = async () => { throw new WxError('NETWORK_ERROR', '连接失败', true); };
    const stale = await app.service.fetch(URL1, true, false); assert.equal(stale.stale, true); assert.equal(stale.last_attempt?.error.code, 'NETWORK_ERROR'); assert.equal(stale.article.content_status, 'complete');
    await assert.rejects(new Store(app.store.cfg).init(), (e: any) => e.code === 'CONFLICT');
  } finally { await app.cleanup(); }
});
test('a conflicting identity cannot overwrite the prior database or article files', async () => {
  const app = await setup(); try {
    const html = await fixture(); const old = await app.store.saveArticle(parseArticle(html, URL1),[URL1]);
    const originalFile = await readFile(path.join(app.root,'articles',old.article_id,old.content_version,'content.json'),'utf8');
    const conflicting = parseArticle(html.replace('TEST_BIZ','ANOTHER_BIZ'),URL1); await assert.rejects(app.store.saveArticle(conflicting,[URL1]), (e: any) => e.code === 'IDENTITY_AMBIGUOUS');
    assert.equal(app.store.article(old.article_id).biz,old.biz); assert.equal(await readFile(path.join(app.root,'articles',old.article_id,old.content_version,'content.json'),'utf8'),originalFile);
  } finally { await app.cleanup(); }
});
test('collection deduplicates, filters before archive, enforces budgets and idempotency', async () => {
  const app = await setup(); try {
    stub(app, await fixture()); const c = config([URL1, URL1, 'https://mp.weixin.qq.com/s/alias']);
    const j = app.jobs.startCollection(c, 'same'); assert.equal(app.jobs.startCollection(c, 'same').job_id, j.job_id); assert.throws(() => app.jobs.startCollection(config([URL1], { max_articles: 1 }), 'same'), (e: any) => e.code === 'CONFLICT');
    const result = await waitJob(app, j.job_id); assert.equal(result.state, 'completed'); assert.equal(result.counts.success_count, 1); assert.equal(result.counts.duplicate_count, 2); assert.equal(result.counts.checked_count, 3);
    const filtered = app.jobs.startCollection(config(['https://mp.weixin.qq.com/s/filtered'], { account_name: '另一个账号' })); assert.equal((await waitJob(app, filtered.job_id)).counts.filtered_count, 1); assert.equal(app.store.cached('https://mp.weixin.qq.com/s/filtered'), null);
    const limited = app.jobs.startCollection(config([URL1, URL1], { max_articles: 1 })); const lr = await waitJob(app, limited.job_id); assert.equal(lr.coverage.stop_reason, 'max_articles'); assert.equal(lr.counts.checked_count, 1);
  } finally { await app.cleanup(); }
});
test('reposts from different accounts stay distinct; mixed-language and date/account filters are exact', async () => {
  const app = await setup(); try {
    const html = await fixture(); const first = await app.store.saveArticle(parseArticle(html, URL1), [URL1]); const secondUrl = 'https://mp.weixin.qq.com/s/repost';
    const second = await app.store.saveArticle(parseArticle(html.replace('TEST_BIZ','TEST_BIZ_TWO'), secondUrl), [secondUrl]); assert.notEqual(first.article_id, second.article_id); assert.equal(first.content_hash, second.content_hash);
    assert.equal(app.store.search('MCP 123').length, 2); assert.equal(app.store.search('MCP123').length, 0); assert.equal(app.store.search('中文', first.account_id!).length, 1);
    assert.equal(app.store.search('中文', undefined, first.published_at!, undefined).length, 2); assert.equal(app.store.search('中文', undefined, undefined, first.published_at!).length, 0);
  } finally { await app.cleanup(); }
});
test('partial content is separated, require_complete prevents archival and stale is not refresh success', async () => {
  const app = await setup(); try {
    stub(app, '<aside>付费后阅读</aside><div id="js_content"><p>试读正文</p></div>');
    const strict = app.jobs.startCollection(config([URL1], { require_complete: true })); assert.equal((await waitJob(app, strict.job_id)).counts.filtered_count, 1); assert.equal(app.store.cached(URL1), null);
    const relaxed = app.jobs.startCollection(config()); const r = await waitJob(app, relaxed.job_id); assert.equal(r.state, 'completed_with_errors'); assert.equal(r.counts.partial_count, 1); assert.equal(r.counts.success_count, 0);
    app.service.draft = async () => { throw new WxError('NETWORK_ERROR', '连接失败', true); }; const refresh = app.jobs.startCollection(config([URL1], { refresh: true })); const rr = await waitJob(app, refresh.job_id); assert.equal(rr.counts.stale_count, 1); assert.equal(rr.counts.success_count, 0); assert.equal(rr.counts.failed_count, 0); assert.equal(rr.state, 'waiting_source');
  } finally { await app.cleanup(); }
});
test('page budget is shared across queries; exact exhaustion and resumed pauses do not invent truncation', async () => {
  const app = await setup(); try {
    stub(app, await fixture()); const exact = app.jobs.startCollection(config([URL1], { max_articles: 1, max_discovered: 1 })); const ex = await waitJob(app, exact.job_id); assert.equal(ex.coverage.truncated, false); assert.equal(ex.coverage.stop_reason, 'input_exhausted');
    const p = app.jobs.startCollection(config()); await app.jobs.control(p.job_id, 'pause'); await app.jobs.control(p.job_id, 'resume'); const done = await waitJob(app, p.job_id); assert.equal(done.coverage.truncated, false);
    const queried: string[] = []; app.service.search = async query => { queried.push(query); return { candidates: [], coverage: { provider: 'opencli_sogou', mode: 'search_results', checked_count: 0, returned_count: 0, truncated: false, may_have_gaps: true, has_more: false, next_cursor: null, stop_reason: 'no_results' } }; };
    const j = app.jobs.startCollection(collectionSchema.parse({ input: { type: 'search', queries: ['one','two','three'] }, max_pages: 2 })); const limited = await waitJob(app, j.job_id); assert.deepEqual(queried, ['one','two']); assert.equal(limited.checkpoint.pages_read, 2); assert.equal(limited.coverage.stop_reason, 'max_pages');
  } finally { await app.cleanup(); }
});
test('refresh requiring verification keeps old content and a resumable checkpoint', async () => {
  const app = await setup(); try {
    stub(app, await fixture()); const old = await app.service.fetch(URL1, false, false);
    app.service.draft = async () => { throw new WxError('VERIFICATION_REQUIRED', '请验证'); }; const j = app.jobs.startCollection(config([URL1], { refresh: true })); const waiting = await waitJob(app, j.job_id);
    assert.equal(waiting.state, 'waiting_verification'); assert.equal(waiting.counts.stale_count, 1); assert.equal(waiting.counts.success_count, 0); assert.equal(app.store.article(old.article.article_id).content_version, old.article.content_version);
    stub(app, await fixture()); await app.jobs.control(j.job_id, 'resume'); const done = await waitJob(app, j.job_id); assert.equal(done.state, 'completed'); assert.equal(done.counts.stale_count, 0); assert.equal(done.counts.success_count, 1);
  } finally { await app.cleanup(); }
});
test('Retry-After exceeding automatic time budget waits resumably and cannot be resumed early', async () => {
  const app = await setup(); try {
    app.store.cfg.retry.max_retries=2; let calls=0;
    app.service.draft=async()=>{calls++;throw new WxError('RATE_LIMITED','限流',true,'等待冷却',60);};
    const j=app.jobs.startCollection(config([URL1],{max_duration_seconds:2})); const waiting=await waitJob(app,j.job_id);
    assert.equal(waiting.state,'waiting_source');assert.equal(calls,1);assert.ok(waiting.next_attempt_at);assert.ok(waiting.elapsed_ms<2000);await assert.rejects(app.jobs.control(j.job_id,'resume'),(e:any)=>e.code==='RATE_LIMITED');
  } finally {await app.cleanup();}
});
test('verification waiting, pause/cancel, and explicit resume preserve committed work', async () => {
  const app = await setup(); try {
    app.service.draft = async () => { throw new WxError('VERIFICATION_REQUIRED', '需要验证'); };
    const j = app.jobs.startCollection(config()); const waiting = await waitJob(app, j.job_id); assert.equal(waiting.state, 'waiting_verification'); assert.equal(waiting.items[0]?.attempts, 1);
    stub(app, await fixture()); await app.jobs.control(j.job_id, 'resume'); const done = await waitJob(app, j.job_id); assert.equal(done.counts.success_count, 1); await assert.rejects(app.jobs.control(j.job_id, 'resume'));
    const p = app.jobs.startCollection(config()); await app.jobs.control(p.job_id, 'pause'); assert.equal(app.store.job(p.job_id).state, 'paused'); await app.jobs.control(p.job_id, 'cancel'); assert.equal(app.store.job(p.job_id).state, 'cancelled');
  } finally { await app.cleanup(); }
});
test('search tasks persist discovery position and wait for verification without losing the page', async () => {
  const app = await setup(); try {
    let calls = 0; app.service.search = async () => { calls++; throw new WxError('VERIFICATION_REQUIRED', '搜索需要验证'); };
    const j = app.jobs.startCollection(collectionSchema.parse({ input: { type: 'search', queries: ['测试'] }, max_pages: 1 }));
    const waiting = await waitJob(app, j.job_id); assert.equal(waiting.state, 'waiting_verification'); assert.equal(waiting.checkpoint.page, 1); assert.equal(calls, 1);
    app.service.search = async () => ({ candidates: [{ candidate_id: 'c', discovered_url: URL1, title: '测试', summary: '', published_raw: '', metadata_verified: false, discovered_at: '', query: '测试', page: 1, provider: 'opencli_sogou' }], coverage: { provider: 'opencli_sogou', mode: 'search_results', checked_count: 1, returned_count: 1, truncated: false, may_have_gaps: true, has_more: null, next_cursor: null, stop_reason: 'page_limit' } });
    stub(app, await fixture()); await app.jobs.control(j.job_id, 'resume'); const done = await waitJob(app, j.job_id); assert.equal(done.counts.success_count, 1); assert.equal(done.coverage.truncated, true); assert.equal(done.coverage.stop_reason, 'max_pages');
  } finally { await app.cleanup(); }
});
test('shutdown checkpoints active tasks; reopen marks executable states interrupted', async () => {
  const app = await setup(); try {
    app.service.draft = async (_url, signal) => { await sleep(5000, signal); throw Error(); };
    const j = app.jobs.startCollection(config()); await sleep(30); await app.jobs.close(); assert.equal(app.store.job(j.job_id).state, 'interrupted');
    await app.store.close(); await app.store.init(); assert.equal(app.store.job(j.job_id).state, 'interrupted'); stub(app, await fixture());
  } finally { await app.cleanup(); }
});
test('media failures remain separate from body; retry downloads only missing assets', async () => {
  const app = await setup(); try {
    stub(app, await fixture()); const a = await app.service.fetch(URL1, false, false);
    let bodyRequests = 0; app.service.draft = async () => { bodyRequests++; throw Error('body must stay cached'); };
    let mediaRequests = 0; app.service.http.get = async () => { mediaRequests++; throw new WxError('NETWORK_ERROR', '图片连接失败', true); };
    const failed = await app.service.fetch(URL1, false, true); assert.equal(failed.article.content_status, 'complete'); assert.equal(failed.article.media_status, 'failed'); assert.equal(bodyRequests, 0);
    app.service.http.get = async () => { mediaRequests++; return { body: Buffer.from('test-bitmap'), url: 'https://mmbiz.qpic.cn/test.png', type: 'image/png' }; };
    const complete = await app.service.fetch(URL1, false, true); assert.equal(complete.article.media_status, 'complete'); assert.equal(complete.article.content_version, a.article.content_version); assert.equal(mediaRequests, 2);
    await app.service.fetch(URL1, false, true); assert.equal(mediaRequests, 2);
  } finally { await app.cleanup(); }
});
test('all export formats pin versions, produce safe paths and parseable manifests', async () => {
  const app = await setup(); try {
    stub(app, await fixture()); const a = (await app.service.fetch(URL1, false, false)).article;
    for (const format of ['markdown','jsonl','html']) {
      const j = app.jobs.startExport({ article_ids: [a.article_id], format, include_media: false }, format); const done = await waitJob(app, j.job_id); assert.equal(done.state, 'completed'); assert.equal(done.result?.complete, true);
      const manifest = JSON.parse(await readFile(done.result!.manifest_path, 'utf8')); assert.equal(manifest.articles[0].content_version, a.content_version); assert.ok(manifest.files.length);
      const root = path.dirname(done.result!.manifest_path); for (const file of manifest.files) assert.ok(!file.includes('..'));
      if (format === 'html') { const html = await readFile(path.join(root, manifest.files[0]), 'utf8'); assert.ok(!html.includes('<script')); }
      if (format === 'jsonl') { const data = JSON.parse((await readFile(path.join(root, 'articles.jsonl'), 'utf8')).trim()); assert.equal(data.article_id, a.article_id); }
      assert.equal(app.jobs.startExport({ article_ids: [a.article_id], format, include_media: false }, format).job_id, j.job_id);
    }
  } finally { await app.cleanup(); }
});
test('missing exported media is reported without claiming a complete artifact', async () => {
  const app = await setup(); try {
    const draft = parseArticle(await fixture(), URL1); draft.assets[0]!.status = 'complete'; draft.assets[0]!.local_path = 'assets/missing.png'; draft.media_status = 'complete'; const a = await app.store.saveArticle(draft, [URL1]);
    const j = app.jobs.startExport({ article_ids: [a.article_id], format: 'jsonl', include_media: true }); const done = await waitJob(app, j.job_id);
    assert.equal(done.state, 'completed_with_errors'); assert.equal(done.result?.complete, false); assert.equal(done.result?.media_failures.length, 1);
    const manifest = JSON.parse(await readFile(done.result!.manifest_path, 'utf8')); const exported = JSON.parse((await readFile(path.join(path.dirname(done.result!.manifest_path), 'articles.jsonl'), 'utf8')).trim());
    assert.equal(manifest.complete, false); assert.equal(exported.assets[0].local_path, undefined);
  } finally { await app.cleanup(); }
});
