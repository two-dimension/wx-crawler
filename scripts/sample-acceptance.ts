// Automated DOM cross-check. It does NOT replace the plan's human-confirmed 20-article acceptance.
import { createApp } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';
import { atomic, failure, now, WxError, inside } from '../src/shared/util.js';
import { readFile } from 'node:fs/promises';
const cfg=await loadConfig();
const supplement = process.argv.includes('--supplement');
const queryIndex=process.argv.indexOf('--queries');
const customQueries:string[]|undefined=queryIndex>=0?JSON.parse(process.argv[queryIndex+1]!):undefined;
if(customQueries&&(!Array.isArray(customQueries)||customQueries.length<1||customQueries.length>5||customQueries.some(q=>typeof q!=='string'||!q.trim()||q.length>300)))throw Error('--queries 需要 1–5 个非空关键词的 JSON 数组');
const edgeCases = process.argv.includes('--edge-cases') || Boolean(customQueries);
const report: any = supplement || edgeCases ? JSON.parse(await readFile(inside(cfg.data_dir,'sample-acceptance-report.json'), 'utf8')) : { started_at: now(), human_reviewed: false, target: 20, samples: [], queries: [] };
const app=await createApp(cfg);
if (supplement) report.supplement_started_at = now();
const normal = (s: string) => s.replace(/\s+/g, '').replace(/[，。！？：；、“”‘’·|.,!?:;"'\-—]/g, '');
try {
  for (const query of customQueries ?? (edgeCases ? ['Python 代码 示例', '数据 表格 汇总', '纯图 壁纸'] : supplement ? ['科技 新闻', '工信部 政策', '软件 教程'] : ['科学 科普', '产业 分析', '政策 解读', 'Python 教程', '产品 发布'])) {
    if (!edgeCases && (supplement ? report.samples.filter((s: any) => s.ok).length >= 20 : report.samples.length >= 20)) break;
    let candidates: any[];
    try { const r = await app.service.search(query, 1, edgeCases ? 2 : 4); candidates = r.candidates; report.queries.push({ query, ok: true, returned_count: candidates.length }); }
    catch (e) { report.queries.push({ query, ok: false, error: failure(e) }); if (['AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED'].includes(failure(e).code)) break; continue; }
    for (const c of candidates) {
      if (!edgeCases && supplement && report.samples.filter((s: any) => s.ok).length >= 20) break;
      const sample: any = { query, discovered_at: c.discovered_at, candidate_title: c.title };
      try {
        const result = await app.service.fetch(c.discovered_url, true, false); const a = result.article;
        // Independent rendered DOM view after safe final URL validation, serialized with all source operations.
        const snapshot = await app.service.browser.run('article', { url: a.canonical_url });
        const visible: any = snapshot.visible;
        const referenceText = normal(visible.text); const extracted = normal(a.text); const included = referenceText ? [...referenceText].filter(ch => extracted.includes(ch)).length / referenceText.length : null;
        Object.assign(sample, { ok: true, article_id: a.article_id, canonical_url: a.canonical_url, title: a.title, account_name: a.account_name, published_at: a.published_at, mid: a.mid, idx: a.idx, content_status: a.content_status, block_count: a.blocks.length, block_types:[...new Set(a.blocks.map(b=>b.type))], external_link_count:a.external_links.length, metadata_reasons:a.metadata_reasons, warnings: a.warnings, method: a.method, browser_backend:app.service.cfg.browser.backend, dom_title_matches: normal(visible.title || '') === normal(a.title || ''), dom_account_matches: visible.account === a.account_name, visible_text_chars: referenceText.length, extracted_text_chars: extracted.length, character_presence_ratio: included });
      } catch (e) { Object.assign(sample, { ok: false, error: failure(e) }); }
      report.samples.push(sample); await atomic(inside(app.store.cfg.data_dir,'sample-acceptance-report.json'), JSON.stringify(report, null, 2));
      process.stdout.write(JSON.stringify({ sample: report.samples.length, query, ok: sample.ok, title: sample.title, error: sample.error?.code, title_match: sample.dom_title_matches, account_match: sample.dom_account_matches }) + '\n');
      if (sample.error && ['AUTH_REQUIRED','VERIFICATION_REQUIRED','RATE_LIMITED'].includes(sample.error.code)) break;
    }
  }
  const first = report.samples.find((s: any) => s.ok);
  if (first) {
    const original = app.service.http.get;
    try {
      app.service.http.get = async () => { throw new WxError('NETWORK_ERROR', '验收注入的 HTTP 失败，用于独立验证真实浏览器兜底'); };
      const r = await app.service.draft(first.canonical_url);
      report.browser_fallback = { ok: true, http_failure_injected: true, method: r.draft.method, title: r.draft.title, title_matches_http: r.draft.title === first.title, mid: r.draft.mid, idx: r.draft.idx, blocks: r.draft.blocks.length };
    } catch (e) { report.browser_fallback = { ok: false, http_failure_injected: true, error: failure(e) }; }
    finally { app.service.http.get = original; }
  }
} finally { report.finished_at = now(); report.environment = await app.service.status(); await atomic(inside(app.store.cfg.data_dir,'sample-acceptance-report.json'), JSON.stringify(report, null, 2)); await app.close(); }
