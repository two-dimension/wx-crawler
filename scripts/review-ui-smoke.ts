import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { atomic, inside, now } from '../src/shared/util.js';
const cfg=await loadConfig();const root=inside(cfg.data_dir,'acceptance');
const html=await readFile(inside(root,'review.html'),'utf8');const manifest=JSON.parse(await readFile(inside(root,'manifest.json'),'utf8'));
const browser=await chromium.launch({channel:cfg.browser.channel,headless:true});
try{
  const context=await browser.newContext({acceptDownloads:true,serviceWorkers:'block'});await context.route('**/*',route=>route.abort('blockedbyclient'));
  const page=await context.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(html,{waitUntil:'domcontentloaded'});
  assert.equal(await page.locator('section').count(),manifest.articles.length);assert.equal(await page.locator('[data-field]:checked').count(),0);
  await page.locator('#reviewer').fill('自动化界面测试，不是人工核对');
  const download=page.waitForEvent('download');await page.locator('#download').click();const result=await download;
  const file=await result.path();assert.ok(file);const payload=JSON.parse(await readFile(file,'utf8'));
  assert.equal(payload.pack_id,manifest.pack_id);assert.ok(payload.articles.every((a:any)=>!a.confirmed_accessible&&!a.blocks_match));assert.deepEqual(errors,[]);
  await atomic(inside(root,'ui-smoke-report.json'),JSON.stringify({checked_at:now(),ok:true,articles:manifest.articles.length,initial_checked:0,download_schema_version:payload.schema_version,human_reviewed:false,automated_only:true},null,2));
  process.stdout.write(JSON.stringify({ok:true,articles:manifest.articles.length,human_reviewed:false})+'\n');
}finally{await browser.close();}
