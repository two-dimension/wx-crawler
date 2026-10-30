import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Serial, hash, WxError, sleep, abort } from '../shared/util.js';
import type { Config } from '../config/index.js';
export class BrowserSource {
  private queue = new Serial(); private last = 0;
  private shutdown=new AbortController();private operations=new Set<Promise<any>>();
  private workerUrl = new URL(import.meta.url.endsWith('.ts') ? '../browser/worker.ts' : '../browser/worker.js', import.meta.url);
  constructor(private cfg: Config) {}
  async fingerprint() {
    const ext = this.workerUrl.pathname.endsWith('.ts') ? 'ts' : 'js';
    const files = [this.workerUrl, new URL(`../browser/managed.${ext}`,import.meta.url),new URL(`../browser/cancellation.${ext}`,import.meta.url),new URL(`../resolver/url.${ext}`,import.meta.url)];
    const contents = await Promise.all(files.map(url=>readFile(url)));
    return { backend: this.cfg.browser.backend, opencli: '2.0.2', playwright: '1.64.1', network_guard: this.cfg.browser.backend === 'managed_chrome', adapter: 'bundled-fixed-browser-worker', sha256: hash(Buffer.concat(contents)), files: files.map((url,i)=>({name:url.pathname.split('/').at(-1),sha256:hash(contents[i]!)})) };
  }
  run(action: 'search' | 'resolve' | 'article' | 'status', args: Record<string, any> = {}, signal?: AbortSignal): Promise<any> {
    signal=signal?AbortSignal.any([signal,this.shutdown.signal]):this.shutdown.signal;
    const task=this.queue.run(async () => {
      if (!this.cfg.browser.enabled) throw new WxError('UNSUPPORTED_CAPABILITY', '浏览器来源未启用');
      abort(signal); if (action !== 'status') await sleep(Math.max(0, this.last + this.cfg.request.interval_ms - Date.now()), signal); this.last = Date.now();
      return new Promise((resolve, reject) => {
        let cancelled:unknown;let killTimer:ReturnType<typeof setTimeout>|undefined;
        const cancel=(reason:unknown)=>{if(cancelled)return;cancelled=reason;child.stdin?.write('cancel\n',()=>{});killTimer=setTimeout(()=>child.kill(),5000);};
        const onAbort=()=>cancel(signal?.reason ?? new WxError('CANCELLED','浏览器操作已取消'));
        const child=execFile(process.execPath, [...(this.workerUrl.pathname.endsWith('.ts') ? ['--import', 'tsx'] : []), fileURLToPath(this.workerUrl), Buffer.from(JSON.stringify({ ...args, action, data_dir: this.cfg.data_dir, ...this.cfg.browser, timeout_seconds: this.cfg.request.browser_timeout_seconds })).toString('base64url')], { maxBuffer: 10 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: '1', OPENCLI_NO_UPDATE_CHECK: '1' } }, (err, stdout) => {
          clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener('abort',onAbort);
          if(cancelled){reject(cancelled);return;}
          try { const value = JSON.parse(stdout); if (value.ok) resolve(value.data); else reject(new WxError(value.error.code, value.error.message, value.error.retryable, value.error.required_action, value.error.retry_after_seconds)); }
          catch { reject(signal?.aborted ? signal.reason : new WxError('SOURCE_UNAVAILABLE', err?.killed ? '浏览器操作超时' : this.cfg.browser.backend === 'managed_chrome' ? '受控 Chrome 连接失败或子进程退出' : 'Browser Bridge 连接失败', true, this.cfg.browser.backend === 'managed_chrome' ? '确认 Chrome/Edge 已安装且专用 profile 未被其他进程占用；需要人工验证时运行 npm run browser:login' : '运行本项目 OpenCLI doctor，确认 Chrome 和 Browser Bridge 已连接')); }
        });
        child.stdin?.on('error',()=>{});
        const timer=setTimeout(()=>cancel(new WxError('NETWORK_ERROR','浏览器操作超时',true)),this.cfg.request.browser_timeout_seconds*1000);
        signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
      });
    });
    this.operations.add(task);void task.finally(()=>this.operations.delete(task)).catch(()=>{});return task;
  }
  async close(){this.shutdown.abort(new WxError('CANCELLED','服务正在停止'));await Promise.allSettled([...this.operations]);}
}
