import { loadConfig } from '../src/config/index.js';
import { createApp } from '../src/server/index.js';
import { atomic, failure, now, inside } from '../src/shared/util.js';
const app = await createApp(await loadConfig());
const report: any = { checked_at: now(), environment: await app.service.status(true), observations: [] };
try {
  const i = process.argv.indexOf('--url');
  if (i >= 0) {
    const result = await app.service.fetch(process.argv[i + 1]!, true, false); report.observations.push({ step: 'url_fetch', ok: true, ...app.service.summary(result.article) });
  } else {
    const q = process.argv.indexOf('--query'); const query = q >= 0 ? process.argv[q + 1]! : '微信公众号 科普 教程';
    const search = await app.service.search(query, 1, 3); report.observations.push({ step: 'search', query, ok: true, ...search });
    for (const c of search.candidates.slice(0, 1)) { try { const result = await app.service.fetch(c.discovered_url, true, false); report.observations.push({ step: 'resolve_and_fetch', ok: true, ...app.service.summary(result.article) }); } catch (e) { report.observations.push({ step: 'resolve_and_fetch', ok: false, error: failure(e) }); } }
  }
} catch (e) { report.observations.push({ step: 'probe', ok: false, error: failure(e) }); }
finally { await atomic(inside(app.store.cfg.data_dir,'probe-report.json'), JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify(report, null, 2) + '\n'); await app.close(); }
if (report.observations.some((o: any) => !o.ok)) process.exitCode = 1;
