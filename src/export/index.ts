import { copyFile, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../storage/index.js';
import type { Article, Job } from '../shared/model.js';
import { atomic, escapeHtml, inside, now } from '../shared/util.js';
export class Exporter {
  constructor(private store: Store) {}
  root(j: Job) { return inside(this.store.cfg.export_dir, j.config.export_id); }
  async manifest(j: Job, complete = false) {
    const root = this.root(j); await mkdir(root, { recursive: true });
    const manifest = { schema_version: '1.0', export_id: j.config.export_id, job_id: j.job_id, created_at: j.created_at, updated_at: now(), complete: complete && !(j.checkpoint.media_failures?.length), format: j.config.format, include_media: j.config.include_media, articles: j.config.articles, files: j.checkpoint.files ?? [], failures: j.items.filter(i => i.status === 'failed'), media_failures: j.checkpoint.media_failures ?? [] };
    await atomic(inside(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
    this.store.db.prepare('INSERT OR REPLACE INTO exports VALUES(?,?,?)').run(j.config.export_id, j.job_id, JSON.stringify(manifest));
    return { export_id: j.config.export_id, manifest_path: inside(root, 'manifest.json'), files: manifest.files, failures: manifest.failures, media_failures: manifest.media_failures, complete: manifest.complete };
  }
  async item(j: Job, a: Article): Promise<string[]> {
    const root = this.root(j); await mkdir(root, { recursive: true });
    const article: Article = structuredClone(a); const files: string[] = [];
    let markdown = article.markdown;
    if (j.config.include_media) {
      for (const asset of article.assets) {
        if (asset.status !== 'complete' || !asset.local_path) { if (asset.status === 'failed') { j.checkpoint.media_failures ??= []; j.checkpoint.media_failures.push({ article_id: a.article_id, url: asset.url, reason: 'source_media_not_downloaded' }); } delete asset.local_path; continue; }
        try {
          const source = await realpath(inside(this.store.cfg.data_dir, asset.local_path)); inside(this.store.cfg.data_dir, path.relative(this.store.cfg.data_dir, source));
          const rel = `media/${path.basename(asset.local_path)}`; const target = inside(root, rel); await mkdir(path.dirname(target), { recursive: true }); await copyFile(source, target); files.push(rel); markdown = markdown.split(asset.url).join(rel); asset.local_path = rel;
        } catch {
          j.checkpoint.media_failures ??= []; j.checkpoint.media_failures.push({ article_id: a.article_id, url: asset.url, reason: 'local_media_missing_or_unreadable' });
          asset.status = 'failed'; delete asset.local_path; article.warnings.push('export_media_incomplete');
        }
      }
    } else { for (const asset of article.assets) delete asset.local_path; }
    const stem = `${article.article_id}_${article.content_version}`;
    const metadata = { schema_version: '1.0', article_id: article.article_id, content_version: article.content_version, title: article.title, account_name: article.account_name, published_at: article.published_at, source_url: article.canonical_url, fetched_at: article.fetched_at, content_status: article.content_status, media_status: article.media_status, warnings: article.warnings };
    if (j.config.format === 'markdown') { const file = `${stem}.md`; await atomic(inside(root, file), `---\n${Object.entries(metadata).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n${markdown}\n`); files.push(file); }
    if (j.config.format === 'jsonl') { const file = `${stem}.jsonl`; await atomic(inside(root, file), JSON.stringify({ schema_version: '1.0', ...article, markdown }) + '\n'); files.push(file); }
    if (j.config.format === 'html') {
      const body = article.blocks.map(b => {
        if (b.type === 'image' && b.url) { const local = article.assets.find(a => a.url === b.url)?.local_path; return `<figure><img loading="lazy" src="${escapeHtml(local || b.url)}" alt="${escapeHtml(b.text)}"></figure>`; }
        const tag = b.type === 'heading' ? 'h2' : b.type === 'code' || b.type === 'table' ? 'pre' : b.type === 'quote' ? 'blockquote' : 'p'; return `<${tag} id="${b.block_id}">${escapeHtml(b.text || b.markdown)}</${tag}>`;
      }).join('\n');
      const file = `${stem}.html`; await atomic(inside(root, file), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: 'self'; style-src 'unsafe-inline'"><title>${escapeHtml(article.title || article.article_id)}</title><style>body{max-width:840px;margin:40px auto;padding:0 24px;line-height:1.8;font-family:system-ui}img{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${escapeHtml(article.title || '')}</h1><p>${escapeHtml(article.account_name || '')} ${escapeHtml(article.published_at || '')}</p><p><a href="${escapeHtml(article.canonical_url)}">原文</a></p>${body}</body></html>`); files.push(file);
    }
    return files;
  }
  async finish(j: Job) {
    if (j.config.format === 'jsonl') {
      const records: string[] = []; for (const f of j.checkpoint.files ?? []) if (f.endsWith('.jsonl')) records.push(await readFile(inside(this.root(j), f), 'utf8'));
      await atomic(inside(this.root(j), 'articles.jsonl'), records.join('')); j.checkpoint.files.push('articles.jsonl');
    }
    return this.manifest(j, !j.items.some(i => i.status === 'failed'));
  }
}
