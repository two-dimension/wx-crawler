import { WxError } from '../shared/util.js';
const TRACKING = ['scene', 'subscene', 'from', 'isappinstalled', 'clicktime', 'enterid', 'sessionid', 'ascene', 'devicetype', 'version', 'lang', 'nettype', 'exportkey', 'pass_ticket', 'wx_header', 'token', 'wxtoken', 'wxuin', 'uin', 'key', 'auth_token'];
export function articleUrl(raw: string): string {
  let u: URL; try { u = new URL(raw.trim().replaceAll('&amp;', '&')); } catch { throw new WxError('INVALID_INPUT', '需要有效的微信公众号文章 URL'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.hostname !== 'mp.weixin.qq.com' || u.username || u.password || u.port || !(/^\/s\/[\w-]+\/?$/.test(u.pathname) || u.pathname === '/s')) throw new WxError('INVALID_INPUT', '只接受 mp.weixin.qq.com/s 文章链接');
  const signedSearchLink = ['src', 'timestamp', 'ver', 'signature'].every(k => u.searchParams.get(k));
  if (u.pathname === '/s' && !u.searchParams.get('__biz') && !signedSearchLink) throw new WxError('INVALID_INPUT', '长链接缺少文章身份或搜狗签名参数');
  u.protocol = 'https:'; u.hash = ''; TRACKING.forEach(k => u.searchParams.delete(k)); u.searchParams.sort(); return u.toString();
}
export function discoveryUrl(raw: string): string {
  try { return articleUrl(raw); } catch { /* allow only Sogou article redirects */ }
  let u: URL; try { u = new URL(raw); } catch { throw new WxError('INVALID_INPUT', '无效发现链接'); }
  if (u.protocol !== 'https:' || u.hostname !== 'weixin.sogou.com' || u.port || u.username || u.password || u.pathname !== '/link') throw new WxError('INVALID_INPUT', '发现链接不属于允许的来源');
  u.hash = ''; u.searchParams.delete('token'); return u.toString();
}
export function mediaUrl(raw: string): string {
  let u: URL; try { u = new URL(raw.startsWith('//') ? `https:${raw}` : raw); } catch { throw new WxError('INVALID_INPUT', '无效媒体链接'); }
  const allowed = ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'res.wx.qq.com'];
  if (!['https:', 'http:'].includes(u.protocol) || !allowed.includes(u.hostname) || u.port || u.username || u.password) throw new WxError('INVALID_INPUT', '媒体来源不在允许列表');
  u.protocol = 'https:'; u.hash = ''; return u.toString();
}
