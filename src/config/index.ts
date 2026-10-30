import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
const schema = z.object({
  data_dir: z.string().default('./data'), export_dir: z.string().optional(),
  browser: z.object({ enabled: z.boolean().default(true), session: z.string().regex(/^[a-zA-Z][\w-]{0,40}$/).default('wechat-crawler'), backend: z.enum(['managed_chrome','opencli_bridge']).default('managed_chrome'), headless: z.boolean().default(false), channel: z.enum(['chrome','msedge']).default('chrome'), executable_path: z.string().optional() }).strict().prefault({}),
  request: z.object({ interval_ms: z.number().int().min(0).max(60000).default(3500), timeout_seconds: z.number().int().min(1).max(120).default(30), browser_timeout_seconds: z.number().int().min(5).max(180).default(60) }).strict().prefault({}),
  retry: z.object({ max_retries: z.number().int().min(0).max(2).default(2) }).strict().prefault({}),
  content: z.object({ max_response_chars: z.number().int().min(256).max(50000).default(12000) }).strict().prefault({}),
  media: z.object({ max_image_bytes: z.number().int().min(1024).max(10485760).default(10485760), max_total_bytes_per_job: z.number().int().min(1024).max(104857600).default(104857600) }).strict().prefault({}),
  search_cache: z.object({ ttl_seconds: z.number().int().min(1).max(3600).default(600) }).strict().prefault({})
}).strict();
export type Config = z.infer<typeof schema> & { export_dir: string };
export async function loadConfig(file?: string): Promise<Config> {
  const configPath = file ?? process.env.WX_CONFIG;
  const raw = configPath ? JSON.parse(await readFile(path.resolve(configPath), 'utf8')) : {};
  const cfg = schema.parse(raw); const base = configPath ? path.dirname(path.resolve(configPath)) : process.cwd();
  cfg.data_dir = path.resolve(base, process.env.WX_DATA_DIR ?? cfg.data_dir);
  return { ...cfg, export_dir: cfg.export_dir ? path.resolve(base, cfg.export_dir) : path.join(cfg.data_dir, 'exports') };
}
