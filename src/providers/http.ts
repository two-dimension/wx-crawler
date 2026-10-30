import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { WxError, abort, sleep } from '../shared/util.js';
import { articleUrl, mediaUrl } from '../resolver/url.js';
import type { Config } from '../config/index.js';
export function publicIP(ip: string): boolean {
  if (isIP(ip) === 4) { const p = ip.split('.').map(Number); return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0]! >= 224 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && (p[1] === 168 || p[1] === 0 || p[1] === 88 && p[2] === 99)) || (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127) || (p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51 && p[2] === 100)) || (p[0] === 203 && p[1] === 0 && p[2] === 113)); }
  return isIP(ip) === 6 && /^2[0-9a-f]{3}:/i.test(ip) && !/^2002:|^2001:db8:|^2001:(?:0{0,3}[0-9a-f]{0,2}|0?1[0-9a-f]{2}):/i.test(ip); // reject mapped/local, documentation and transition ranges
}
export type ByteBudget = { bytes: number; max_bytes: number };
export class PublicHttp {
  private last = new Map<string, number>();
  constructor(private config: Config) {}
  async get(raw: string, kind: 'article' | 'media', signal?: AbortSignal, budget?: ByteBudget): Promise<{ body: Buffer; url: string; type: string }> {
    let url = kind === 'article' ? articleUrl(raw) : mediaUrl(raw);
    for (let n = 0; n < 6; n++) {
      abort(signal); const host = new URL(url).hostname;
      const remaining = budget ? budget.max_bytes - budget.bytes : Infinity;
      if (remaining <= 0) throw new WxError('SOURCE_UNAVAILABLE', '媒体总量达到任务上限');
      await sleep(Math.max(0, (this.last.get(host) ?? 0) + this.config.request.interval_ms - Date.now()), signal); this.last.set(host, Date.now());
      const result = await this.request(url, Math.min(kind === 'article' ? 8 * 1024 * 1024 : this.config.media.max_image_bytes,remaining), signal, budget);
      if (result.status >= 300 && result.status < 400 && result.location) {
        const next = new URL(result.location, url).toString(); url = kind === 'article' ? articleUrl(next) : mediaUrl(next); continue;
      }
      if (result.status === 429) throw new WxError('RATE_LIMITED', '来源限流', true, '等待冷却后恢复', result.retry ?? 60);
      if (result.status === 401) throw new WxError('AUTH_REQUIRED', '来源要求登录', false, '在专用浏览器会话完成登录');
      if (result.status === 403) throw new WxError('ACCESS_RESTRICTED', '来源拒绝访问');
      if (result.status >= 500) throw new WxError('NETWORK_ERROR', '来源暂时不可用', true);
      if (result.status !== 200) throw new WxError('SOURCE_UNAVAILABLE', `来源返回 HTTP ${result.status}`);
      if (kind === 'article' && !/text\/html|application\/xhtml\+xml/i.test(result.type)) throw new WxError('PARSE_FAILED', '文章响应不是 HTML');
      if (kind === 'media' && !/^image\/(png|jpe?g|gif|webp|avif)(;|$)/i.test(result.type)) throw new WxError('PARSE_FAILED', '媒体不是受支持的位图');
      return { body: result.body, url, type: result.type };
    }
    throw new WxError('SOURCE_UNAVAILABLE', '跳转次数超出限制');
  }
  private request(url: string, max: number, signal?: AbortSignal, budget?: ByteBudget): Promise<{ body: Buffer; status: number; type: string; location?: string; retry?: number }> {
    return new Promise((resolve, reject) => {
      const deadline = AbortSignal.timeout(this.config.request.timeout_seconds * 1000);
      const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const req = https.get(url, { signal: operationSignal, headers: { 'User-Agent': 'Mozilla/5.0 wechat-crawler-mcp/0.1', Accept: 'text/html,image/*;q=0.8' }, lookup: ((host: string, options: any, cb: any) => {
        dns.lookup(host, options, (err: any, address: any, family: any) => {
          if (err) return cb(err);
          const rows = Array.isArray(address) ? address : [{ address, family }];
          if (!rows.length || rows.some((r: any) => !publicIP(r.address))) return cb(new WxError('INVALID_INPUT', '阻止访问非公网地址'));
          cb(null, address, family);
        });
      }) as any }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (c: Buffer) => { size += c.length; if (budget) budget.bytes = Math.min(budget.max_bytes,budget.bytes+c.length); if (size > max) req.destroy(new WxError('PARSE_FAILED', '响应超过大小或任务字节限制')); else chunks.push(c); });
        res.on('error', reject);
        res.on('end', () => { const r = res.headers['retry-after']; const seconds = r ? (/^\d+$/.test(r) ? Number(r) : Math.max(0, (Date.parse(r) - Date.now()) / 1000)) : undefined; resolve({ body: Buffer.concat(chunks), status: res.statusCode ?? 0, type: res.headers['content-type'] ?? '', location: res.headers.location, retry: Number.isFinite(seconds) ? seconds : undefined }); });
      });
      req.setTimeout(this.config.request.timeout_seconds * 1000, () => req.destroy(new WxError('NETWORK_ERROR', 'HTTP 请求超时', true)));
      req.on('error', e => reject(e instanceof WxError ? e : signal?.aborted ? signal.reason : new WxError('NETWORK_ERROR', 'HTTP 连接失败', true)));
    });
  }
}
