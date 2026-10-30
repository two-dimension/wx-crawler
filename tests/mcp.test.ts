import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, setup, stub, URL1 } from './helpers.js';
import { parseArticle } from '../src/parser/article.js';
import { fileURLToPath } from 'node:url';
import { sleep } from '../src/shared/util.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
test('SDK initializes, lists 9 tool schemas, validates business errors, reads every long-block fragment', async () => {
  const app = await setup(); const client = new Client({ name: 'contract-test', version: '1' });
  try {
    const [a,b] = InMemoryTransport.createLinkedPair(); await app.server.connect(a); await client.connect(b);
    const list = await client.listTools(); assert.equal(list.tools.length, 9); for (const tool of list.tools) { assert.ok(tool.outputSchema); assert.equal(tool.inputSchema.type, 'object'); }
    const status: any = await client.callTool({ name: 'wx_status', arguments: {} }); assert.equal(status.structuredContent.ok, true, JSON.stringify(status));
    const invalid: any = await client.callTool({ name: 'wx_fetch_article', arguments: { url: 'https://localhost/test' } }); assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error.code, 'INVALID_INPUT');
    stub(app, await fixture()); const fetch: any = await client.callTool({ name: 'wx_fetch_article', arguments: { url: URL1 } }); assert.equal(fetch.structuredContent.ok, true, JSON.stringify(fetch));
    const article = parseArticle(`<h1 id="activity-name">长文</h1><div id="js_content"><p>${'中文ABC'.repeat(900)}</p><p>结尾</p></div>`, 'https://mp.weixin.qq.com/s/long'); await app.store.saveArticle(article, [article.canonical_url]);
    let cursor: string | undefined; let content = ''; let count = 0;
    do { const result: any = await client.callTool({ name: 'wx_read_article', arguments: { article_id: article.article_id, max_chars: 256, format: 'markdown', ...(cursor ? { cursor } : {}) } }); assert.equal(result.structuredContent.ok, true, JSON.stringify(result)); const data = result.structuredContent.data; assert.ok(data.content.length <= 256); content += data.content; cursor = data.next_cursor; count++; assert.ok(count < 30); } while (cursor);
    assert.equal(content.replaceAll('\n\n',''), article.markdown.replaceAll('\n\n','')); assert.ok(count > 1);
    const search: any = await client.callTool({ name: 'wx_search_library', arguments: { query: '中文词组' } }); assert.equal(search.structuredContent.data.search_mode, 'substring'); assert.equal(search.structuredContent.data.articles.length, 1);
    const missing: any = await client.callTool({ name: 'wx_get_job', arguments: { job_id: 'job_0000000000000000' } }); assert.equal(missing.isError, true); assert.equal(missing.structuredContent.error.code, 'RESOURCE_NOT_FOUND');
  } finally { await client.close(); await app.server.close(); await app.cleanup(); }
});
test('MCP cancellation propagates to an in-flight fetch and prevents archival', async () => {
  const app = await setup(); const client = new Client({ name: 'cancel-test', version: '1' });
  try {
    const [a,b] = InMemoryTransport.createLinkedPair(); await app.server.connect(a); await client.connect(b);
    let cancelled = false;
    app.service.draft = async (_url, signal) => { try { await sleep(5000, signal); } catch { cancelled = signal?.aborted ?? false; throw new DOMException('cancelled', 'AbortError'); } throw Error('unexpected'); };
    const controller = new AbortController(); const request = client.callTool({ name: 'wx_fetch_article', arguments: { url: URL1 } }, undefined, { signal: controller.signal });
    await sleep(30); controller.abort(); await assert.rejects(request); await sleep(30); assert.equal(cancelled, true); assert.equal(app.store.cached(URL1), null);
  } finally { await client.close(); await app.server.close(); await app.cleanup(); }
});
test('service shutdown aborts an in-flight HTTP fetch before closing the database',async()=>{
  const app=await setup();let cancelled=false;
  try{
    app.service.http.get=async(_url,_kind,signal)=>{try{await sleep(5000,signal);}catch(e){cancelled=signal?.aborted??false;throw e;}throw Error('unexpected');};
    const request=app.service.fetch(URL1,true,false);void request.catch(()=>{});await sleep(25);await app.close();await assert.rejects(request);assert.equal(cancelled,true);assert.equal(existsSync(path.join(app.root,'.writer.lock')),false);
  }finally{await app.cleanup();}
});
test('real stdio child negotiates protocol and stdout contains only MCP messages', async () => {
  const app = await setup(); await app.close();
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/server/index.js', import.meta.url))], env: { ...Object.fromEntries(Object.entries(process.env).filter((v): v is [string,string] => typeof v[1] === 'string')), WX_DATA_DIR: app.root }, stderr: 'pipe' });
  try { await client.connect(transport); const result = await client.listTools(); assert.equal(result.tools.length, 9); const status: any = await client.callTool({ name: 'wx_status', arguments: {} }); assert.equal(status.structuredContent.ok, true); assert.ok(transport.pid); }
  finally { await client.close(); assert.equal(existsSync(path.join(app.root, '.writer.lock')), false, 'stdio shutdown must release the instance lock'); await app.cleanup(); }
});
