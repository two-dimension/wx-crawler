import dns from 'node:dns/promises';
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { publicIP } from '../providers/http.js';
import { WxError, inside } from '../shared/util.js';

// Exact hosts only. DNS is pinned before Chrome starts; unknown names cannot resolve.
export const BROWSER_HOSTS = [
  'weixin.sogou.com', 'mp.weixin.qq.com', 'weixin.qq.com', 'res.wx.qq.com', 'res2.wx.qq.com',
  'mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'wximg.qq.com', 'dlweb.sogoucdn.com',
  'img01.sogoucdn.com', 'img02.sogoucdn.com', 'img03.sogoucdn.com', 'img04.sogoucdn.com',
  'pinyin.sogou.com', 'account.sogou.com', 'sec.sogou.com', 'captcha.sogou.com'
];
export function allowedBrowserURL(raw: string) {
  try { const u = new URL(raw); return ['https:', 'http:'].includes(u.protocol) && BROWSER_HOSTS.includes(u.hostname) && !u.port && !u.username && !u.password; }
  catch { return false; }
}
export async function pinnedDNS(lookup = (host: string) => dns.lookup(host, { family: 4, all: true })) {
  const mappings: string[] = []; const resolved: string[] = [];
  for (const host of BROWSER_HOSTS) {
    let rows: { address: string; family: number }[];
    try { rows = await lookup(host); } catch { continue; }
    if (!rows.length || rows.some(r => !publicIP(r.address))) throw new WxError('INVALID_INPUT', '浏览器来源解析到了非公网地址');
    mappings.push(`MAP ${host} ${rows[0]!.address}`); resolved.push(host);
  }
  if (!resolved.includes('mp.weixin.qq.com') || !resolved.includes('weixin.sogou.com')) throw new WxError('NETWORK_ERROR', '必要浏览器来源的公网 DNS 解析失败', true);
  mappings.push('MAP * ~NOTFOUND'); return { rules: mappings.join(', '), resolved };
}
type Fulfillment = { responseCode: number; responseHeaders?: { name: string; value: string }[]; body?: string };
export type GuardAudit = { blocked_count: number; upgraded_count: number; checked_count: number };
export async function guardPage(context: BrowserContext, page: Page, audit: GuardAudit, fixture?: (url: string) => Fulfillment | undefined) {
  const cdp = await context.newCDPSession(page);
  cdp.on('Fetch.requestPaused', async event => {
    try {
      audit.checked_count++;
      if (!allowedBrowserURL(event.request.url)) { audit.blocked_count++; await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); return; }
      const url = new URL(event.request.url);
      if (url.protocol === 'http:') {
        audit.upgraded_count++; url.protocol = 'https:';
        await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 307, responseHeaders: [{ name: 'location', value: url.toString() }], body: '' }); return;
      }
      const response = fixture?.(event.request.url);
      if (response) { await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, ...response }); return; }
      // Browser-side analytics/writes and arbitrary downloads are outside the crawler contract.
      if (!['GET','HEAD','OPTIONS'].includes(event.request.method) && !['weixin.sogou.com','sec.sogou.com','captcha.sogou.com'].includes(url.hostname)) {
        audit.blocked_count++; await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); return;
      }
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
    } catch { try { await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); } catch {} }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  return cdp;
}
export type ManagedOptions = { data_dir: string; session: string; headless: boolean; interactive?: boolean; executable_path?: string; channel?: 'chrome' | 'msedge'; timeout_seconds: number };
export async function managedContext(options: ManagedOptions, testing?: { dns?: Parameters<typeof pinnedDNS>[0]; respond?: (url: string) => Fulfillment | undefined }) {
  const pinned = await pinnedDNS(testing?.dns);
  const context = await chromium.launchPersistentContext(inside(options.data_dir, 'browser', options.session), {
    ...(options.executable_path ? { executablePath: options.executable_path } : { channel: options.channel ?? 'chrome' }),
    headless: options.headless, serviceWorkers: 'block', acceptDownloads: false,
    timeout: options.timeout_seconds * 1000,
    args: ['--no-proxy-server', `--host-resolver-rules=${pinned.rules}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-background-networking', ...(!options.headless && !options.interactive ? ['--window-position=-32000,-32000'] : [])],
    ignoreDefaultArgs: ['--disable-popup-blocking']
  });
  const audit: GuardAudit = { checked_count: 0, blocked_count: 0, upgraded_count: 0 };
  try {
    // Context-wide first-request checks cover workers/popups; CDP Fetch also checks every redirect.
    await context.routeWebSocket('**/*', ws => ws.close());
    const guards = new WeakMap<Page, Promise<CDPSession>>();
    const protect = (p: Page) => { let task = guards.get(p); if (!task) { task = guardPage(context, p, audit, testing?.respond); guards.set(p, task); } return task; };
    context.on('page', p => { void protect(p).catch(() => p.close()); });
    for (const p of context.pages()) await protect(p);
    const probe = await context.newPage(); await protect(probe);
    let verified = false;
    try { await probe.goto('https://wechat-crawler-network-guard.invalid/', { timeout: 10000 }); }
    catch (e) { verified = e instanceof Error && /ERR_BLOCKED_BY_CLIENT/.test(e.message); }
    await probe.close();
    if (!verified) throw new WxError('SOURCE_UNAVAILABLE', '浏览器网络拦截自检失败，拒绝继续导航');
    await context.route('**/*', async route => { if (!allowedBrowserURL(route.request().url())) await route.abort('blockedbyclient'); else await route.continue(); });
    const page = context.pages()[0] ?? await context.newPage(); await protect(page);
    page.setDefaultTimeout(options.timeout_seconds * 1000); page.setDefaultNavigationTimeout(options.timeout_seconds * 1000);
    return { context, page, audit, pinned_hosts: pinned.resolved, close: () => context.close() };
  } catch (e) { await context.close(); throw e; }
}
