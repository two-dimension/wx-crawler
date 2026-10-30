import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { articleUrl, mediaUrl } from '../resolver/url.js';
import { hash, now, WxError, escapeHtml, validCalendar } from '../shared/util.js';
import { PARSER_VERSION, type Block, type Draft } from '../shared/model.js';
const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
export function parseArticle(html: string, rawUrl: string, method = 'public_http'): Draft {
  const url = articleUrl(rawUrl); const $ = cheerio.load(html); const bodyText = $('body').text().replace(/\s+/g, ' ');
  const inlineScripts = $('script:not([src])').toArray().map(e => $(e).html() || '').join('\n');
  const content = $('#js_content').first();
  const shellText = $('body').clone(); shellText.find('#js_content, script, style').remove(); const gate = shellText.text();
  const shortContent = content.text().replace(/\s+/g, ' ').trim();
  const promptOnly = shortContent.length < 250 && !content.find('img,video,audio,iframe,mpvoice,mp-video').length;
  if (promptOnly && /^(环境异常.*完成验证|请输入验证码|安全验证后继续)/.test(shortContent)) throw new WxError('VERIFICATION_REQUIRED', '正文区域只有验证提示', false, '在本地完成来源验证后继续');
  if (promptOnly && /^(该内容已被发布者删除|此内容因违规无法查看|内容已删除)/.test(shortContent)) throw new WxError('ARTICLE_DELETED', '正文区域只有删除提示');
  if (promptOnly && /^(请先登录|登录后(?:即可|才可|查看))/.test(shortContent)) throw new WxError('AUTH_REQUIRED', '正文区域只有登录提示', false, '在专用浏览器登录');
  if (promptOnly && /^(访问过于频繁|操作频繁)/.test(shortContent)) throw new WxError('RATE_LIMITED', '正文区域只有限流提示', true, '等待冷却后继续', 60);
  if (promptOnly && /^(付费后(?:阅读|查看)|购买后(?:阅读|查看)|权限不足|请付费)/.test(shortContent)) throw new WxError('ACCESS_RESTRICTED', '正文区域只有权限提示，没有可归档正文');
  if ($('#js_verify').length || /secitptpage\/verify\.html/.test(html) || /环境异常[\s\S]*完成验证|请输入验证码|安全验证后继续/.test(gate)) throw new WxError('VERIFICATION_REQUIRED', '微信要求环境或验证码验证', false, '在专用浏览器会话打开文章并完成验证，然后 resume');
  if (!content.length && /该内容已被发布者删除|此内容因违规无法查看|内容已删除/.test(bodyText)) throw new WxError('ARTICLE_DELETED', '文章已删除或被移除');
  if (!content.length && /访问过于频繁|操作频繁/.test(bodyText)) throw new WxError('RATE_LIMITED', '微信访问频率受限', true, '等待冷却后继续', 60);
  if (!content.length && /登录后|请先登录/.test(bodyText)) throw new WxError('AUTH_REQUIRED', '文章需要登录', false, '在专用浏览器会话登录');
  const restricted = /付费阅读|付费后|购买后|试读|仅展示部分|剩余内容|权限不足/.test(gate) || $('[id*="paywall"], .paywall, .preview_tip').length > 0;
  if (!content.length || !content.text().trim() && !content.find('img, video, audio, iframe, mpvoice, mp-video').length) throw new WxError(restricted ? 'ACCESS_RESTRICTED' : 'PARSE_FAILED', restricted ? '文章受限且没有可归档的可见正文' : '页面没有可识别的有效正文');
  function meta(...selectors: string[]): string | null { for (const s of selectors) { const e = $(s).first(); const t = (e.attr('content') ?? e.text()).replace(/\s+/g, ' ').trim(); if (t && t !== 'Name cleared') return t; } return null; }
  function scriptValue(names: string[]): string | null {
    for (const name of names) {
      const pattern = new RegExp(`(?:\\b(?:var|let|const)\\s+|(?:^|[;\\n])\\s*)${name}\\s*=\\s*(?:JsDecode\\()?['\"]([^'\"<>]+)['\"]|\\b${name}\\s*:\\s*(?:JsDecode\\()?['\"]([^'\"<>]+)['\"]|(?:\\b(?:var|let|const)\\s+|(?:^|[;\\n])\\s*)${name}\\s*=\\s*(\\d+)\\b`, 'g');
      for (const m of inlineScripts.matchAll(pattern)) {
        const value = m[1] || m[2] || m[3] || '';
        const valid = ['biz','__biz'].includes(name) ? /^[a-zA-Z0-9+/_=-]{8,256}$/.test(value) : name === 'sn' ? /^[a-fA-F0-9]{16,128}$/.test(value) : /^\d{1,16}$/.test(value);
        if (valid) return value;
      }
    }
    return null;
  }
  const parsed = new URL(url);
  const pageBiz = scriptValue(['biz', '__biz']), pageMid = scriptValue(['appmsgid', 'mid']), pageIdx = scriptValue(['idx']);
  for (const [key, observed] of [['__biz',pageBiz],['mid',pageMid],['idx',pageIdx]]) if (observed && parsed.searchParams.get(key!) && parsed.searchParams.get(key!) !== observed) throw new WxError('IDENTITY_AMBIGUOUS', '链接身份与正文声明不一致，拒绝自动归档');
  const biz = pageBiz || parsed.searchParams.get('__biz');
  const midParam = parsed.searchParams.get('mid'), idxParam = parsed.searchParams.get('idx');
  const mid = pageMid || (midParam && /^\d+$/.test(midParam) ? midParam : null);
  const idx = pageIdx || (idxParam && /^\d+$/.test(idxParam) ? idxParam : null);
  const sn = parsed.searchParams.get('sn') || scriptValue(['sn']);
  let canonicalUrl=url;
  if (biz && mid && idx && sn && /^[a-fA-F0-9]{16,128}$/.test(sn) && parsed.searchParams.has('signature')) {
    const stableURL=new URL('https://mp.weixin.qq.com/s');for(const [key,value] of Object.entries({__biz:biz,mid,idx,sn}))stableURL.searchParams.set(key,value);canonicalUrl=articleUrl(stableURL.toString());
  }
  const title = meta('#activity-name', '#js_text_title', '.rich_media_title', 'meta[property="og:title"]');
  const account = meta('#js_name', '.wx_follow_nickname', '#profileBt .profile_nickname', '.rich_media_meta_nickname');
  const authorCandidates = $('.rich_media_meta_text').toArray().filter(e => !['copyright_logo','publish_time'].includes($(e).attr('id') || '')).map(e => $(e).text().trim()).filter(t => t && !/^(原创|已修改|IP属地|Name cleared)$/.test(t));
  const author = meta('#js_author_name') || (authorCandidates.length === 1 ? authorCandidates[0]! : null);
  const description = meta('meta[name="description"]');
  const publishedRaw = meta('#publish_time') || scriptValue(['create_time', 'ct']);
  let published: string | null = null;
  if (publishedRaw) {
    if (/^\d{10}(\d{3})?$/.test(publishedRaw)) published = new Date(Number(publishedRaw) * (publishedRaw.length === 10 ? 1000 : 1)).toISOString();
    else { const m = publishedRaw.match(/^(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/); if (m) { const value = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}T${(m[4] ?? '00').padStart(2, '0')}:${m[5] ?? '00'}:${m[6] ?? '00'}+08:00`; if (validCalendar(value) && Number.isFinite(Date.parse(value))) published = new Date(value).toISOString(); } }
  }
  content.find('script, style, form, input, button, link, meta, .qr_code_pc, .reward_area, .code-snippet__line-index').remove();
  content.find('*').each((_i, element) => {
    const el = $(element); const attrs = { ...element.attribs };
    for (const k of Object.keys(attrs)) if (!['href', 'src', 'data-src', 'alt', 'title', 'data-lang', 'colspan', 'rowspan', 'class'].includes(k)) el.removeAttr(k);
    if (element.tagName === 'img') { try { el.attr('src', mediaUrl(el.attr('data-src') || el.attr('src') || '')); } catch { el.removeAttr('src'); } el.removeAttr('data-src'); }
    if (element.tagName === 'a') { try { const u = new URL(el.attr('href') ?? '', url); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw 0; el.attr('href', u.toString()); } catch { el.removeAttr('href'); } }
  });
  const warnings: string[] = []; const blocks: Block[] = []; const links: Draft['external_links'] = [];
  function add(type: Block['type'], text: string, markdown: string, extra: Partial<Block> = {}) {
    if (!text.trim() && !extra.url && type !== 'unsupported') return;
    const order = blocks.length; const block_id = `b${String(order + 1).padStart(5, '0')}`;
    blocks.push({ block_id, order, type, text: text.trim(), markdown: markdown.trim(), ...extra }); return block_id;
  }
  function walk(node: any) {
    if (node.type === 'text') { if (node.data.trim()) add('paragraph', node.data, td.turndown(escapeHtml(node.data))); return; }
    if (node.type !== 'tag') return;
    const el = $(node); const tag = node.tagName.toLowerCase();
    if (['svg','canvas','math','object','embed'].includes(tag)) { add('unsupported', el.text() || `[${tag}]`, `[当前无法完整表达的内容: ${tag}]`, { reason: `unsupported_element:${tag}` }); warnings.push('unsupported_content'); return; }
    if (tag === 'img') { const src = el.attr('src'); if (src) add('image', el.attr('alt') || '', `![${(el.attr('alt') || '').replace(/[\[\]]/g, '')}](${src})`, { url: src }); else { add('unsupported', '图片来源不受支持', '[图片未提取]', { reason: 'unsupported_image_source' }); warnings.push('unsupported_image_source'); } return; }
    if (['video', 'mp-video', 'iframe', 'audio', 'mpvoice', 'mp-common-videosnap'].includes(tag)) {
      const type = ['audio', 'mpvoice'].includes(tag) ? 'audio_reference' : 'video_reference'; let resource: string | undefined;
      try { const u = new URL(el.attr('src') || el.attr('data-src') || el.find('source').attr('src') || '', url); if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && u.toString() !== url) resource = u.toString(); } catch {}
      add(type, '[媒体未转录]', resource ? `[媒体未转录](${resource})` : '[媒体未转录]', { ...(resource ? { url: resource } : {}), reason: 'media_not_transcribed' }); warnings.push('media_not_transcribed'); return;
    }
    if (tag.includes('-') && !['mp-style-type'].includes(tag)) { add('unsupported', el.text() || `[${tag}]`, td.turndown(el.html() || '') || `[不支持的内容: ${tag}]`, { reason: `unsupported_element:${tag}` }); warnings.push('unsupported_content'); return; }
    if (tag === 'a' && el.attr('href')) {
      const href = el.attr('href')!; const start = blocks.length;
      if (el.find('img,video,audio,iframe').length) el.contents().each((_i, child)=>walk(child));
      else add(/\.(pdf|docx?|xlsx?|pptx?|zip)(?:[?#]|$)/i.test(href) ? 'attachment_reference' : 'paragraph', el.text() || href, td.turndown($.html(node)), { url: href });
      const block = blocks[start]; if (block) links.push({url:href,text:el.text(),block_id:block.block_id}); return;
    }
    const type: Block['type'] | undefined = /^h[1-6]$/.test(tag) ? 'heading' : tag === 'pre' || el.hasClass('code-snippet__fix') ? 'code' : tag === 'table' ? 'table' : ['ul', 'ol'].includes(tag) ? 'list' : tag === 'blockquote' ? 'quote' : ['p'].includes(tag) ? 'paragraph' : undefined;
    if (type && !el.find('img, video, audio, iframe, mpvoice, mp-video, mp-common-videosnap').length) {
      let markdown = td.turndown($.html(node));
      if (type === 'table') { const rows = el.find('tr').toArray().map(r => $(r).find('th,td').toArray().map(c => $(c).text().trim().replace(/\|/g, '\\|').replace(/\s+/g, ' '))); if (rows.length) { const width = Math.max(...rows.map(r => r.length)); const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`; markdown = [line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n'); } }
      const b = add(type, el.text(), markdown);
      if (b) el.find('a[href]').each((_i, a) => { const href = $(a).attr('href')!; links.push({ url: href, text: $(a).text(), block_id: b }); if (/\.(pdf|docx?|xlsx?|pptx?|zip)(?:[?#]|$)/i.test(href)) add('attachment_reference', $(a).text() || '[附件]', `[${$(a).text() || '附件'}](${href})`, { url: href, reason: 'attachment_not_downloaded' }); });
      return;
    }
    el.contents().each((_i, child) => walk(child));
  }
  content.contents().each((_i, child) => walk(child));
  content.find('object,embed').remove();
  if (!blocks.length || blocks.every(b => b.type === 'unsupported')) throw new WxError('PARSE_FAILED', '没有有效正文块');
  if (restricted) warnings.push('access_restricted_preview');
  if (new URL(canonicalUrl).searchParams.has('signature')) warnings.push('canonical_url_may_expire');
  if (!blocks.some(b => b.type !== 'image' && b.text)) warnings.push('image_text_not_extracted');
  const assets = [...new Set(blocks.filter(b => b.type === 'image').map(b => b.url!))].map(u => ({ url: u, status: 'skipped' as const }));
  const contentStatus = restricted || blocks.some(b => b.type === 'unsupported') ? 'partial' : 'complete';
  const contentHash = hash(JSON.stringify({ blocks, title, account, published, author }));
  const identity = biz && mid && idx ? `${biz}|${mid}|${idx}` : url;
  return {
    article_id: `art_${hash(identity).slice(0, 32)}`, account_id: biz ? `acct_${hash(biz).slice(0, 24)}` : null,
    biz, mid, idx, discovered_url: url, canonical_url: canonicalUrl, title, account_name: account, author, description, published_raw: publishedRaw, published_at: published,
    provider: method, method, discovered_at: now(), fetched_at: now(), content_version: `v_${contentHash.slice(0, 24)}`, content_hash: contentHash, parser_version: PARSER_VERSION,
    metadata_status: title && account && published ? 'complete' : 'partial', content_status: contentStatus, media_status: 'skipped', warnings: [...new Set(warnings)], blocks,
    markdown: blocks.map(b => b.markdown).join('\n\n'), text: blocks.map(b => b.text).filter(Boolean).join('\n\n'), assets, external_links: links,
    metadata_reasons: { ...(!title ? { title: 'not_present' } : {}), ...(!account ? { account_name: 'not_present' } : {}), ...(!author ? { author: authorCandidates.length > 1 ? 'ambiguous_author_nodes' : 'not_present' } : {}), ...(!description ? { description: 'not_present' } : {}), ...(!published ? { published_at: 'not_confirmed' } : {}), ...(!publishedRaw ? { published_raw: 'not_present' } : {}), ...(!biz ? { biz: 'not_confirmed', account_id: 'biz_not_confirmed; names_are_not_unique' } : {}), ...(!mid ? { mid: 'not_confirmed' } : {}), ...(!idx ? { idx: 'not_confirmed' } : {}) },
    snapshot: `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://mmbiz.qpic.cn https://mmbiz.qlogo.cn; style-src 'unsafe-inline'"><title>${escapeHtml(title || '')}</title><h1>${escapeHtml(title || '')}</h1><p>${escapeHtml(account || '')}</p><time>${escapeHtml(publishedRaw || '')}</time><div id="js_content">${content.html()}</div>`
  };
}
