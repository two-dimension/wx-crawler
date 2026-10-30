import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ARTICLE_SCRIPT, SEARCH_SCRIPT, worker } from '../src/browser/worker.js';
import { parseArticle } from '../src/parser/article.js';
import { URL1 } from './helpers.js';
test('browser snapshot derives identity from validated page declarations, not mutable global counters', () => {
  const node = { outerHTML: '<div id="js_content"><p data-idx="0">正文</p></div>',textContent:'正文',innerText:'正文',querySelectorAll:()=>[] };
  const document = {
    scripts: [{ textContent: 'var biz="TEST_BIZ"; var mid="12345"; var idx="1"; var ct="1793248200"; window.idx=0;' }],
    querySelector: () => node, querySelectorAll: () => [{ outerHTML: '<h1 id="activity-name">标题</h1><span id="js_name">账号</span>' }],
    body: { cloneNode: () => ({ querySelectorAll: () => [], textContent: '' }) }
  };
  const snapshot = vm.runInNewContext(ARTICLE_SCRIPT, { document, location: { href: URL1 }, window: { idx: 0 } });
  const article = parseArticle(snapshot.html, snapshot.url, 'opencli_browser'); assert.equal(article.idx, '1'); assert.equal(article.mid, '12345'); assert.equal(article.biz, 'TEST_BIZ');
});
test('fixed search extraction removes embedded timeConvert script text', () => {
  const el = { querySelector: (s: string) => s === 'h3 a' ? { textContent: '标题', href: 'https://mp.weixin.qq.com/s/test' } : s === '.s-p .s2' ? { textContent: "document.write(timeConvert('123'))2026-10-30" } : { textContent: '摘要' } };
  const result = vm.runInNewContext(SEARCH_SCRIPT, { document: { body: { innerText: '搜索结果' }, querySelectorAll: () => [el] }, location: { href: 'https://weixin.sogou.com/weixin' } });
  assert.equal(result.rows[0].publish_time, '2026-10-30');
});
test('article extraction finishes before worker cleanup closes its browser', async () => {
  let closed = false; let readFinished = false;
  const create = async () => ({ page: { goto:async()=>{},waitForTimeout:async()=>{},evaluate:async(js: string)=>{
    if(js==='location.href')return URL1;
    await new Promise(resolve=>setTimeout(resolve,10)); assert.equal(closed,false,'browser was closed while DOM extraction was pending'); readFinished=true;return{url:URL1,html:'<div id="js_content">正文</div>'};
  } },close:async()=>{closed=true;} });
  const result = await worker({action:'article',url:URL1},create as any); assert.equal(readFinished,true);assert.equal(closed,true);assert.match(result.html,/正文/);
});
