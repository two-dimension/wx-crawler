import { createApp } from '../src/server/index.js';
import { loadConfig } from '../src/config/index.js';
import { managedContext } from '../src/browser/managed.js';
import { atomic, failure, now } from '../src/shared/util.js';
const cfg = await loadConfig(); const app = await createApp(cfg);
let browser: Awaited<ReturnType<typeof managedContext>> | undefined;
try {
  browser = await managedContext({ data_dir: cfg.data_dir, session: cfg.browser.session, headless: false, interactive: true, channel: cfg.browser.channel, executable_path: cfg.browser.executable_path, timeout_seconds: 60 });
  const closed = new Promise<void>(resolve => browser!.context.once('close', () => resolve()));
  await browser.page.goto('https://weixin.sogou.com/weixin?type=2&query=%E5%BE%AE%E4%BF%A1%E5%85%AC%E5%BC%80%E8%AF%BE', { waitUntil: 'domcontentloaded' });
  await browser.page.waitForTimeout(2000);
  const ready = await browser.page.locator('.news-list li').count();
  if (ready) {
    process.stdout.write('当前会话已返回真实搜索结果，无需人工验证。\n'); await browser.close();
  } else process.stdout.write('请在专用 Chrome 窗口完成搜狗验证，然后关闭这个专用窗口。会话保存在项目 data/browser 目录。\n');
  await closed;
  await atomic('data/browser-login-report.json', JSON.stringify({ closed_at: now(), session: cfg.browser.session, verification_claimed: false, search_results_seen: ready }, null, 2));
} catch (e) { process.stderr.write(JSON.stringify(failure(e)) + '\n'); process.exitCode = 1; }
finally { await browser?.close().catch(() => {}); await app.close(); }
