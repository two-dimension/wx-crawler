import { createApp } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';
import { atomic, failure, now, WxError, inside } from '../src/shared/util.js';
const app = await createApp(await loadConfig());
const report: any = { checked_at: now(), http_failure_injected: true };
try {
  const article: any = app.store.db.prepare('SELECT json FROM articles ORDER BY fetched_at DESC LIMIT 1').get();
  if (!article) throw Error('先运行真实采集'); const a = JSON.parse(article.json);
  app.service.http.get = async () => { throw new WxError('NETWORK_ERROR', '验收注入的 HTTP 连接失败'); };
  const r = await app.service.draft(a.canonical_url);
  Object.assign(report, { ok: true, title: r.draft.title, account_name: r.draft.account_name, mid: r.draft.mid, idx: r.draft.idx, title_matches_http: r.draft.title === a.title, account_matches_http: r.draft.account_name === a.account_name, identity_matches_http: r.draft.biz === a.biz && r.draft.mid === a.mid && r.draft.idx === a.idx, method: r.draft.method, block_count: r.draft.blocks.length, fallback_reason: r.fallback_reason });
} catch (e) { Object.assign(report, { ok: false, error: failure(e) }); }
finally { await atomic(inside(app.store.cfg.data_dir,'browser-smoke-report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report) + '\n'); await app.close(); }
if (!report.ok) process.exitCode = 1;
