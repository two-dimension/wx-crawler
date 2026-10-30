// Isolated worker: fixed operations only. No user supplied JavaScript, shell or adapter loading.
import { Page } from '@jackwener/opencli/browser/page';
import { articleUrl, discoveryUrl } from '../resolver/url.js';
import { failure, WxError, abort } from '../shared/util.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedContext } from './managed.js';
import { controlledWorker } from './cancellation.js';
export const SEARCH_SCRIPT = `(() => {
 const text = document.body?.innerText || '';
 const blocked = /验证码|安全验证|异常访问|访问过于频繁/.test(text);
 const cards = [...document.querySelectorAll('.news-list li')];
 const clean = text => (text || '').replace(/document\\.write\\(timeConvert\\('[0-9]+'\\)\\)/g, '').replace(/\\s+/g,' ').trim();
 const rows = cards.map(el => { const a = el.querySelector('h3 a'); return {title:clean(a?.textContent),url:a?.href || '',summary:clean(el.querySelector('.txt-info')?.textContent),publish_time:clean(el.querySelector('.s-p .s2')?.textContent)}; });
 return {url:location.href,blocked,empty:/没有找到相关|暂无相关|未找到相关/.test(text),rows,invalid:rows.some(r=>!r.title||!r.url)};
})()`;
export const ARTICLE_SCRIPT = String.raw`(() => {
 const content = document.querySelector('#js_content');
 const metas = [...document.querySelectorAll('#activity-name,#js_text_title,#js_name,#publish_time,#js_author_name,.rich_media_title,.rich_media_meta_text,.rich_media_meta_nickname,meta[property="og:title"],meta[name="description"]')].map(e=>e.outerHTML).join('');
 const scripts = [...document.scripts].map(e=>e.textContent || '').join('\n');
 const found = {};
 for (const m of scripts.matchAll(/(?:var|let|const)\s+(biz|__biz|appmsgid|mid|idx|sn|ct|create_time)\s*[:=]\s*(?:JsDecode\()?['"]([^'"<>]+)['"]/g)) {
   const k=m[1],v=m[2]; const valid=k.includes('biz')?/^[a-zA-Z0-9+/_=-]{8,256}$/.test(v):k==='sn'?/^[a-fA-F0-9]{16,128}$/.test(v):/^[0-9]{1,16}$/.test(v);
   if(valid && found[k] === undefined) found[k]=v;
 }
 const values = Object.entries(found).map(([k,v])=>k+'="'+v+'";').join('');
 const shell = document.body?.cloneNode(true); shell?.querySelectorAll('#js_content,script,style,form,input').forEach(e=>e.remove());
 const first=selectors=>selectors.map(s=>document.querySelector(s)?.textContent?.trim()).find(Boolean)||null;
 return {url:location.href,visible:{title:first(['#activity-name','#js_text_title','.rich_media_title']),account:first(['#js_name','.wx_follow_nickname','.rich_media_meta_nickname']),text:content?.innerText||'',images:content?.querySelectorAll('img').length||0},html:'<html><body>'+metas+(content?.outerHTML || '')+'<aside>'+ (shell?.textContent || '').slice(0,20000).replaceAll('&','&amp;').replaceAll('<','&lt;')+'</aside><script>'+values+'</script></body></html>'};
})()`;
export async function worker(input: any, createBrowser = managedContext, signal?: AbortSignal) {
  abort(signal);
  if (input.backend === 'opencli_bridge') {
    if (input.action !== 'status') throw new WxError('UNSUPPORTED_CAPABILITY', '当前 OpenCLI Bridge 不提供逐请求拦截，请使用 managed_chrome 后端');
    const bridge = new Page(input.session, 120, undefined, 'background');
    return { connected: (await bridge.tabs()).length >= 0, network_guard: false };
  }
  const browser = await createBrowser({ data_dir: input.data_dir, session: input.session, headless: input.headless ?? false, executable_path: input.executable_path, channel: input.channel, timeout_seconds: input.timeout_seconds ?? 60 });
  const cancel=()=>{void browser.close().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
  const page = {
    goto: async (url: string) => { await browser.page.goto(url, { waitUntil: 'domcontentloaded' }); },
    wait: (seconds: number) => browser.page.waitForTimeout(seconds * 1000),
    evaluate: <T>(js: string) => browser.page.evaluate<T>(js)
  };
  try {
  abort(signal);
  if (input.action === 'status') return { connected: true, network_guard: true, browser_version: browser.context.browser()?.version(), pinned_hosts: browser.pinned_hosts.length, guard_audit: browser.audit };
  if (input.action === 'search') {
    const url = new URL('https://weixin.sogou.com/weixin'); url.search = new URLSearchParams({ type: '2', query: input.query, page: String(input.page), ie: 'utf8' }).toString();
    await page.goto(url.toString()); await page.wait(2);
    const result: any = await page.evaluate(SEARCH_SCRIPT);
    if (new URL(result.url).hostname !== 'weixin.sogou.com') throw new WxError('SOURCE_UNAVAILABLE', '搜索跳转到了不支持的来源');
    if (result.blocked) throw new WxError('VERIFICATION_REQUIRED', '搜狗搜索需要验证', false, '在专用浏览器会话完成搜狗验证');
    if (result.invalid || !result.rows.length && !result.empty) throw new WxError('PARSE_FAILED', '搜狗搜索页面结构无法识别');
    result.rows.forEach((r: any) => discoveryUrl(r.url)); return result.rows.slice(0, input.limit);
  }
  if (input.action === 'resolve' || input.action === 'article') {
    const target = input.action === 'resolve' ? discoveryUrl(input.url) : articleUrl(input.url);
    await page.goto(target); await page.wait(input.action === 'resolve' ? 3 : 2);
    let location = await page.evaluate<string>('location.href');
    if (input.action === 'resolve') {
      // Sogou uses an asynchronous JavaScript redirect after its intermediate document loads.
      for (let n = 0; n < 12 && new URL(location).hostname === 'weixin.sogou.com'; n++) {
        const blocked = await page.evaluate<boolean>('/验证码|环境异常|安全验证/.test(document.body?.innerText || "")');
        if (blocked) throw new WxError('VERIFICATION_REQUIRED', '搜狗链接需要验证', false, '在专用浏览器完成验证后重试');
        await page.wait(1); location = await page.evaluate<string>('location.href');
      }
    }
    try { articleUrl(location); } catch { const text = await page.evaluate<string>('document.body?.innerText?.slice(0,5000) || ""'); if (/验证|验证码|异常访问/.test(text)) throw new WxError('VERIFICATION_REQUIRED', '链接跳转需要验证', false, '在浏览器完成搜狗或微信验证'); throw new WxError('SOURCE_UNAVAILABLE', '发现链接未解析到允许的微信文章地址；候选可能已过期'); }
    if (input.action === 'resolve') return { url: articleUrl(location) };
    return await page.evaluate(ARTICLE_SCRIPT);
  }
  throw new WxError('INVALID_INPUT', '未知浏览器操作');
  } finally { signal?.removeEventListener('abort',cancel);await browser.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2]) {
  try { const data = await controlledWorker(signal=>worker(JSON.parse(Buffer.from(process.argv[2]!, 'base64url').toString()),managedContext,signal)); process.stdout.write(JSON.stringify({ ok: true, data })); }
  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: failure(e instanceof Error && e.name === 'TimeoutError' ? new WxError('NETWORK_ERROR','浏览器加载超时',true) : e) })); process.exitCode = 1; }
}
