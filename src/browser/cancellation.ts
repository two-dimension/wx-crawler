import { WxError } from '../shared/util.js';
// A graceful stdin control channel lets the worker close Chrome before Windows terminates it.
export async function controlledWorker<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller=new AbortController();
  const cancel=()=>controller.abort(new WxError('CANCELLED','浏览器操作已取消'));
  let text='';const data=(chunk:Buffer)=>{text+=chunk.toString();if(text.includes('cancel'))cancel();if(text.length>64)text=text.slice(-64);};
  process.stdin.on('data',data);process.stdin.once('end',cancel);
  try{return await run(controller.signal);}
  finally{process.stdin.removeListener('data',data);process.stdin.removeListener('end',cancel);process.stdin.pause();}
}
