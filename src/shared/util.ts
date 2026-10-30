import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ErrorCode, Failure } from './model.js';

export class WxError extends Error {
  constructor(public code: ErrorCode, message: string, public retryable = false, public required_action?: string, public retry_after_seconds?: number) { super(message); }
  toJSON(): Failure { return { code: this.code, message: this.message, retryable: this.retryable, ...(this.required_action ? { required_action: this.required_action } : {}), ...(this.retry_after_seconds !== undefined ? { retry_after_seconds: this.retry_after_seconds } : {}) }; }
}
export function failure(e: unknown): Failure {
  if (e instanceof WxError) return e.toJSON();
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) return { code: 'CANCELLED', message: '操作已取消或超过时间限制', retryable: true };
  // Raw upstream exceptions may contain URLs, headers or credentials.
  return { code: 'SOURCE_UNAVAILABLE', message: '操作失败；请检查来源连接和本地存储状态', retryable: false };
}
export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export function stable(value: any): string { return JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v); }
export function inside(root: string, ...parts: string[]): string {
  const target = path.resolve(root, ...parts); const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new WxError('INVALID_INPUT', '路径超出配置根目录');
  return target;
}
export async function atomic(file: string, value: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, value); await rename(temp, file); } finally { await rm(temp, { force: true }); }
}
export async function ensureRoot(root: string) { await mkdir(root, { recursive: true }); return realpath(root); }
export function abort(signal?: AbortSignal) { signal?.throwIfAborted(); }
export async function sleep(ms: number, signal?: AbortSignal) { if (ms > 0) await delay(ms, undefined, { signal }); }
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> { const task = this.tail.then(fn); this.tail = task.catch(() => {}); return task; }
}
export function cursor(binding: unknown, position: unknown) { return Buffer.from(JSON.stringify({ binding: hash(stable(binding)), position })).toString('base64url'); }
export function uncursor<T>(raw: string | undefined, binding: unknown, initial: T): T {
  if (!raw) return initial;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString()); if (c.binding !== hash(stable(binding))) throw 0;
    if (typeof c.position !== typeof initial || c.position === null) throw 0;
    if (typeof initial === 'object' && Object.entries(initial as object).some(([k,v]) => typeof c.position[k] !== typeof v)) throw 0;
    return c.position as T;
  }
  catch { throw new WxError('INVALID_INPUT', '游标无效或不属于当前查询'); }
}
export function dateBoundary(value?: string): string | undefined {
  if (!value) return undefined;
  const s = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+08:00` : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(s) || !validCalendar(s) || !Number.isFinite(Date.parse(s))) throw new WxError('INVALID_INPUT', '日期必须为有效的 YYYY-MM-DD 或带时区的 ISO 8601');
  return new Date(s).toISOString();
}
export function validCalendar(value: string) {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return false;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`); return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
}
export function escapeHtml(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
