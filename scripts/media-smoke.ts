import { createApp } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';
import { atomic, now, failure, inside } from '../src/shared/util.js';
const cfg = await loadConfig(); cfg.request.timeout_seconds = 15;
const app = await createApp(cfg); const report: any = { checked_at: now(), scope: 'one_referenced_image_download', archive_modified: false };
try {
  const rows = app.store.db.prepare('SELECT json FROM articles ORDER BY fetched_at DESC').all();
  const article = rows.map(r => JSON.parse(r.json as string)).find(a => a.assets.length);
  if (!article) throw Error('需要先采集含图片的文章');
  const draft = { ...article, snapshot: '', assets: [{ ...article.assets[0], status: 'skipped' }] };
  const budget = { bytes: 0 }; await app.service.download(draft, budget);
  Object.assign(report, { ok: draft.assets[0].status === 'complete', article_id: article.article_id, asset: draft.assets[0], downloaded_bytes: budget.bytes });
} catch (e) { Object.assign(report, { ok: false, error: failure(e) }); }
finally { await atomic(inside(cfg.data_dir,'media-smoke-report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report) + '\n'); await app.close(); }
if (!report.ok) process.exitCode = 1;
