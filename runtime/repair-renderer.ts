/** Recover a persistently empty native page without restarting the app process. */
import {CdpClient,checkedSocket,evaluate,nativePageProbeSource,targetsAt,type Transport} from './injection-session.ts';
import {pathToFileURL} from 'node:url';

const pause = (ms:number) => new Promise<void>(resolve=>setTimeout(resolve,ms));

export async function repairEmptyRenderer(client:Transport, reloadEmpty:boolean, wait=pause) {
  const read = () => evaluate(client,nativePageProbeSource);
  const first = await read();
  if (!first.visibleNativeSurfaces) return {status:'unavailable',reloads:0};
  if (first.nativeContentReady) return {status:'healthy',reloads:0};
  if (!reloadEmpty) return {status:'empty',reloads:0};
  if (first.hasDraft) return {status:'blocked',reloads:0,reason:'An existing draft was preserved.'};
  // Let normal route loading finish, then recheck drafts immediately before reload.
  await wait(1200);
  const confirmed = await read();
  if (confirmed.nativeContentReady) return {status:'healthy',reloads:0};
  if (!confirmed.visibleNativeSurfaces) return {status:'unavailable',reloads:0};
  if (confirmed.hasDraft) return {status:'blocked',reloads:0,reason:'An existing draft was preserved.'};
  await client.call('Page.reload',{ignoreCache:false});
  for(let i=0;i<24;i++) {
    await wait(500);
    try {
      const current = await read();
      if (current.visibleNativeSurfaces && current.nativeContentReady) return {status:'recovered',reloads:1};
    } catch { /* The old JavaScript context may disappear while navigation finishes. */ }
  }
  return {status:'unresolved',reloads:1,reason:'The native page is still empty after one reload.'};
}

async function main() {
  let port=9335, reloadEmpty=false;
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--port') port=Number(args[++i]);
    else if(args[i]==='--reload-empty') reloadEmpty=true;
    else throw new Error('Usage: repair-renderer.ts [--port 9335] [--reload-empty]');
  }
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local debugging port');
  const primary=(await targetsAt(port)).filter(t=>t.type==='page'&&t.url==='app://-/index.html');
  if(primary.length!==1)throw new Error('Exactly one primary app renderer is required.');
  const client=await CdpClient.connect(checkedSocket(primary[0],port));
  try {
    const result=await repairEmptyRenderer(client,reloadEmpty);
    console.log(JSON.stringify(result,null,2));
    if(!['healthy','recovered'].includes(result.status))process.exitCode=1;
  } finally {client.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1});
