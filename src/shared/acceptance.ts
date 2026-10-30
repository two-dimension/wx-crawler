import { z } from 'zod';
import { hash, stable, WxError } from './util.js';
export const REVIEW_FEATURES = ['long_article','image','table','code','external_link','repost','multi_article','image_only','unsupported_content','missing_metadata'] as const;
export const reviewSchema = z.object({
  schema_version: z.literal('1.0'), pack_id: z.string(), reviewer: z.string().trim().min(1), reviewed_at: z.iso.datetime({ offset: true }),
  articles: z.array(z.object({ article_id: z.string(), content_version: z.string(), confirmed_accessible: z.boolean(), title_matches: z.boolean(), account_matches: z.boolean(), published_verified_or_missing: z.boolean(), blocks_match: z.boolean(), features: z.array(z.enum(REVIEW_FEATURES)), notes: z.string() }).strict()).min(20)
}).strict();
export type HumanReview = z.infer<typeof reviewSchema>;
export type ReviewManifest = { pack_id: string; articles: { article_id: string; content_version: string; content_hash: string }[] };
export function reviewPackId(articles: ReviewManifest['articles']) { return `review_${hash(stable(articles)).slice(0,24)}`; }
export function verifyReview(raw: unknown, manifest: ReviewManifest) {
  const review = reviewSchema.parse(raw);
  if (review.pack_id !== manifest.pack_id) throw new WxError('INVALID_INPUT', '人工验收结果不属于此版本清单');
  const expected = new Set(manifest.articles.map(a => `${a.article_id}/${a.content_version}`)); const seen = new Set<string>();
  for (const a of review.articles) { const key = `${a.article_id}/${a.content_version}`; if (!expected.has(key) || seen.has(key)) throw new WxError('INVALID_INPUT', '人工验收包含未知版本或重复文章'); seen.add(key); }
  const accessible = review.articles.filter(a => a.confirmed_accessible);
  const accurate = accessible.filter(a => a.title_matches && a.account_matches && a.published_verified_or_missing && a.blocks_match);
  const features = new Set(accessible.flatMap(a => a.features)); const missing_features = REVIEW_FEATURES.filter(f => !features.has(f));
  return { ok: accessible.length >= 20 && accurate.length / accessible.length >= 0.95 && !missing_features.length, reviewer: review.reviewer, reviewed_at: review.reviewed_at, reviewed_count: review.articles.length, accessible_count: accessible.length, accurate_count: accurate.length, accuracy: accessible.length ? accurate.length / accessible.length : 0, missing_features, article_failures: review.articles.filter(a => !a.confirmed_accessible || !a.title_matches || !a.account_matches || !a.published_verified_or_missing || !a.blocks_match) };
}
