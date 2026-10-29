/** CDP transport and session-owned injection. No theme design or app layout changes. */
export interface Target { id: string; title: string; type: string; url: string; webSocketDebuggerUrl: string }
export interface Transport { call(method: string, params?: Record<string, unknown>): Promise<any>; close(): void }
// The installed app also serves local files from app://fs. The avatar overlay
// is an app://- page, but its BrowserWindow needs a transparent background.
export const isAvatarOverlayTarget = (target: Target) => {
  if (target.type !== 'page' || !/^app:\/\/-(?:\/|$)/.test(target.url)) return false;
  try { return new URL(target.url).searchParams.get('initialRoute') === '/avatar-overlay'; }
  catch { return false; }
};
export const isAppTarget = (target: Target) => target.type === 'page' &&
  /^app:\/\/-(?:\/|$)/.test(target.url) && !isAvatarOverlayTarget(target);

/** Chromium may bind either loopback family, even with an IPv4 launch flag. */
export async function targetsAt(port: number, request: typeof fetch = fetch): Promise<Target[]> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local debugging port');
  const lists = await Promise.all(['127.0.0.1', '[::1]'].map(async host => {
    try {
      const response = await request(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(800) });
      if (!response.ok) return [];
      const value = await response.json();
      return Array.isArray(value) ? value.filter(target => target && typeof target.id === 'string' &&
        typeof target.type === 'string' && typeof target.url === 'string' && typeof target.webSocketDebuggerUrl === 'string') : [];
    } catch { return []; }
  }));
  // Prefer the app endpoint if another browser occupies the other address.
  return lists.find(list => list.some(isAppTarget)) ?? lists.find(list => list.length) ?? [];
}

export function checkedSocket(target: Target, port: number): string {
  const u = new URL(target.webSocketDebuggerUrl);
  if (u.protocol !== 'ws:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || Number(u.port) !== port ||
      u.username || u.password || u.search || u.hash || u.pathname !== `/devtools/page/${target.id}`) {
    throw new Error('Rejected non-local or mismatched CDP target endpoint');
  }
  return u.href;
}

