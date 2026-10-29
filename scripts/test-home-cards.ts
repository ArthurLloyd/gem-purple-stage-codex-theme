// Render the real theme/runtime in an installed Chromium browser; no npm packages.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CdpClient, checkedSocket, evaluate, targetsAt } from '../runtime/injection-session.ts';
import { runtimeSource, inlineLocalAssets } from '../runtime/apply-theme.ts';
import { layoutProbeSource } from '../runtime/qa-layout.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const nativeDirectory = process.argv.includes('--native-fixture') ? path.resolve(option('--native-fixture')) : undefined;
const screenshots = process.argv.includes('--screenshots') ? path.resolve(option('--screenshots')) : undefined;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const browserCandidates = [
  process.argv.includes('--browser') ? option('--browser') : '',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
let browser: string | undefined;
for (const candidate of browserCandidates.filter(Boolean)) {
  try { await fs.access(candidate); browser = candidate; break; } catch {}
}
if (!browser) throw new Error('Home layout tests need installed Chrome/Edge; pass --browser with its executable path.');
const temporaryRoot = path.join(root, '.tmp');
await fs.mkdir(temporaryRoot, {recursive:true});
const profile = await fs.mkdtemp(path.join(temporaryRoot, 'home-cards-'));
if (screenshots) await fs.mkdir(screenshots, {recursive:true});
const themeDir = path.join(root, 'library/themes/gem-purple-stage-v3.1');
const css = process.argv.includes('--css')
  ? await inlineLocalAssets(await fs.readFile(path.resolve(option('--css')), 'utf8'), themeDir)
  : await fs.readFile(path.join(themeDir, 'theme.css'), 'utf8');
const nativeCss = nativeDirectory ? await fs.readFile(path.join(nativeDirectory, 'native.css'), 'utf8') : '';
const nativeFile = nativeDirectory && (await fs.readdir(nativeDirectory)).find(name => name.endsWith('-code.html'));
const nativeHtml = nativeFile ? await fs.readFile(path.join(nativeDirectory!, nativeFile), 'utf8') : '';
const rootAttributes = nativeDirectory ? JSON.parse(await fs.readFile(path.join(nativeDirectory, 'root.json'), 'utf8')) : {};
const minimalHome = `<main data-app-shell-main-surface="desktop"><div class="group/home-composer-layout">
  <div><div><h1 class="heading-xl"><span>今天想一起创造什么？</span></h1></div></div>
  <div><div class="thread-content-max-width"><div class="composer-surface-chrome" data-composer-surface-variant="default">
    <div class="fixture-rail">选择项目　　此计算机</div><div contenteditable="true" role="textbox"></div>
    <div class="fixture-controls">＋<span>极高　◉</span></div>
  </div></div></div>
</div></main>`;
const fixtureCss = `html,body{margin:0;height:100%;overflow:hidden}body{background:#100d19}
  #fixture-shell{position:relative;height:100vh;width:100vw;--fixture-sidebar:328px;--fixture-panel:0px}
  #fixture-shell>main{position:absolute!important;inset:42px 0 0 var(--fixture-sidebar)!important;width:auto!important;height:auto!important;min-width:0!important;display:flex!important;flex-direction:column}
  #fixture-shell>aside{position:absolute;left:0;top:42px;bottom:0;width:var(--fixture-sidebar);padding:24px;box-sizing:border-box}
  #fixture-mode{position:absolute;left:24px;top:58px;z-index:50;color:#f5effc;background:none;border:0;font-size:18px}
  [data-app-shell-tab-panel-controller="right"]{position:absolute!important;right:0;top:42px;bottom:0;width:var(--fixture-panel);pointer-events:none}
  [class~="group/home-composer-layout"]{height:100%;width:100%}
  .fixture-rail{height:32px;padding:8px 12px;box-sizing:border-box}
  .fixture-controls{display:flex;justify-content:space-between;padding:12px}
  .fixture-controls span{margin-left:auto}
  .fixture-rail~[contenteditable]{height:40px;padding:10px 12px;box-sizing:border-box}
  *{animation:none!important;transition:none!important}`;
// Only relax the protocol guard in this isolated test document, never production.
const source = runtimeSource('gem-purple-stage-v3-1', 'workspace', css)
  .replace("if (location.protocol !== 'app:' || location.host !== '-') return;", '');
const child = spawn(browser, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],
  {windowsHide:true,stdio:'ignore'});
