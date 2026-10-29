import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {nativePageProbeSource,type Transport} from './injection-session.ts';
import {repairEmptyRenderer} from './repair-renderer.ts';

const empty={nativeContentReady:false,blankNativeSurfaces:1,visibleNativeSurfaces:1,hasDraft:false};
const healthy={...empty,nativeContentReady:true,blankNativeSurfaces:0};
const draft={...empty,hasDraft:true};
const wait=async()=>{};
function transport(states:any[]) {
  const calls:string[]=[];let index=0;
  const client:Transport={close(){},async call(method){calls.push(method);return method==='Runtime.evaluate'?{result:{value:states[Math.min(index++,states.length-1)]}}:{}}};
  return {client,calls};
}
test('healthy pages are never reloaded',async()=>{
  const {client,calls}=transport([healthy]);assert.equal((await repairEmptyRenderer(client,true,wait)).status,'healthy');assert.equal(calls.includes('Page.reload'),false);
});
test('diagnosis alone never reloads an empty page',async()=>{
  const {client,calls}=transport([empty]);assert.equal((await repairEmptyRenderer(client,false,wait)).status,'empty');assert.equal(calls.includes('Page.reload'),false);
});
test('existing drafts prevent reloading',async()=>{
  const {client,calls}=transport([draft]);assert.equal((await repairEmptyRenderer(client,true,wait)).status,'blocked');assert.equal(calls.includes('Page.reload'),false);
});
test('a draft entered during the confirmation delay prevents reloading',async()=>{
  const {client,calls}=transport([empty,draft]);assert.equal((await repairEmptyRenderer(client,true,wait)).status,'blocked');assert.equal(calls.includes('Page.reload'),false);
});
test('normal route loading can finish without a reload',async()=>{
  const {client,calls}=transport([empty,healthy]);assert.equal((await repairEmptyRenderer(client,true,wait)).status,'healthy');assert.equal(calls.includes('Page.reload'),false);
});
test('an empty renderer recovers with exactly one reload',async()=>{
  const {client,calls}=transport([empty,empty,healthy]);assert.equal((await repairEmptyRenderer(client,true,wait)).status,'recovered');assert.equal(calls.filter(m=>m==='Page.reload').length,1);
});
test('a persistent native failure is reported without a reload loop',async()=>{
  const {client,calls}=transport([empty]);assert.equal((await repairEmptyRenderer(client,true,wait)).status,'unresolved');assert.equal(calls.filter(m=>m==='Page.reload').length,1);
});
test('empty visible native focus areas fail the page probe',()=>{
  const area={children:[],textContent:'',getBoundingClientRect:()=>({width:800}),closest:()=>null};
  const main={...area,querySelector:()=>area};
  const probe=runInNewContext(nativePageProbeSource,{document:{querySelectorAll:(s:string)=>s.includes('contenteditable')?[]:[main]},getComputedStyle:()=>({visibility:'visible'})});
  assert.equal(probe.nativeContentReady,false);assert.equal(probe.blankNativeSurfaces,1);
});
test('empty hidden cached pages do not fail the page probe, but their drafts are preserved',()=>{
  const main={getBoundingClientRect:()=>({width:0}),closest:()=>null};
  const probe=runInNewContext(nativePageProbeSource,{document:{querySelectorAll:(s:string)=>s.includes('contenteditable')?[{textContent:'unsent draft'}]:[main]},getComputedStyle:()=>({visibility:'visible'})});
  assert.equal(probe.nativeContentReady,true);assert.equal(probe.visibleNativeSurfaces,0);assert.equal(probe.hasDraft,true);
});
