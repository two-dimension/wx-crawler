import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArticle } from '../src/parser/article.js';
import { articleUrl, mediaUrl, discoveryUrl } from '../src/resolver/url.js';
import { dateBoundary, inside, WxError } from '../src/shared/util.js';
import { publicIP } from '../src/providers/http.js';
import { fixture, URL1 } from './helpers.js';
test('parser extracts metadata, rich blocks and sanitized snapshot without executing script', async () => {
  const a = parseArticle(await fixture(), URL1);
  assert.equal(a.title, '微信公众号 MCP 测试'); assert.equal(a.biz, 'TEST_BIZ'); assert.equal(a.published_at, '2026-10-29T04:30:00.000Z'); assert.equal(a.content_status, 'complete');
  for (const type of ['heading','paragraph','list','quote','table','code','image']) assert.ok(a.blocks.some(b => b.type === type), type);
  assert.match(a.markdown, /\| 字段 \| 数值 \|/); assert.ok(!a.snapshot.includes('onclick')); assert.ok(!a.snapshot.includes('javascript:')); assert.ok(!a.snapshot.includes('<script'));
  assert.equal(a.external_links.length, 1); assert.equal(a.assets.length, 1);
});
test('gates and empty pages are failures, never successful articles', () => {
  for (const [text, code] of [['环境异常 完成验证后即可继续访问','VERIFICATION_REQUIRED'],['该内容已被发布者删除','ARTICLE_DELETED'],['请先登录','AUTH_REQUIRED'],['访问过于频繁','RATE_LIMITED'],['付费后查看','ACCESS_RESTRICTED'],['导航文字','PARSE_FAILED']]) assert.throws(() => parseArticle(`<body>${text}</body>`, URL1), (e: any) => e.code === code);
});
test('prompt-only content nodes and mismatched article identities cannot become successful archives', async () => {
  for (const [text,code] of [['环境异常 完成验证后继续访问','VERIFICATION_REQUIRED'],['该内容已被发布者删除','ARTICLE_DELETED'],['请先登录','AUTH_REQUIRED'],['访问过于频繁','RATE_LIMITED'],['付费后阅读剩余内容','ACCESS_RESTRICTED']]) assert.throws(() => parseArticle(`<h1 id="activity-name">标题</h1><div id="js_content"><p>${text}</p></div>`,URL1), (e: any) => e.code === code);
  const html = await fixture(); assert.throws(() => parseArticle(html, 'https://mp.weixin.qq.com/s?__biz=DIFFERENT_BIZ&mid=100&idx=1'), (e: any) => e.code === 'IDENTITY_AMBIGUOUS');
});
test('identity parser ignores JavaScript template expressions and preserves signed Sogou article URLs', async () => {
  const html = (await fixture()).replace('<script>', '<script>const debug = "mid=\').concat(mid, \'";');
  const url = 'https://mp.weixin.qq.com/s?src=11&timestamp=123&ver=1&signature=sample-signature';
  const a = parseArticle(html, url); assert.equal(a.mid, '100'); assert.equal(a.idx, '1'); assert.ok(articleUrl(url).includes('signature='));
  assert.ok(!discoveryUrl('https://weixin.sogou.com/link?url=sample&token=secret').includes('token='));
});
test('signed discovery URLs become durable identity links only when a verified sn is available',async()=>{
  const url='https://mp.weixin.qq.com/s?src=11&timestamp=123&ver=1&signature=sample';const html=(await fixture()).replace('<script>','<script>var sn="0123456789abcdef0123456789abcdef";');
  const a=parseArticle(html,url);const canonical=new URL(a.canonical_url);assert.equal(canonical.searchParams.get('__biz'),'TEST_BIZ');assert.equal(canonical.searchParams.get('mid'),'100');assert.equal(canonical.searchParams.get('sn'),'0123456789abcdef0123456789abcdef');assert.equal(canonical.searchParams.has('signature'),false);
  const b=parseArticle(await fixture(),url);assert.ok(b.warnings.includes('canonical_url_may_expire'));
});
test('image-only, previews, unsupported media and absent metadata report quality accurately', () => {
  const image = parseArticle('<div id="js_content"><img data-src="https://mmbiz.qpic.cn/a.png"></div>', URL1);
  assert.equal(image.content_status, 'complete'); assert.ok(image.warnings.includes('image_text_not_extracted')); assert.equal(image.published_at, null); assert.equal(image.account_id, null);
  const preview = parseArticle('<aside>付费后阅读剩余内容</aside><div id="js_content"><p>可见试读正文</p></div>', URL1); assert.equal(preview.content_status, 'partial');
  const unsupported = parseArticle('<div id="js_content"><p>正文</p><mp-widget>内容</mp-widget></div>', URL1); assert.equal(unsupported.content_status, 'partial');
});
test('copyright badges are not mistaken for authors and absent metadata has an explicit reason', () => {
  const a=parseArticle('<span class="rich_media_meta_text" id="copyright_logo">原创</span><div id="js_content"><p>正文</p></div>',URL1);
  assert.equal(a.author,null);assert.equal(a.metadata_reasons.author,'not_present');assert.equal(a.metadata_reasons.description,'not_present');assert.equal(a.metadata_reasons.mid,'not_confirmed');
});
test('audio/video and attachments remain references without recursive fetching or transcription', () => {
  const a = parseArticle('<div id="js_content"><p>正文<a href="https://example.com/file.pdf">文件</a></p><audio src="https://example.com/a.mp3"></audio><iframe src="https://example.com/video"></iframe></div>', URL1);
  assert.ok(a.blocks.some(b => b.type === 'attachment_reference' && b.url?.endsWith('.pdf'))); assert.ok(a.blocks.some(b => b.type === 'audio_reference')); assert.ok(a.blocks.some(b => b.type === 'video_reference')); assert.ok(a.warnings.includes('media_not_transcribed'));
});
test('standalone/image links are retained and unrepresentable graphical blocks mark partial content', () => {
  const a=parseArticle('<div id="js_content"><a href="https://example.com/article">参考文献</a><p><a href="https://example.com/picture"><img src="https://mmbiz.qpic.cn/a.png"></a></p><svg><path d="M0 0"></path></svg><canvas></canvas></div>',URL1);
  assert.equal(a.external_links.length,2);assert.equal(a.content_status,'partial');assert.equal(a.blocks.filter(b=>b.type==='unsupported').length,2);assert.match(a.markdown,/https:\/\/example.com\/article/);assert.match(a.snapshot,/Content-Security-Policy/);
});
test('URL canonicalization preserves sn and rejects SSRF, non-article paths and media hosts', () => {
  assert.equal(articleUrl('http://mp.weixin.qq.com/s?__biz=B&mid=1&idx=2&sn=keep&scene=2#x'), 'https://mp.weixin.qq.com/s?__biz=B&idx=2&mid=1&sn=keep');
  for (const u of ['https://mp.weixin.qq.com.evil/s/a','https://127.0.0.1/s/a','https://mp.weixin.qq.com:444/s/a','https://user:pass@mp.weixin.qq.com/s/a','https://mp.weixin.qq.com/cgi-bin/a','file:///test']) assert.throws(() => articleUrl(u));
  assert.throws(() => mediaUrl('https://localhost/a.png')); assert.throws(() => discoveryUrl('https://weixin.sogou.com/weixin?query=a'));
  for (const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1']) assert.equal(publicIP(ip), false, ip);
  assert.equal(publicIP('8.8.8.8'), true); assert.throws(() => inside('D:/data','../secret'));
  assert.equal(dateBoundary('2026-10-30'), '2026-10-29T16:00:00.000Z'); assert.throws(() => dateBoundary('2026-10-30T10:00:00'), WxError); assert.throws(() => dateBoundary('2026-02-30'), WxError);
});