export class CdpClient implements Transport {
  private nextId = 1;
  private pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private constructor(private socket: WebSocket) {
    socket.onmessage = event => {
      const m = JSON.parse(String(event.data));
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result ?? {});
    };
    socket.onerror = () => this.fail('CDP WebSocket error');
    socket.onclose = () => this.fail('CDP WebSocket closed');
  }
  private fail(message: string) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear();
  }
  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve,reject) => {
      const timer = setTimeout(() => {socket.close(); reject(new Error('CDP connect timeout'));}, 3000);
      socket.onopen = () => {clearTimeout(timer); resolve();};
      socket.onerror = socket.onclose = () => {clearTimeout(timer); reject(new Error('CDP connect failed'));};
    });
    return new CdpClient(socket);
  }
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 3000): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP is disconnected'));
    const id = this.nextId++;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`));}, timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try {this.socket.send(JSON.stringify({id,method,params}));} catch(error) {clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  close() { this.fail('CDP client closed'); this.socket.close(); }
}

/** An empty native focus area is a failed page render, even if CSS is installed. */
export const nativePageProbeSource = `(() => {
  const visible = node => node && node.getBoundingClientRect().width > 0 &&
    getComputedStyle(node).visibility !== 'hidden' && !node.closest('[inert]');
  const mains = [...document.querySelectorAll('main[data-app-shell-main-surface],main.main-surface,main[class*="_MainContentSurface_"]')].filter(visible);
  const blankNativeSurfaces = mains.filter(main => {
    const area = main.querySelector('[data-app-shell-focus-area="main"]');
    return visible(area) && area.children.length === 0 && !area.textContent.trim();
  }).length;
  // Include cached editors: a reload replaces the whole renderer, not one tab.
  const hasDraft = [...document.querySelectorAll('[contenteditable="true"]')].some(node => node.textContent.trim());
  return {nativeContentReady:blankNativeSurfaces===0,blankNativeSurfaces,visibleNativeSurfaces:mains.length,hasDraft};
})()`;

export const probeSource = `(() => {
  const nativePage = ${nativePageProbeSource};
  const style=document.getElementById('codexthemes-runtime-style');
  const runtime=globalThis.__codexThemesRuntime;
  const mains=[...document.querySelectorAll('main[data-app-shell-main-surface], main.main-surface, main[class*="_MainContentSurface_"]')];
  const main=mains.find(node=>node.getBoundingClientRect().width>0) || mains[0];
  const route=main?.querySelector('[data-settings-panel-slug]') ? 'settings' :
    main?.querySelector('[class~="group/home-composer-layout"]') ? 'home' :
    main?.querySelector('[class~="group/thread-scroll-layout"]') ? 'conversation' : 'auxiliary-or-system';
  let rules=0; try {rules=style?.sheet?.cssRules?.length || 0;} catch {}
  const surfaces=mains.map(node=>({page:node.dataset.codexthemesPage || null,visible:node.getBoundingClientRect().width>0,
    classified:node.classList.contains('main-surface') && node.dataset.codexthemesPage===
      (node.querySelector('[class~="group/home-composer-layout"]')?'home':node.querySelector('[class~="group/thread-scroll-layout"]')?'conversation':'system')}));
  const surfacesReady=surfaces.every(node=>node.classified) &&
    mains.every(node=>[...node.querySelectorAll('[data-composer-surface-variant],[class*="_ComposerLayoutRoot_"]')].every(composer=>composer.classList.contains('composer-surface-chrome')));
  return {themeId:document.documentElement.dataset.codexthemesTheme || null,
    stylePresent:!!style, styleMatches:!!runtime?.css && style?.textContent===runtime.css,
    styleEnabled:!!style?.sheet && !style.sheet.disabled, rules, route, readyState:document.readyState,
    revision:runtime?.revision || null,surfaces,surfacesReady,
    nativeContentReady:nativePage.nativeContentReady,blankNativeSurfaces:nativePage.blankNativeSurfaces};
})()`;

export function isInstalled(probe: any, themeId: string, revision?: string): boolean {
  return probe?.themeId === themeId && probe.stylePresent === true && probe.styleMatches === true &&
    probe.styleEnabled === true && probe.rules > 0 && probe.surfacesReady === true && (!revision || probe.revision === revision);
}
export async function evaluate(client: Transport, expression: string): Promise<any> {
  const result=await client.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

export class TargetSessions {
  private sessions = new Map<string,{client:Transport;identifier:string;url:string}>();
  constructor(private port:number, private source:string, private themeId:string, private revision:string,
    private connect:(url:string)=>Promise<Transport> = CdpClient.connect) {}
  async sync(targets:Target[]) {
    const eligible=targets.filter(isAppTarget);
    const ids=new Set(eligible.map(t=>t.id));
    for(const id of this.sessions.keys()) if(!ids.has(id)) await this.remove(id);
    const pages=await Promise.all(eligible.map(async target => {
      let client:Transport | undefined;
      try {
        const url=checkedSocket(target,this.port);
        let held=this.sessions.get(target.id);
        if(held && held.url!==url) {await this.remove(target.id);held=undefined;}
        if(!held) {
          client=await this.connect(url);
          await client.call('Page.enable');
          const registration=await client.call('Page.addScriptToEvaluateOnNewDocument',{source:this.source});
          if(!registration.identifier) throw new Error('CDP returned no script identifier');
          held={client,identifier:registration.identifier,url};
          this.sessions.set(target.id,held);
        }
        client=held.client;
        let probe=await evaluate(client,probeSource);
        if(!isInstalled(probe,this.themeId,this.revision)) {
          await evaluate(client,this.source);
          probe=await evaluate(client,probeSource);
        }
        return {targetId:target.id,url:target.url,title:target.title,...probe,verified:isInstalled(probe,this.themeId,this.revision)};
      } catch(error) {
        await this.remove(target.id); client?.close();
        return {targetId:target.id,url:target.url,title:target.title,themeId:null,verified:false,error:String(error)};
      }
    }));
    return {pages,registrations:[...this.sessions].map(([targetId,s])=>({targetId,identifier:s.identifier}))};
  }
  private async remove(id:string) {
    const held=this.sessions.get(id); if(!held) return;
    this.sessions.delete(id);
    try {await held.client.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:held.identifier});} catch {}
    held.client.close();
  }
  async close() {await Promise.all([...this.sessions.keys()].map(id=>this.remove(id)));}
}
