// Native integration fixture: synthetic allowed page, actual managed Chrome and cancellation path.
import { controlledWorker } from '../../src/browser/cancellation.js';
import { managedContext } from '../../src/browser/managed.js';
import { worker } from '../../src/browser/worker.js';
import { atomic, inside, failure } from '../../src/shared/util.js';
const input=JSON.parse(Buffer.from(process.argv[2]!,'base64url').toString());
try{
  const data=await controlledWorker(signal=>worker(input,async options=>{
    const browser=await managedContext(options,{dns:async()=>[{address:'93.184.215.14',family:4}],respond:()=>({responseCode:200,responseHeaders:[{name:'content-type',value:'text/html'}],body:Buffer.from('<div id="js_content"><p>synthetic body</p></div>').toString('base64')})});
    await atomic(inside(options.data_dir,'ready.json'),'{}');return browser;
  },signal));process.stdout.write(JSON.stringify({ok:true,data}));
}catch(e){process.stdout.write(JSON.stringify({ok:false,error:failure(e)}));process.exitCode=1;}
