import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedBrowserURL, managedContext, pinnedDNS } from '../src/browser/managed.js';
import { BrowserSource } from '../src/providers/browser.js';
import { loadConfig } from '../src/config/index.js';
import { sleep, WxError } from '../src/shared/util.js';

test('browser network policy rejects arbitrary schemes, hosts, ports and private DNS before launch', async () => {
  for (const url of ['file:///secret','https://mp.weixin.qq.com.evil/s/a','https://127.0.0.1/a','http://169.254.169.254/','https://mp.weixin.qq.com:123/s/a','https://user:pass@mp.weixin.qq.com/s/a','bad']) assert.equal(allowedBrowserURL(url), false, url);
  await assert.rejects(pinnedDNS(async () => [{ address: '10.0.0.1', family: 4 }]), (e: any) => e.code === 'INVALID_INPUT');
  const pin = await pinnedDNS(async () => [{ address: '93.184.215.14', family: 4 }]); assert.match(pin.rules, /MAP mp.weixin.qq.com 93.184.215.14/); assert.ok(pin.rules.endsWith('MAP * ~NOTFOUND'));
});
test('cancelling a live worker closes Chrome and immediately releases its profile for reuse', {skip:process.env.WX_BROWSER_TESTS!=='1'},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'微信浏览器取消-'));const cfg=await loadConfig();cfg.data_dir=root;cfg.browser.session='cancel-test';cfg.browser.headless=true;cfg.request.interval_ms=0;cfg.request.browser_timeout_seconds=20;
  const source=new BrowserSource(cfg);(source as any).workerUrl=new URL('./fixtures/hold-worker.ts',import.meta.url);const controller=new AbortController();
  const task=source.run('article',{url:'https://mp.weixin.qq.com/s/test-one'},controller.signal);void task.catch(()=>{});
  try{
    for(let n=0;n<600&&!existsSync(path.join(root,'ready.json'));n++)await sleep(25);
    assert.ok(existsSync(path.join(root,'ready.json')),'native worker did not reach the live Chrome checkpoint');
    controller.abort(new WxError('CANCELLED','测试取消'));await assert.rejects(task,(e:any)=>e.code==='CANCELLED');
    const reopened=await managedContext({data_dir:root,session:'cancel-test',headless:true,channel:'chrome',timeout_seconds:15},{dns:async()=>[{address:'93.184.215.14',family:4}]});await reopened.close();
  }finally{await source.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});
test('real Chrome blocks direct requests, redirects, subresources and websockets before any loopback connection', { skip: process.env.WX_BROWSER_TESTS !== '1' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), '微信浏览器拦截-')); let connections = 0;
  const trap = createServer((_req,res) => { connections++; res.end('unexpected'); }); trap.on('upgrade', (_req,socket) => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => trap.listen(0, '127.0.0.1', resolve)); const address = trap.address(); assert.ok(address && typeof address === 'object'); const local = `http://127.0.0.1:${address.port}`;
  const response = (text: string) => ({ responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }], body: Buffer.from(text).toString('base64') });
  const browser = await managedContext({ data_dir: root, session: 'test', headless: true, channel: 'chrome', timeout_seconds: 15 }, {
    dns: async () => [{ address: '93.184.215.14', family: 4 }],
    respond: url => {
      if (url.endsWith('/s/redirect')) return { responseCode: 302, responseHeaders: [{ name: 'location', value: local + '/redirected' }], body: '' };
      if (url.endsWith('/s/resources')) return response(`<div>guard fixture</div><img src="${local}/image"><iframe src="${local}/frame"></iframe><script>fetch('${local}/fetch').catch(()=>{});new WebSocket('${local.replace('http:', 'ws:')}/socket');window.open('${local}/popup');</script>`);
      return response('<div>safe fixture</div>');
    }
  });
  try {
    await assert.rejects(browser.page.goto(local + '/direct'));
    await new Promise(resolve => setTimeout(resolve, 100));
    // An HTTP redirect must be intercepted even if the URL was allowed on the preceding hop.
    const redirectPage = await browser.context.newPage(); await redirectPage.waitForTimeout(50);
    await assert.rejects(redirectPage.goto('https://mp.weixin.qq.com/s/redirect'));
    const page = await browser.context.newPage(); await page.waitForTimeout(50);
    await page.goto('https://mp.weixin.qq.com/s/resources', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(500);
    assert.equal(connections, 0); assert.ok(browser.audit.blocked_count >= 2, JSON.stringify(browser.audit));
  } finally { await browser.close(); await new Promise<void>(resolve => trap.close(() => resolve())); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); }
});
