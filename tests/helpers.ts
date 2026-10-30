import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createApp } from '../src/server/index.js';
import { parseArticle } from '../src/parser/article.js';
import { setTimeout as delay } from 'node:timers/promises';
export const fixture = () => readFile(new URL('./fixtures/article.html', import.meta.url), 'utf8');
export const URL1 = 'https://mp.weixin.qq.com/s/test-one';
export async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), '微信MCP-'));
  const cfg = await loadConfig(); cfg.data_dir = root; cfg.export_dir = path.join(root, 'exports'); cfg.browser.enabled = false; cfg.request.interval_ms = 0; cfg.retry.max_retries = 0;
  const app = await createApp(cfg);
  return { ...app, root, async cleanup() { await app.close(); if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('unsafe cleanup'); await rm(root, { recursive: true, force: true }); } };
}
export function stub(app: Awaited<ReturnType<typeof setup>>, html: string) {
  app.service.draft = async (url: string) => ({ draft: parseArticle(html, url), aliases: [url] });
}
export async function waitJob(app: Awaited<ReturnType<typeof setup>>, jobId: string) {
  for (let n = 0; n < 200; n++) { const j = app.store.job(jobId); if (!['queued', 'running', 'backoff'].includes(j.state)) return j; await delay(10); }
  throw Error('job timed out');
}
