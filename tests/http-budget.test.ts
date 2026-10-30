import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PublicHttp, publicIP } from '../src/providers/http.js';
import { loadConfig } from '../src/config/index.js';
test('failed or oversized media transfers consume the shared byte budget and stop subsequent network requests', async () => {
  const config=await loadConfig();config.request.interval_ms=0;const http=new PublicHttp(config);const original=https.get;let calls=0;
  // Controlled transport stream; no network connection is made in this test.
  (https as any).get=(_url:any,_options:any,callback:any)=>{
    calls++;const req:any=new EventEmitter();req.setTimeout=()=>{};req.destroyed=false;req.destroy=(error:any)=>{req.destroyed=true;req.emit('error',error);};
    queueMicrotask(()=>{const res:any=new EventEmitter();res.headers={'content-type':'image/png'};res.statusCode=200;callback(res);res.emit('data',Buffer.alloc(4));if(!req.destroyed)res.emit('data',Buffer.alloc(4));if(!req.destroyed)res.emit('end');});return req;
  };
  try{const budget={bytes:0,max_bytes:6};await assert.rejects(http.get('https://mmbiz.qpic.cn/a.png','media',undefined,budget));assert.equal(budget.bytes,6);await assert.rejects(http.get('https://mmbiz.qpic.cn/b.png','media',undefined,budget));assert.equal(calls,1);}
  finally{https.get=original;}
});
test('documentation and reserved/transition address ranges are not treated as public destinations',()=>{
  for(const ip of ['192.0.0.1','192.0.2.1','192.88.99.1','198.51.100.1','203.0.113.1','2001:db8::1','2001:0:1234::1','2002:7f00:1::'])assert.equal(publicIP(ip),false,ip);
  assert.equal(publicIP('2001:4860:4860::8888'),true);assert.equal(publicIP('240e::1'),true);
});
