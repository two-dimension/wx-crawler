import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_FEATURES, reviewPackId, verifyReview } from '../src/shared/acceptance.js';
test('human acceptance rejects an unchecked template, missing sample coverage and version substitutions', () => {
  // Synthetic verifier input only; this does not constitute a human acceptance result.
  const articles = Array.from({ length: 20 },(_,i)=>({ article_id:`art_${i}`,content_version:`v_${i}`,content_hash:`hash_${i}` })); const manifest = { pack_id: reviewPackId(articles), articles };
  const review = { schema_version:'1.0', pack_id:manifest.pack_id, reviewer:'synthetic-test',reviewed_at:'2026-10-30T00:00:00Z', articles:articles.map(a=>({ article_id:a.article_id,content_version:a.content_version,confirmed_accessible:false,title_matches:false,account_matches:false,published_verified_or_missing:false,blocks_match:false,features:[] as string[],notes:'' })) };
  assert.equal(verifyReview(review,manifest).ok,false);
  for(const a of review.articles) Object.assign(a,{confirmed_accessible:true,title_matches:true,account_matches:true,published_verified_or_missing:true,blocks_match:true});
  assert.equal(verifyReview(review,manifest).ok,false); review.articles[0]!.features=[...REVIEW_FEATURES]; assert.equal(verifyReview(review,manifest).ok,true);
  review.articles[0]!.blocks_match=false; assert.equal(verifyReview(review,manifest).ok,true); review.articles[1]!.blocks_match=false; assert.equal(verifyReview(review,manifest).ok,false);
  review.articles[1]!.content_version='wrong_version'; assert.throws(()=>verifyReview(review,manifest));
});