let client: CdpClient | undefined;
let cases = 0;
const imageResults: Array<Record<string,unknown>> = [];
async function measureArtwork(client: CdpClient) {
  const geometry = await evaluate(client, `(async()=>{
    const group=document.querySelector('.gem-v3-cards').getBoundingClientRect();
    const clip={x:Math.floor(group.x),y:Math.floor(group.y),width:Math.ceil(group.right)-Math.floor(group.x),height:Math.ceil(group.bottom)-Math.floor(group.y),scale:1};
    const cards=[];
    for(const button of document.querySelectorAll('.gem-v3-cards button')) {
      const r=button.getBoundingClientRect(),s=getComputedStyle(button),photo=s.getPropertyValue('--gem-card-photo');
      const img=new Image();img.src=photo.slice(photo.indexOf('(')+1,photo.lastIndexOf(')')).trim().replaceAll('"','').replaceAll("'",'');await img.decode();
      const border=parseFloat(s.borderLeftWidth),height=r.height-parseFloat(s.borderTopWidth)-parseFloat(s.borderBottomWidth);
      const text=[...button.querySelectorAll('i,b,small')].filter(n=>getComputedStyle(n).display!=='none').map(n=>{
        const range=document.createRange();range.selectNodeContents(n);const t=range.getBoundingClientRect();
        return {x:t.x-clip.x,y:t.y-clip.y,w:t.width,h:t.height,color:getComputedStyle(n).color.match(/[0-9.]+/g).slice(0,3).map(Number)};
      });
      cards.push({x:r.x-clip.x,y:r.y-clip.y,w:r.width,h:r.height,edge:r.width-border-height*img.naturalWidth/img.naturalHeight,text});
    }
    const hide=document.createElement('style');hide.id='fixture-hide-card-text';hide.textContent='.gem-v3-cards :is(i,b,small){visibility:hidden!important}';document.head.append(hide);
    return {clip,cards};
  })()`);
  try {
    const shot = await client.call('Page.captureScreenshot', {format:'png',clip:geometry.clip});
    return await evaluate(client, `(async()=>{
      const bitmap=await createImageBitmap(await(await fetch(${JSON.stringify('data:image/png;base64,'+shot.data)})).blob());
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
      const pixels=ctx.getImageData(0,0,bitmap.width,bitmap.height).data;
      return ${JSON.stringify(geometry.cards)}.map(card=>{
        const start=Math.ceil(card.y+card.h*.25),end=Math.floor(card.y+card.h*.75);
        const column=x=>{
          const rgb=[0,0,0];x=Math.round(card.x+x);
          for(let y=start;y<end;y++){const i=(y*bitmap.width+x)*4;for(let c=0;c<3;c++)rgb[c]+=pixels[i+c]/(end-start);}
          return rgb;
        };
        const columns=[];for(let x=Math.ceil(card.w*.15);x<card.w*.45;x++)columns.push(column(x));
        const textureRange=[0,1,2].reduce((sum,c)=>sum+Math.max(...columns.map(p=>p[c]))-Math.min(...columns.map(p=>p[c])),0)/3;
        let seamStep=0;
        for(let x=Math.floor(card.edge)-3;x<=Math.ceil(card.edge)+3;x++) {
          if(x<2||x>=card.w-2)continue;
          const a=column(x),b=column(x+1);seamStep=Math.max(seamStep,a.reduce((sum,n,c)=>sum+Math.abs(n-b[c]),0)/3);
        }
        const luminance=rgb=>rgb.map(n=>{const v=n/255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)}).reduce((s,n,c)=>s+n*[.2126,.7152,.0722][c],0);
        let textContrast=100;
        for(const text of card.text) {
          const foreground=luminance(text.color);
          for(let y=Math.ceil(text.y);y<text.y+text.h;y++)for(let x=Math.ceil(text.x);x<text.x+text.w;x++) {
            if(x<0||y<0||x>=bitmap.width||y>=bitmap.height)continue;
            const i=(y*bitmap.width+x)*4,background=luminance([pixels[i],pixels[i+1],pixels[i+2]]);
            textContrast=Math.min(textContrast,(Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05));
          }
        }
        return {textureRange:Number(textureRange.toFixed(2)),seamStep:Number(seamStep.toFixed(2)),textContrast:Number(textContrast.toFixed(2))};
      });
    })()`);
  } finally {
    await evaluate(client, "document.getElementById('fixture-hide-card-text')?.remove()");
  }
}
try {
  let port = 0;
  for (let i=0; i<120 && !port; i++) {
    try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await delay(100);
  }
  assert.ok(port, 'Chromium started');
  let target;
  for (let i=0; i<20 && !target; i++) { target = (await targetsAt(port)).find(t => t.type==='page'); if (!target) await delay(100); }
  assert.ok(target, 'Chromium page is ready');
  client = await CdpClient.connect(checkedSocket(target, port));
  await client.call('Page.enable');
  for (const mode of ['code','chat']) {
    const html = `<!doctype html><html data-theme="dark" data-codex-window-type="electron"><head>
      <style>${nativeCss}</style><style>${fixtureCss}</style></head><body><div id="fixture-shell" data-app-shell>
      <aside class="app-shell-left-panel"></aside><button id="fixture-mode" aria-label="切换模式">${mode==='code'?'Codex':'ChatGPT'}</button>
      ${nativeHtml || minimalHome}<div data-app-shell-tab-panel-controller="right"></div></div></body></html>`;
    const frame = (await client.call('Page.getFrameTree')).frameTree.frame.id;
    await client.call('Page.setDocumentContent', {frameId:frame,html});
    await evaluate(client, `(() => {
      for (const [key,value] of Object.entries(${JSON.stringify(rootAttributes)})) document.documentElement.setAttribute(key,value);
      document.documentElement.style.setProperty('--codex-window-zoom','1');
      const main=document.querySelector('main');main.removeAttribute('inert');
      main.removeAttribute('style');
      main.querySelectorAll('.gem-v3-owned,.gem-v31-owned').forEach(n=>n.remove());
    })()`);
    await evaluate(client, source);
    await evaluate(client, 'document.fonts.ready.then(()=>true)');
    for (const [width,height,sidebar,panel] of [
      [1750,1000,328,0], [1408,836,328,0], [1215,812,328,0], [1100,842,328,0], [805,842,328,0],
      [820,600,328,0], [720,600,52,0], [620,520,52,0], [1440,640,328,0],
      [1750,1000,328,600], [1408,836,52,420], [480,720,52,0],
    ]) {
      await client.call('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
      await evaluate(client, `document.getElementById('fixture-shell').style.cssText='--fixture-sidebar:${sidebar}px;--fixture-panel:${panel}px'`);
      await delay(120);
      const result = await evaluate(client, layoutProbeSource);
      const cards = await evaluate(client, `(() => {
        const cards=document.querySelector('.gem-v3-cards'),s=getComputedStyle(cards),r=cards.getBoundingClientRect();
        const rect=n=>{const r=n?.getBoundingClientRect();return r&&{x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom};};
        return {mode:cards.dataset.composerMode,display:s.display,visibility:s.visibility,columns:s.gridTemplateColumns,rect:{x:r.x,y:r.y,w:r.width,h:r.height},scrollWidth:cards.scrollWidth,clientWidth:cards.clientWidth,heading:rect(document.querySelector('[data-gem-v31-home-heading]')),shell:rect(document.querySelector('.gem-v3-composer-shell')),main:rect(document.querySelector('main'))};
      })()`);
      const label = `${mode} ${width}x${height} sidebar=${sidebar} panel=${panel}`;
      assert.equal(cards.mode, mode, label+' uses correct shortcut prompts');
      assert.deepEqual(result.issues, [], label+': '+JSON.stringify({cards,result}));
      assert.equal(result.homeShortcutButtons, 4, label+' shows all four shortcuts: '+JSON.stringify(cards));
      assert.equal(cards.display, 'grid', label+' uses a grid');
      const hoverPoint = await evaluate(client, `(() => {const r=document.querySelector('.gem-v3-cards button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await client.call('Input.dispatchMouseEvent', {type:'mouseMoved',...hoverPoint});
      const hovered = await evaluate(client, layoutProbeSource);
      assert.deepEqual(hovered.issues, [], label+' hover remains visible and unobstructed');
      await client.call('Input.dispatchMouseEvent', {type:'mouseMoved',x:0,y:0});
      if ([805,1215,1750].includes(width) && panel===0) {
        const artwork = await measureArtwork(client);
        for (const [index,metric] of artwork.entries()) {
          imageResults.push({case:label,card:index+1,...metric});
          assert.ok(metric.textureRange>=2,label+' card '+(index+1)+' has photographic texture behind the left text area: '+JSON.stringify(metric));
          assert.ok(metric.seamStep<=7,label+' card '+(index+1)+' blends at the photo edge: '+JSON.stringify(metric));
          assert.ok(metric.textContrast>=4.5,label+' card '+(index+1)+' keeps text readable over the photograph: '+JSON.stringify(metric));
        }
      }
      if (screenshots && [620,805,1100,1215,1750].includes(width)) {
        const shot = await client.call('Page.captureScreenshot', {format:'png'});
        await fs.writeFile(path.join(screenshots,`${mode}-${width}-${panel}.png`),Buffer.from(shot.data,'base64'));
      }
      cases++;
    }
    const prompts = await evaluate(client, `(() => {
      const editor=document.querySelector('.composer-surface-chrome [contenteditable="true"]');
      return [...document.querySelectorAll('.gem-v3-cards button')].map(button=>{
        editor.textContent='';button.click();return editor.textContent;
      });
    })()`);
    assert.equal(new Set(prompts).size,4, mode+' actions insert four distinct prompts');
    assert.ok(prompts.every((p: string)=>p.startsWith('帮我')),mode+' actions insert prompts into the editor');
  }
  console.log(`Home shortcut layout: ${cases} browser cases, 8 action checks and ${imageResults.length} artwork pixel checks passed (${nativeDirectory?'native fixture':'isolated fixture'}).`);
} finally {
  if (process.argv.includes('--image-report')) await fs.writeFile(path.resolve(option('--image-report')),JSON.stringify(imageResults,null,2));
  if (client) { try { await client.call('Browser.close'); } catch {} client.close(); } else child.kill();
  await delay(300);
  assert.ok(profile.startsWith(temporaryRoot+path.sep),'Browser cleanup remains in .tmp');
  await fs.rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:200});
}
