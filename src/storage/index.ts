import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomic, ensureRoot, hash, id, inside, now, stable, WxError } from '../shared/util.js';
import type { Article, Candidate, Draft, Failure, Job } from '../shared/model.js';
import type { Config } from '../config/index.js';

export class Store {
  db!: DatabaseSync; private lockToken = id('lock'); private lockPath!: string;
  constructor(public cfg: Config) {}
  async init() {
    this.cfg.data_dir = await ensureRoot(this.cfg.data_dir); this.cfg.export_dir = await ensureRoot(this.cfg.export_dir);
    this.lockPath = inside(this.cfg.data_dir, '.writer.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const f = await open(this.lockPath, 'wx'); await f.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken })); await f.close(); break; }
      catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        let owner: any; try { owner = JSON.parse(await readFile(this.lockPath, 'utf8')); } catch { throw new WxError('CONFLICT', '存储实例锁无法核验，请确认旧进程已停止后清理 .writer.lock'); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new WxError('CONFLICT', '实例锁格式无效');
        try { process.kill(owner.pid, 0); throw new WxError('CONFLICT', '该数据目录已有运行实例'); } catch (err: any) { if (err.code !== 'ESRCH') throw err; }
        await unlink(this.lockPath); if (attempt === 1) throw new WxError('CONFLICT', '无法取得实例锁');
      }
    }
    try {
      this.db = new DatabaseSync(inside(this.cfg.data_dir, 'wechat.sqlite'));
      const migration = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (migration > 1) throw new WxError('CONFLICT', '数据库版本高于当前程序，拒绝降级写入');
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts(account_id TEXT PRIMARY KEY,biz TEXT UNIQUE NOT NULL,name TEXT);
        CREATE TABLE IF NOT EXISTS account_provider_ids(account_id TEXT NOT NULL,provider TEXT NOT NULL,provider_id TEXT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(provider,provider_id));
        CREATE TABLE IF NOT EXISTS articles(article_id TEXT PRIMARY KEY,identity_key TEXT UNIQUE,canonical_url TEXT UNIQUE NOT NULL,account_id TEXT,title TEXT,account_name TEXT,published_at TEXT,fetched_at TEXT NOT NULL,body_text TEXT NOT NULL,json TEXT NOT NULL,last_attempt TEXT);
        CREATE TABLE IF NOT EXISTS article_urls(url TEXT PRIMARY KEY,article_id TEXT NOT NULL REFERENCES articles(article_id));
        CREATE TABLE IF NOT EXISTS article_versions(article_id TEXT NOT NULL REFERENCES articles(article_id),version TEXT NOT NULL,json TEXT NOT NULL,path TEXT NOT NULL,PRIMARY KEY(article_id,version));
        CREATE TABLE IF NOT EXISTS assets(hash TEXT PRIMARY KEY,path TEXT NOT NULL,bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS discoveries(candidate_id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS fetch_attempts(attempt_id TEXT PRIMARY KEY,url TEXT NOT NULL,attempted_at TEXT NOT NULL,error TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs(job_id TEXT PRIMARY KEY,kind TEXT NOT NULL,state TEXT NOT NULL,json TEXT NOT NULL,idempotency_key TEXT UNIQUE,params_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS job_items(job_id TEXT NOT NULL,item_index INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(job_id,item_index));
        CREATE TABLE IF NOT EXISTS checkpoints(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS exports(export_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS article_dates ON articles(published_at,article_id);
        INSERT OR IGNORE INTO migrations VALUES(1,datetime('now')); PRAGMA user_version=1;`);
      for (const row of this.db.prepare("SELECT json FROM jobs WHERE state IN ('running','queued','backoff')").all()) { const j: Job = JSON.parse(row.json as string); j.state = 'interrupted'; j.next_attempt_at = undefined; this.saveJob(j); }
    } catch (e) { await this.close(); throw e; }
    return this;
  }
  async close() {
    this.db?.close();
    if (this.lockPath) { try { const owner = JSON.parse(await readFile(this.lockPath, 'utf8')); if (owner.token === this.lockToken) await unlink(this.lockPath); } catch {} }
  }
  cached(url: string): Article | null { const row = this.db.prepare('SELECT a.json FROM articles a LEFT JOIN article_urls u ON u.article_id=a.article_id WHERE u.url=? OR a.canonical_url=? LIMIT 1').get(url, url); return row ? JSON.parse(row.json as string) : null; }
  article(articleId: string, version?: string): Article {
    const row = version ? this.db.prepare('SELECT json FROM article_versions WHERE article_id=? AND version=?').get(articleId, version) : this.db.prepare('SELECT json FROM articles WHERE article_id=?').get(articleId);
    if (!row) throw new WxError('RESOURCE_NOT_FOUND', '文章或正文版本不存在'); return JSON.parse(row.json as string);
  }
  lastAttempt(articleId: string): { at: string; error: Failure } | undefined { const row = this.db.prepare('SELECT last_attempt FROM articles WHERE article_id=?').get(articleId); return row?.last_attempt ? JSON.parse(row.last_attempt as string) : undefined; }
  attempt(articleId: string, error: Failure) { this.db.prepare('UPDATE articles SET last_attempt=? WHERE article_id=?').run(JSON.stringify({ at: now(), error }), articleId); }
  recordFailure(url: string, error: Failure) { this.db.prepare('INSERT INTO fetch_attempts VALUES(?,?,?,?)').run(id('attempt'), url, now(), JSON.stringify(error)); }
  async saveArticle(draft: Draft, aliases: string[]): Promise<Article> {
    const identity = draft.biz && draft.mid && draft.idx ? `${draft.biz}|${draft.mid}|${draft.idx}` : null;
    const existing = identity ? this.db.prepare('SELECT json FROM articles WHERE identity_key=?').get(identity) : undefined;
    const linked = aliases.map(u => this.cached(u)).filter((a): a is Article => Boolean(a));
    for (const a of linked) {
      const priorIdentity = a.biz && a.mid && a.idx ? `${a.biz}|${a.mid}|${a.idx}` : null;
      if (identity && priorIdentity && identity !== priorIdentity) throw new WxError('IDENTITY_AMBIGUOUS', '已知链接指向不同文章身份，保留原归档');
      if (existing && a.article_id !== JSON.parse(existing.json as string).article_id) throw new WxError('IDENTITY_AMBIGUOUS', '身份与已有链接分别关联不同档案，需要核验后合并');
    }
    const cached = existing ? JSON.parse(existing.json as string) as Article : linked[0];
    if (cached) { draft.article_id = cached.article_id; draft.discovered_at = cached.discovered_at; }
    const { snapshot, ...article } = draft;
    const rel = path.join('articles', article.article_id, article.content_version); const root = inside(this.cfg.data_dir, rel);
    await mkdir(root, { recursive: true });
    await atomic(path.join(root, 'article.md'), article.markdown); await atomic(path.join(root, 'content.json'), JSON.stringify(article, null, 2)); await atomic(path.join(root, 'snapshot.html'), snapshot);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (article.account_id && article.biz) {
        this.db.prepare('INSERT INTO accounts VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET name=excluded.name').run(article.account_id, article.biz, article.account_name);
        this.db.prepare('INSERT OR IGNORE INTO account_provider_ids VALUES(?,?,?,?)').run(article.account_id, 'wechat_biz', article.biz, JSON.stringify({ article_id: article.article_id, canonical_url: article.canonical_url }));
      }
      this.db.prepare(`INSERT INTO articles(article_id,identity_key,canonical_url,account_id,title,account_name,published_at,fetched_at,body_text,json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET identity_key=COALESCE(excluded.identity_key,articles.identity_key),canonical_url=excluded.canonical_url,account_id=excluded.account_id,title=excluded.title,account_name=excluded.account_name,published_at=excluded.published_at,fetched_at=excluded.fetched_at,body_text=excluded.body_text,json=excluded.json,last_attempt=NULL`).run(article.article_id, identity, article.canonical_url, article.account_id, article.title, article.account_name, article.published_at, article.fetched_at, article.text, JSON.stringify(article));
      this.db.prepare('INSERT INTO article_versions VALUES(?,?,?,?) ON CONFLICT(article_id,version) DO UPDATE SET json=excluded.json').run(article.article_id, article.content_version, JSON.stringify(article), rel);
      for (const u of new Set([...aliases, article.canonical_url])) {
        const owner = this.db.prepare('SELECT article_id FROM article_urls WHERE url=?').get(u); if (owner && owner.article_id !== article.article_id) throw new WxError('IDENTITY_AMBIGUOUS', '链接已关联其他文章，拒绝自动合并');
        this.db.prepare('INSERT OR IGNORE INTO article_urls VALUES(?,?)').run(u, article.article_id);
      }
      this.db.exec('COMMIT'); return article;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  saveCandidate(c: Candidate) { this.db.prepare('INSERT OR REPLACE INTO discoveries VALUES(?,?,?)').run(c.candidate_id, Date.now() + this.cfg.search_cache.ttl_seconds * 1000, JSON.stringify(c)); }
  candidate(candidateId: string): Candidate { const r = this.db.prepare('SELECT * FROM discoveries WHERE candidate_id=?').get(candidateId); if (!r) throw new WxError('RESOURCE_NOT_FOUND', '搜索候选不存在'); if (Number(r.expires_at) < Date.now()) throw new WxError('SOURCE_UNAVAILABLE', '搜索候选已过期，请重新搜索'); return JSON.parse(r.json as string); }
  search(query: string, account?: string, from?: string, before?: string) {
    return this.db.prepare(`SELECT json FROM articles WHERE (instr(title,?)>0 OR instr(body_text,?)>0) AND (? IS NULL OR account_id=?) AND (? IS NULL OR published_at>=?) AND (? IS NULL OR published_at<?) ORDER BY fetched_at DESC,article_id ASC`).all(query, query, account ?? null, account ?? null, from ?? null, from ?? null, before ?? null, before ?? null).map(r => JSON.parse(r.json as string) as Article);
  }
  job(jobId: string): Job { const row = this.db.prepare('SELECT json FROM jobs WHERE job_id=?').get(jobId); if (!row) throw new WxError('RESOURCE_NOT_FOUND', '任务不存在'); return JSON.parse(row.json as string); }
  createJob(j: Job, params: unknown, key?: string): { job: Job; created: boolean } {
    const digest = hash(stable(params));
    if (key) { const r = this.db.prepare('SELECT json,params_hash FROM jobs WHERE idempotency_key=?').get(key); if (r) { if (r.params_hash !== digest) throw new WxError('CONFLICT', '幂等键已用于不同参数'); return { job: JSON.parse(r.json as string), created: false }; } }
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(j.job_id, j.kind, j.state, JSON.stringify(j), key ?? null, digest); this.saveJob(j); return { job: j, created: true };
  }
  saveJob(j: Job) {
    j.updated_at = now(); this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('UPDATE jobs SET state=?,json=? WHERE job_id=?').run(j.state, JSON.stringify(j), j.job_id); for (const item of j.items) this.db.prepare('INSERT OR REPLACE INTO job_items VALUES(?,?,?)').run(j.job_id, item.index, JSON.stringify(item)); this.db.prepare('INSERT OR REPLACE INTO checkpoints VALUES(?,?)').run(j.job_id, JSON.stringify(j.checkpoint)); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
