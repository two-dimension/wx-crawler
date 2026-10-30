// Opt-in live acceptance: uses the actual stdio server and public upstreams at low frequency.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { atomic, now } from '../src/shared/util.js';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/index.js';
import { inside } from '../src/shared/util.js';
const cfg = await loadConfig();
const client = new Client({ name: 'wechat-live-acceptance', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/server/index.js', import.meta.url))], env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string,string] => e[0].startsWith('WX_') && typeof e[1] === 'string')), stderr: 'pipe' });
const report: any = { checked_at: now(), client: '@modelcontextprotocol/sdk 1.32.2 StdioClientTransport', calls: [], ok: false };
const start = transport.start.bind(transport);
transport.start = async () => {
  const onmessage = transport.onmessage;
  transport.onmessage = (message: any, extra: any) => { if (message.result?.protocolVersion) report.protocol_version = message.result.protocolVersion; onmessage?.(message, extra); };
  await start();
};
async function call(name: string, args: any) {
  const result: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const data = result.structuredContent; report.calls.push({ tool: name, ok: data?.ok, error: data?.error, data: data?.data, coverage: data?.coverage });
  if (!data?.ok) throw Error(`${name}: ${data?.error?.code ?? 'invalid_response'}`); return data.data;
}
async function poll(jobId: string) { for (let n = 0; n < 300; n++) { const j = await call('wx_get_job', { job_id: jobId }); if (!['queued','running','backoff'].includes(j.state)) return j; await delay(200); } throw Error('job_timeout'); }
try {
  await client.connect(transport); report.tools = (await client.listTools()).tools.map(t => t.name);
  await call('wx_status', { check_sources: true });
  const search = await call('wx_search_articles', { query: '微信公开课', limit: 1 });
  if (!search.candidates.length) throw Error('no_live_candidates');
  const fetched = await call('wx_fetch_article', { candidate_id: search.candidates[0].candidate_id, refresh: true }); const a = fetched.article;
  const read = await call('wx_read_article', { article_id: a.article_id, format: 'blocks' });
  // Keep report small; the full article stays in the local archive.
  report.calls.at(-1).data = { article_id: read.article_id, content_version: read.content_version, block_count: read.blocks.length, has_more: read.has_more };
  await call('wx_search_library', { query: a.title.slice(0, 3) });
  const collection = await call('wx_start_collection', { input: { type: 'urls', urls: [a.canonical_url, a.canonical_url] } });
  const completed = await poll(collection.job_id); if (!['completed', 'completed_with_errors'].includes(completed.state) || completed.counts.accepted_count !== 1 || completed.counts.duplicate_count !== 1) throw Error('collection_count_mismatch');
  for (const format of ['markdown','jsonl','html']) { const job = await call('wx_export_articles', { article_ids: [a.article_id], format }); const done = await poll(job.job_id); if (done.state !== 'completed') throw Error('export_incomplete'); }
  await call('wx_status', {}); report.ok = true;
} catch (e) { report.error = e instanceof Error ? e.message : 'live_test_failed'; }
finally { await client.close(); const reportPath = inside(cfg.data_dir,'live-smoke-report.json'); await atomic(reportPath, JSON.stringify(report, null, 2)); process.stdout.write(JSON.stringify({ ok: report.ok, error: report.error, tool_calls: report.calls.length, report: reportPath }) + '\n'); }
if (!report.ok) process.exitCode = 1;
