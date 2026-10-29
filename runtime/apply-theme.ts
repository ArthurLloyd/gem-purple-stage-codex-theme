#!/usr/bin/env -S npx tsx

import { createHash, randomUUID } from 'node:crypto';
import { CdpClient, TargetSessions, probeSource, isInstalled, isAppTarget, isAvatarOverlayTarget, evaluate, checkedSocket, targetsAt } from './injection-session.ts';
import { closeSync, openSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { validateTheme } from './validate-theme.ts';
import { runtimeStatePath, stateRoot } from './paths.ts';
import { installSidebarPeek } from './sidebar-peek.ts';

type Command = 'apply' | 'restore' | 'status' | 'watch';

interface Options {
  command: Command;
  themeDir?: string;
  port: number;
  launch: boolean;
  /** Force a clean quit+relaunch even when a debugging endpoint is already live. */
  relaunch: boolean;
  app?: string;
  /** Internal: run the quit/relaunch/inject sequence inline (used by the detached helper). */
  worker: boolean;
  watchToken?: string;
}

interface Target {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface Registration {
  targetId: string;
  identifier: string;
}

interface RuntimeState {
  port: number;
  themeId: string;
  registrations?: Registration[];
  /** Legacy single-target fields kept for compatibility with older applies. */
  targetId?: string;
  scriptIdentifier?: string;
  watcherToken?: string;
  pages?: unknown[];
}

const execFileAsync = promisify(execFile);
const statePath = runtimeStatePath();
const legacyStatePath = path.join(os.homedir(), '.codexthemes', 'runtime.json');
const defaultPorts = [9335, 9222, 9223];

function parseArgs(argv: string[]): Options {
  const command = argv.shift() as Command | undefined;
  if (!command || !['apply', 'restore', 'status', 'watch'].includes(command)) {
    throw new Error('Usage: apply-theme.ts <apply THEME_DIR|restore|status> [--port 9335] [--launch] [--relaunch] [--app /Applications/Codex.app]');
  }

  const options: Options = { command, port: 9335, launch: false, relaunch: false, worker: false };
  if ((command === 'apply' || command === 'watch') && argv[0] && !argv[0].startsWith('--')) {
    options.themeDir = path.resolve(argv.shift()!);
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      const port = Number(argv[++index]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be between 1024 and 65535');
      options.port = port;
    } else if (arg === '--launch') {
      options.launch = true;
    } else if (arg === '--relaunch') {
      options.relaunch = true;
    } else if (arg === '--launch-worker') {
      options.worker = true;
    } else if (arg === '--watch-token') {
      options.watchToken = argv[++index];
    } else if (arg === '--app') {
      const app = argv[++index];
      if (!app) throw new Error('--app requires a path');
      options.app = path.resolve(app);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (command === 'apply' && !options.themeDir) throw new Error('apply requires an absolute theme directory');
  if (command === 'watch' && (!options.watchToken || !options.themeDir)) throw new Error('Internal watcher needs theme and token');
  return options;
}

async function readJson<T>(filename: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeState(state: RuntimeState): Promise<void> {
  await atomicJson(statePath, state);
}

async function clearState(): Promise<void> {
  await fs.rm(statePath, { force: true });
  if (!process.env.CODEX_THEMES_HOME) await fs.rm(legacyStatePath, { force: true });
}

async function readRuntimeState(): Promise<RuntimeState | undefined> {
  return (await readJson<RuntimeState>(statePath)) ?? (await readJson<RuntimeState>(legacyStatePath));
}

function appPages(targets: Target[]): Target[] {
  return targets.filter(isAppTarget);
}

async function locateTargets(preferredPort: number): Promise<{ port: number; targets: Target[] } | undefined> {
  for (const port of [...new Set([preferredPort, ...defaultPorts])]) {
    const pages = appPages(await targetsAt(port));
    if (pages.length > 0) return { port, targets: pages };
  }
  return undefined;
}

function stateRegistrations(state: RuntimeState | undefined): Registration[] {
  if (!state) return [];
  if (state.registrations?.length) return state.registrations;
  if (state.targetId && state.scriptIdentifier) return [{ targetId: state.targetId, identifier: state.scriptIdentifier }];
  return [];
}

async function detectMacApp(explicit?: string): Promise<string> {
  const candidates = explicit ? [explicit] : ['/Applications/Codex.app', '/Applications/ChatGPT.app'];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* try the next candidate */ }
  }
  throw new Error('Cannot find Codex.app or ChatGPT.app; pass --app with the application path');
}

async function detectWindowsApp(explicit?: string): Promise<string> {
  if (explicit) {
    await fs.access(explicit);
    return explicit;
  }
  // Prefer the path of a running instance — it works for every install kind.
  for (const name of ['Codex', 'ChatGPT']) {
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-Command',
        `(Get-Process -Name ${name} -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1).Path`,
      ]);
      const found = stdout.trim();
      if (found) return found;
    } catch { /* try the next name */ }
  }
  const local = process.env.LOCALAPPDATA;
  const candidates = local ? [
    path.join(local, 'Programs', 'Codex', 'Codex.exe'),
    path.join(local, 'Programs', 'ChatGPT', 'ChatGPT.exe'),
    path.join(local, 'Microsoft', 'WindowsApps', 'Codex.exe'),
    path.join(local, 'Microsoft', 'WindowsApps', 'ChatGPT.exe'),
  ] : [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* try the next candidate */ }
  }
  throw new Error('Cannot find the Codex/ChatGPT executable; pass --app with the full path to the .exe');
}

async function mainProcessRunning(app: string): Promise<boolean> {
  if (process.platform === 'win32') {
    const image = path.basename(app);
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${image}`]);
      return stdout.toLowerCase().includes(image.toLowerCase());
    } catch {
      return false;
    }
  }
  try {
    await execFileAsync('pgrep', ['-f', `${app}/Contents/MacOS/`]);
    return true;
  } catch {
    return false;
  }
}

async function quitAndWait(app: string): Promise<void> {
  const appName = path.basename(app, process.platform === 'win32' ? '.exe' : '.app');
  if (process.platform === 'win32') {
    // Graceful close (no /F): the app must exit cleanly, not be killed.
    await execFileAsync('taskkill', ['/IM', path.basename(app)]).catch(() => undefined);
  } else {
    await execFileAsync('osascript', ['-e', `tell application ${JSON.stringify(appName)} to quit`]).catch(() => undefined);
  }
  // The debugging flags only take effect on a fresh instance. If the old
  // instance is still shutting down it holds the Chromium profile singleton
  // lock, and the relaunched instance silently defers to it and exits, so the
  // app comes back WITHOUT the debugging endpoint. Wait for a real exit.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (!(await mainProcessRunning(app))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${appName} did not quit within 45s. Quit it manually, then rerun apply with --launch.`);
}

const debugFlags = (port: number) => ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`];

async function launchWithDebugging(port: number, explicitApp?: string): Promise<string> {
  if (process.platform === 'darwin') {
    const app = await detectMacApp(explicitApp);
    await quitAndWait(app);
    const child = spawn('open', ['-na', app, '--args', ...debugFlags(port)], { detached: true, stdio: 'ignore' });
    child.unref();
    return app;
  }
  if (process.platform === 'win32') {
    const app = await detectWindowsApp(explicitApp);
    await quitAndWait(app);
    const child = spawn(app, debugFlags(port), { detached: true, stdio: 'ignore' });
    child.unref();
    return app;
  }
  throw new Error('--launch supports macOS and Windows. Start Codex with --remote-debugging-address=127.0.0.1 and --remote-debugging-port manually, then rerun without --launch.');
}

async function mainProcessCommandLine(app: string): Promise<string> {
  try {
    if (process.platform === 'win32') {
      const image = path.basename(app);
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "Name='${image}'" | Select-Object -First 1).CommandLine`,
      ]);
      return stdout.trim();
    }
    const { stdout } = await execFileAsync('pgrep', ['-fl', `${app}/Contents/MacOS/`]);
    return stdout.split('\n')[0] ?? '';
  } catch {
    return '';
  }
}

/** Turn a silent endpoint timeout into a definite, actionable diagnosis. */
async function launchDiagnostics(app: string): Promise<string> {
  if (!(await mainProcessRunning(app))) {
    return 'Diagnosis: the app is NOT running after the relaunch — launching it failed. Verify the application path (pass --app explicitly) and launch it manually once to check it starts at all.';
  }
  const commandLine = await mainProcessCommandLine(app);
  if (commandLine.includes('--remote-debugging-port')) {
    return 'Diagnosis: the app is running WITH the debugging flags on its command line but never opened the endpoint — this build ignores or strips --remote-debugging-port (common for store-packaged builds). This installation cannot be themed; report that limitation plainly instead of retrying.';
  }
  return 'Diagnosis: the app is running WITHOUT the debugging flags — an old instance held the profile singleton lock during the relaunch and the flagged instance deferred to it and exited. Retry with: apply ... --launch --relaunch';
}

async function waitForTargetsOrDiagnose(app: string, port: number): Promise<{ port: number; targets: Target[] }> {
  try {
    return await waitForTargets(port);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${await launchDiagnostics(app)}`);
  }
}

async function waitForTargets(port: number, timeoutMs = 30_000): Promise<{ port: number; targets: Target[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await locateTargets(port);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Codex did not expose a debuggable app page on loopback port ${port} (127.0.0.1 or ::1). ` +
    'If the app is running, either an old instance was still holding the profile lock during relaunch, or this build ignores --remote-debugging-port.',
  );
}

function mimeType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.woff2') return 'font/woff2';
  throw new Error(`Unsupported local CSS asset: ${extension || filename}`);
}

export async function inlineLocalAssets(css: string, themeDir: string): Promise<string> {
  const matches = [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)];
  let output = css;
  for (const match of matches) {
    const reference = match[2]!.trim();
    if (/^(?:data:|blob:|#)/i.test(reference)) continue;
    if (/^(?:https?:|\/\/|file:)/i.test(reference)) throw new Error(`External CSS asset is not allowed: ${reference}`);
    const filename = path.resolve(themeDir, reference);
    if (!filename.startsWith(`${themeDir}${path.sep}`)) throw new Error(`CSS asset escapes the theme directory: ${reference}`);
    const data = await fs.readFile(filename);
    const dataUrl = `data:${mimeType(filename)};base64,${data.toString('base64')}`;
    output = output.replaceAll(match[0], `url("${dataUrl}")`);
  }
  return output;
}

export function runtimeRevision(css: string): string {
  // DOM adapters must be refreshed even when the generated CSS is unchanged.
  return createHash('sha256').update(runtimeSource.toString()).update(installSidebarPeek.toString()).update(css).digest('hex');
}

export function runtimeSource(themeId: string, backgroundScope: string, css: string): string {
  const revision = runtimeRevision(css);
  const config = JSON.stringify({ themeId, backgroundScope, css, revision });
  return `(() => {
    if (location.protocol !== 'app:' || location.host !== '-') return;
    if (new URLSearchParams(location.search).get('initialRoute') === '/avatar-overlay') return;
    const config = ${config};
    const key = '__codexThemesRuntime';
    const styleId = 'codexthemes-runtime-style';
    const clear = () => {
      const previous = globalThis[key];
      previous?.sidebarPeek?.dispose();
      if (previous?.pendingInstall) document.removeEventListener('DOMContentLoaded', previous.pendingInstall);
      if (previous?.observer) previous.observer.disconnect();
      if (previous?.layoutObserver) previous.layoutObserver.disconnect();
      if (previous?.schedule) { window.removeEventListener('resize', previous.schedule); document.removeEventListener('visibilitychange', previous.schedule); }
      if (previous?.frame) {
        if (previous.timerBased) clearTimeout(previous.frame);
        else cancelAnimationFrame(previous.frame);
      }
      document.getElementById(styleId)?.remove();
      delete document.documentElement.dataset.codexthemesTheme;
      delete document.documentElement.dataset.codexthemesBackgroundScope;
      document.querySelectorAll('[data-codexthemes-owned-main]').forEach((node) => { node.classList.remove('main-surface'); node.removeAttribute('data-codexthemes-owned-main'); });
      document.querySelectorAll('[data-codexthemes-owned-composer]').forEach((node) => { node.classList.remove('composer-surface-chrome'); node.removeAttribute('data-codexthemes-owned-composer'); });
      document.querySelectorAll('[data-codexthemes-page]').forEach((node) => node.removeAttribute('data-codexthemes-page'));
      document.querySelectorAll('[data-gem-v31-home-browser],[data-gem-v31-browser-expanded],[data-gem-v31-browser-frame],[data-gem-v31-browser-scroll],[data-gem-v31-suggestion-list]').forEach(node => {
        ['data-gem-v31-home-browser','data-gem-v31-browser-expanded','data-gem-v31-browser-frame','data-gem-v31-browser-scroll','data-gem-v31-suggestion-list'].forEach(name => node.removeAttribute(name));
      });
      document.querySelectorAll('[data-gem-v31-browser-tabstop]').forEach(node => {node.removeAttribute('tabindex');node.removeAttribute('data-gem-v31-browser-tabstop');});
      document.querySelectorAll('[data-gem-v31-panel-open]').forEach((node) => { node.removeAttribute('data-gem-v31-panel-open'); node.style.removeProperty('--gem-v31-usable-width'); });
      document.querySelectorAll('[data-gem-v31-home-cards-hidden],[data-gem-v31-home-heading-hidden]').forEach((node) => { node.removeAttribute('data-gem-v31-home-cards-hidden'); node.removeAttribute('data-gem-v31-home-heading-hidden'); });
      document.querySelectorAll('[data-gem-v31-home-heading],[data-gem-v31-home-composer],[data-gem-v31-polaroid-hidden]').forEach((node) => {
        node.removeAttribute('data-gem-v31-home-heading'); node.removeAttribute('data-gem-v31-home-composer'); node.removeAttribute('data-gem-v31-polaroid-hidden');
      });
      document.querySelectorAll('main').forEach((node) => node.style.removeProperty('--gem-v31-home-cards-bottom'));
      document.querySelectorAll('[data-gem-v31-home-intro],[data-gem-v31-animated-headline]').forEach((node) => {
        node.removeAttribute('data-gem-v31-home-intro'); node.removeAttribute('data-gem-v31-animated-headline');
        node.style.removeProperty('--gem-v31-headline-height');
      });
      document.querySelectorAll('[data-thread-scroll-footer="true"]').forEach((node) => {
        node.style.removeProperty('--gem-v31-scroll-offset');
        node.style.removeProperty('--gem-v31-footer-left');
        node.style.removeProperty('--gem-v31-footer-width');
        node.style.removeProperty('--gem-v31-footer-bottom');
      });
      document.querySelectorAll('[data-gem-v31-original-placeholder]').forEach((node) => { node.setAttribute('data-placeholder', node.getAttribute('data-gem-v31-original-placeholder') || ''); node.removeAttribute('data-gem-v31-original-placeholder'); });
      document.querySelectorAll('.gem-v3-owned,.gem-v31-owned').forEach((node) => node.remove());
      document.querySelectorAll('.gem-v31-directory-open').forEach((node) => node.classList.remove('gem-v31-directory-open'));
      document.querySelectorAll('.gem-v3-composer-shell,.gem-v3-conversation-composer-shell').forEach((node) => { node.classList.remove('gem-v3-composer-shell','gem-v3-conversation-composer-shell'); });
      document.querySelectorAll('[data-gem-v3-original-text]').forEach((node) => { node.textContent = node.getAttribute('data-gem-v3-original-text'); node.removeAttribute('data-gem-v3-original-text'); });
    };
    const install = () => {
      clear();
      const root = document.documentElement;
      root.dataset.codexthemesTheme = config.themeId;
      root.dataset.codexthemesBackgroundScope = config.backgroundScope;
      const style = document.createElement('style');
      style.id = styleId;
      style.dataset.codexthemesOwned = 'true';
      style.textContent = config.css;
      (document.head || root).appendChild(style);
      const polaroid = (host) => {
        if (host.querySelector(':scope > .gem-v3-polaroid')) return;
        const card = document.createElement('div');
        card.className = 'gem-v3-polaroid gem-v3-owned';
        card.setAttribute('role', 'img');
        card.setAttribute('aria-label', 'G.E.M. portrait, Dear Gloria');
        const caption = document.createElement('span');
        caption.textContent = 'Dear Gloria  ♡';
        card.append(caption);
        host.append(card);
      };
      // Follow the heading/editor to their layout slots instead of child indexes.
      // Recent builds wrap Home's slots in a display:contents node.
      const homeSlot = (home, node, peer) => {
        if (!node) return;
        while (node.parentElement && node.parentElement !== home) {
          if (peer && node.parentElement.contains(peer)) break;
          if (node.parentElement.classList.contains('contents') && node.parentElement.parentElement === home) break;
          node = node.parentElement;
        }
        return node.parentElement ? node : undefined;
      };
      const enhanceV3 = (main, page) => {
        const isV31 = config.themeId === 'gem-purple-stage-v3-1';
        if (config.themeId !== 'gem-purple-stage-v3' && !isV31) return;
        if (isV31) {
          document.querySelectorAll('[data-codex-terminal="true"]').forEach((terminal) => {
            const directory = terminal.querySelector('[role="group"][aria-label="终端源目录"]');
            if (!directory || terminal.querySelector(':scope > .gem-v31-directory-toggle')) return;
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'gem-v31-directory-toggle gem-v31-owned';
            toggle.textContent = '目录';
            toggle.setAttribute('aria-label', '显示终端源目录');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.addEventListener('click', () => {
              const open = terminal.classList.toggle('gem-v31-directory-open');
              toggle.setAttribute('aria-expanded', String(open));
              toggle.setAttribute('aria-label', open ? '隐藏终端源目录' : '显示终端源目录');
            });
            toggle.addEventListener('keydown', (event) => {
              if (event.key === 'Escape') {
                terminal.classList.remove('gem-v31-directory-open');
                toggle.setAttribute('aria-expanded', 'false');
                toggle.setAttribute('aria-label', '显示终端源目录');
              }
            });
            terminal.append(toggle);
          });
          const nav = [...document.querySelectorAll('aside.app-shell-left-panel button.sidebar-item')];
          const marks = [
            ['新对话', '<path d="M1 8h2m2-3v6m3-9v12m3-9v6m2-4h2"/>'],
            ['插件', '<path d="M6 12V4l8-2v8"/><circle cx="4" cy="13" r="2"/><circle cx="12" cy="11" r="2"/>'],
            ['探索', '<path d="m8 1 1.6 5.4L15 8l-5.4 1.6L8 15l-1.6-5.4L1 8l5.4-1.6L8 1Z"/>']
          ];
          for (const [label, shape] of marks) {
            const button = nav.find((node) => node.textContent?.trim() === label);
            if (!button || button.querySelector(':scope > .gem-v31-nav-mark')) continue;
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.classList.add('gem-v31-nav-mark', 'gem-v31-owned');
            svg.setAttribute('viewBox', '0 0 16 16');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1.2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('aria-hidden', 'true');
            svg.setAttribute('focusable', 'false');
            svg.innerHTML = shape;
            button.append(svg);
          }
        }
        if (page !== 'home') {
          main.querySelectorAll('.gem-v3-cards,.gem-v31-portrait,.gem-v31-home-polaroid,.gem-v31-browser-back').forEach((node) => node.remove());
          main.removeAttribute('data-gem-v31-home-browser');
          main.removeAttribute('data-gem-v31-browser-expanded');
        }
        const composer = main.querySelector('.composer-surface-chrome');
        if (page === 'home') {
          if (isV31 && !main.querySelector('.gem-v31-portrait')) {
            const portrait = document.createElement('div');
            portrait.className = 'gem-v31-portrait gem-v31-owned';
            portrait.setAttribute('aria-hidden', 'true');
            main.append(portrait);
          }
          const home = main.querySelector('[class~="group/home-composer-layout"]');
          const heading = home?.querySelector('.heading-xl');
          // ChatGPT animates a visible headline over an inert sizing copy.
          // Keep decorations outside that anchor so its bottom stays on the title.
          const animatedHeadline = heading?.matches('[aria-hidden="true"]') &&
            heading.parentElement.querySelectorAll('.heading-xl').length > 1;
          const headline = animatedHeadline ? heading.parentElement : heading;
          const intro = headline?.parentElement;
          const headingSlot = home && homeSlot(home, heading, composer);
          const composerSlot = home && homeSlot(home, composer, heading);
          const customHome = !home?.querySelector('[data-expanded-composer],[data-homepage-takeover],[data-home-inline-preview]');
          const shell = composer?.closest('[class*="thread-content-max-width"]');
          // Image templates and nested suggestions expand inside the composer
          // shell without the native takeover attributes. Bound that content
          // separately so the bottom-anchored Home shell cannot grow offscreen.
          const gallery = shell?.querySelector('[role="tabpanel"]');
          const nestedSuggestions = home?.querySelector('[class~="group/home-suggestions-header"]');
          const browser = isV31 && !home?.querySelector('[data-homepage-takeover],[data-home-inline-preview]') && shell && (gallery || nestedSuggestions);
          if (browser) main.dataset.gemV31HomeBrowser = gallery ? 'gallery' : 'suggestions';
          else main.removeAttribute('data-gem-v31-home-browser');
          if (browser && home.querySelector('[data-expanded-composer]')) main.dataset.gemV31BrowserExpanded = 'true';
          else main.removeAttribute('data-gem-v31-browser-expanded');
          if (isV31) home?.querySelectorAll('[class~="group/home-suggestion-list-item"]').forEach(row => {
            row.parentElement.dataset.gemV31SuggestionList = 'true';
          });
          // Only mark the direct branch containing the native action options;
          // neither the form nor portaled menus should inherit its scrolling.
          main.querySelectorAll('[data-gem-v31-browser-frame],[data-gem-v31-browser-scroll]').forEach(node => {
            node.removeAttribute('data-gem-v31-browser-frame');
            node.removeAttribute('data-gem-v31-browser-scroll');
          });
          main.querySelectorAll('[data-gem-v31-browser-tabstop]').forEach(node => {
            if (!browser || !node.contains(gallery || nestedSuggestions)) {
              node.removeAttribute('tabindex');node.removeAttribute('data-gem-v31-browser-tabstop');
            }
          });
          if (browser && composerSlot) {
            for (let node = shell.parentElement; node && node !== composerSlot; node = node.parentElement) {
              node.dataset.gemV31BrowserFrame = 'true';
            }
            const content = gallery || nestedSuggestions;
            let branch = content;
            while (branch.parentElement && branch.parentElement !== shell) branch = branch.parentElement;
            if (branch.parentElement === shell) {
              branch.dataset.gemV31BrowserScroll = 'true';
              if (!branch.hasAttribute('tabindex')) {branch.tabIndex=0;branch.dataset.gemV31BrowserTabstop='true';}
            }
            if (!shell.querySelector(':scope > .gem-v31-browser-back')) {
              const back = document.createElement('button');
              back.type = 'button';
              back.className = 'gem-v31-browser-back gem-v31-owned';
              back.textContent = '← 返回首页选项';
              back.addEventListener('click', () => {
                const currentComposer = shell.querySelector('.composer-surface-chrome');
                currentComposer?.querySelector('button[data-composer-expand-toggle][data-expanded-composer]')?.click();
                const remove = currentComposer?.querySelector('[data-composer-footer-responsive] button[aria-label^="移除 "]');
                if (remove) remove.click();
                else {
                  // Use the app's existing Escape handling to leave a nested
                  // suggestion, preserving the draft and native routing.
                  const editor = currentComposer?.querySelector('[contenteditable="true"]');
                  editor?.focus({preventScroll:true});
                  editor?.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',code:'Escape',bubbles:true}));
                }
              });
              shell.prepend(back);
            }
          } else shell?.querySelector(':scope > .gem-v31-browser-back')?.remove();
          if (headingSlot) {
            if (customHome || browser) headingSlot.dataset.gemV31HomeHeading = 'true';
            else headingSlot.removeAttribute('data-gem-v31-home-heading');
          }
          if (composerSlot) {
            if (customHome || browser) composerSlot.dataset.gemV31HomeComposer = 'true';
            else composerSlot.removeAttribute('data-gem-v31-home-composer');
          }
          if (intro && customHome) intro.dataset.gemV31HomeIntro = 'true';
          else intro?.removeAttribute('data-gem-v31-home-intro');
          if (animatedHeadline && customHome) {
            headline.dataset.gemV31AnimatedHeadline = 'true';
            const visibleTitle = [...headline.querySelectorAll('.heading-xl')].find(node => !node.matches('[aria-hidden="true"]'));
            if (visibleTitle) {
              const height = Math.ceil(visibleTitle.getBoundingClientRect().height) + 'px';
              if (headline.style.getPropertyValue('--gem-v31-headline-height') !== height) headline.style.setProperty('--gem-v31-headline-height', height);
            }
          }
          const title = !animatedHeadline && heading?.querySelector('span');
          if (title && !title.hasAttribute('data-gem-v3-original-text')) {
            title.setAttribute('data-gem-v3-original-text', title.textContent || '');
            title.textContent = '今天想一起创造什么？';
          }
          if (headline && customHome && !home.querySelector('.gem-v3-brand')) {
            const brand = document.createElement('div');
            brand.className = 'gem-v3-brand gem-v3-owned';
            const english = document.createElement('em');
            english.textContent = 'Gloria · a letter in light';
            const name = document.createElement('strong');
            name.textContent = 'G.E.M.';
            brand.append(english, name);
            if (isV31) {
              const subtitle = document.createElement('span');
              subtitle.className = 'gem-v31-brand-subtitle';
              subtitle.textContent = 'Letters to the light';
              brand.append(subtitle);
            }
            headline.before(brand);
            const tagline = document.createElement('p');
            tagline.className = 'gem-v3-tagline gem-v3-owned';
            tagline.textContent = '把心里的光，写成新的故事。';
            headline.after(tagline);
          }
          const previousCards = main.querySelector('.gem-v3-cards');
          // Work shares Codex's editor marker. The visible shell mode, rather
          // than that shared editor, determines which shortcut prompts to use.
          const mode = [...document.querySelectorAll('button[aria-label^="切换模式"]')].find(node => node.getBoundingClientRect().width);
          const homeMode = main.getBoundingClientRect().width && mode ?
            (mode.textContent.trim() === 'Codex' ? 'code' : 'chat') :
            previousCards?.dataset.composerMode || (composer?.querySelector('[data-codex-composer]') ? 'code' : 'chat');
          if (previousCards && previousCards.dataset.composerMode !== homeMode) previousCards.remove();
          if (home && customHome && !main.querySelector('.gem-v3-cards')) {
            const cards = document.createElement('div');
            cards.className = 'gem-v3-cards gem-v3-owned';
            cards.dataset.composerMode = homeMode;
            const entries = homeMode === 'code' ? [
              ['✧','探索代码','拾起灵感的第一束光','01 · Discover','帮我探索这个项目的代码结构'],
              ['♫','创建功能','为想法谱一段新旋律','02 · Compose','帮我实现一个新功能'],
              ['◇','审查改动','让每个细节温柔发亮','03 · Refine','帮我审查当前代码改动'],
              ['☾','修复问题','下一次绽放，正在路上','04 · Renew','帮我排查并修复一个问题']
            ] : [
              ['✧','探索想法','拾起灵感的第一束光','01 · Discover','帮我一起探索一个新想法'],
              ['♫','创作文字','为想法谱一段新旋律','02 · Compose','帮我构思并写一段文字'],
              ['◇','学习新知','让每个细节温柔发亮','03 · Refine','帮我理解一个新的知识点'],
              ['☾','解答问题','下一次绽放，正在路上','04 · Renew','帮我分析并解答一个问题']
            ];
            for (const [icon,title,subtitle,index,prompt] of entries) {
              const button = document.createElement('button');
              button.type = 'button';
              button.setAttribute('aria-label', title + '：' + subtitle);
              const symbol = document.createElement('i');
              if (isV31) {
                const shapes = [
                  '<path d="m8 1 1.6 5.4L15 8l-5.4 1.6L8 15l-1.6-5.4L1 8l5.4-1.6L8 1Z"/>',
                  '<path d="M6 12V4l8-2v8"/><circle cx="4" cy="13" r="2"/><circle cx="12" cy="11" r="2"/>',
                  '<rect x="6" y="2" width="4" height="8" rx="2"/><path d="M4 7a4 4 0 0 0 8 0M8 11v3m-3 0h6"/>',
                  '<path d="M12.9 12.2A6 6 0 0 1 3.8 3.1 6 6 0 1 0 12.9 12.2Z"/>'
                ];
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('viewBox', '0 0 16 16');
                svg.setAttribute('aria-hidden', 'true');
                svg.innerHTML = shapes[cards.children.length];
                symbol.append(svg, document.createTextNode(index));
              } else {
                symbol.textContent = icon + '  ' + index;
              }
              const name = document.createElement('b'); name.textContent = title;
              const hint = document.createElement('small'); hint.textContent = subtitle;
              button.append(symbol,name,hint);
              button.addEventListener('click', () => {
                const editor = main.querySelector('.composer-surface-chrome [contenteditable="true"]');
                if (!editor) return;
                editor.focus();
                document.execCommand('insertText', false, prompt);
              });
              cards.append(button);
            }
            main.append(cards);
          }
          if (shell) {
            if (!shell.classList.contains('gem-v3-composer-shell')) shell.classList.add('gem-v3-composer-shell');
            if (isV31) {
              polaroid(main);
              const photo = main.querySelector(':scope > .gem-v3-polaroid');
              if (photo && !photo.classList.contains('gem-v31-home-polaroid')) photo.classList.add('gem-v31-home-polaroid');
            } else {
              polaroid(shell);
            }
          }
        } else if (page === 'conversation' && composer?.parentElement) {
          const shell = composer.parentElement;
          if (!shell.classList.contains('gem-v3-conversation-composer-shell')) shell.classList.add('gem-v3-conversation-composer-shell');
          polaroid(shell);
        }
      };
      const classifyMain = (main, observed) => {
        if (!main.classList.contains('main-surface')) { main.classList.add('main-surface'); main.dataset.codexthemesOwnedMain = 'true'; }
        main.querySelectorAll('[data-composer-surface-variant],[class*="_ComposerLayoutRoot_"]').forEach((node) => {
          if (!node.classList.contains('composer-surface-chrome')) { node.classList.add('composer-surface-chrome'); node.dataset.codexthemesOwnedComposer = 'true'; }
        });
        const hasHomeLayout = Boolean(main.querySelector('[class~="group/home-composer-layout"]'));
        const hasThreadLayout = Boolean(main.querySelector('[class~="group/thread-scroll-layout"]'));
        main.dataset.codexthemesPage = hasHomeLayout ? 'home' : hasThreadLayout ? 'conversation' : 'system';
        if (config.themeId === 'gem-purple-stage-v3-1') {
          const workspace = main.closest('[data-app-shell], [class*="_AppShell_"], [class*="_AppShellRoot_"]') || main.parentElement;
          const panel = workspace?.querySelector('[data-app-shell-pane-frame="true"]')
            || workspace?.querySelector('[data-app-shell-tab-panel-controller="right"]');
          const mainRect = main.getBoundingClientRect();
          const panelRect = panel?.getBoundingClientRect();
          const usableWidth = panelRect && panelRect.width > 180 && panelRect.left > mainRect.left
            && panelRect.left < mainRect.right ? Math.round(panelRect.left - mainRect.left) : 0;
          if (usableWidth > 300) {
            main.dataset.gemV31PanelOpen = 'true';
            const width = usableWidth + 'px';
            if (main.style.getPropertyValue('--gem-v31-usable-width') !== width) main.style.setProperty('--gem-v31-usable-width', width);
          } else {
            main.removeAttribute('data-gem-v31-panel-open');
            main.style.removeProperty('--gem-v31-usable-width');
          }
          const scroller = main.dataset.codexthemesPage === 'conversation'
            ? main.querySelector('.thread-scroll-container') : null;
          const homeShell = main.dataset.codexthemesPage === 'home'
            ? main.querySelector('.composer-surface-chrome')?.closest('[class*="thread-content-max-width"]') : null;
          [main, panel, scroller, homeShell].filter(Boolean).forEach((node) => observed.add(node));
          const footer = scroller?.querySelector(':scope > [data-thread-scroll-footer="true"]');
          if (footer) {
            // The native footer sits inside a reversed scroll container. Fix it to
            // the viewport using the scroller's resize geometry so scrolling never
            // waits for a JavaScript scroll event to move the composer back.
            const rect = scroller.getBoundingClientRect();
            const pixel = (value) => Math.round(value * 100) / 100 + 'px';
            const geometry = {
              '--gem-v31-footer-left': pixel(rect.left),
              '--gem-v31-footer-width': pixel(rect.width),
              '--gem-v31-footer-bottom': pixel(window.innerHeight - rect.bottom)
            };
            for (const [name, value] of Object.entries(geometry)) {
              if (footer.style.getPropertyValue(name) !== value) footer.style.setProperty(name, value);
            }
          }
        }
        enhanceV3(main, main.dataset.codexthemesPage);
        main.querySelectorAll('[data-gem-v31-home-intro],[data-gem-v31-animated-headline]').forEach(node => observed.add(node));
        // A cached page has no usable geometry until the shell shows it again.
        if (!main.getBoundingClientRect().width) return;
        if (config.themeId === 'gem-purple-stage-v3-1' && main.dataset.codexthemesPage === 'home') {
          const shell = main.querySelector('[data-gem-v31-home-composer] .gem-v3-composer-shell');
          const cards = main.querySelector('.gem-v3-cards');
          if (shell && cards) {
            const mainRect = main.getBoundingClientRect();
            const shellRect = shell.getBoundingClientRect();
            const cardsHeight = cards.getBoundingClientRect().height;
            const photoRect = main.querySelector('.gem-v31-home-polaroid')?.getBoundingClientRect();
            const composerRect = main.querySelector('.composer-surface-chrome')?.getBoundingClientRect();
            const photoBesideComposer = photoRect && composerRect && photoRect.left >= composerRect.right + 18;
            const gap = photoBesideComposer ? Math.max(24, Math.ceil(shellRect.top - photoRect.top + 12)) : 24;
            // The native composer grows upward as a draft gets longer. Anchor
            // shortcuts above its actual top edge instead of a fixed bottom.
            const bottom = Math.max(0, Math.round(mainRect.bottom - shellRect.top + gap));
            const value = bottom + 'px';
            if (main.style.getPropertyValue('--gem-v31-home-cards-bottom') !== value) main.style.setProperty('--gem-v31-home-cards-bottom', value);
            const heading = main.querySelector('[data-gem-v31-home-heading]') || main.querySelector('.heading-xl');
            const headingBottom = heading?.getBoundingClientRect().bottom || mainRect.top;
            const cardsTop = shellRect.top - gap - cardsHeight;
            if (shellRect.top < headingBottom + 16) main.dataset.gemV31HomeHeadingHidden = 'true';
            else main.removeAttribute('data-gem-v31-home-heading-hidden');
            if (cardsTop < Math.max(mainRect.top + 28, headingBottom + 24)) main.dataset.gemV31HomeCardsHidden = 'true';
            else main.removeAttribute('data-gem-v31-home-cards-hidden');
          } else main.dataset.gemV31HomeCardsHidden = 'true';
        } else {
          main.removeAttribute('data-gem-v31-home-cards-hidden');
          main.removeAttribute('data-gem-v31-home-heading-hidden');
          main.style.removeProperty('--gem-v31-home-cards-bottom');
        }
        const photo = main.querySelector('.gem-v31-home-polaroid') || main.querySelector('.gem-v3-conversation-composer-shell > .gem-v3-polaroid');
        const composer = main.querySelector('.composer-surface-chrome');
        if (photo && composer) {
          const a = photo.getBoundingClientRect();
          const obstacles = [composer, main.querySelector('.gem-v3-cards'), main.querySelector('[class~="group/home-suggestions"]')].filter(Boolean);
          const overlaps = obstacles.some(node => {
            const b = node.getBoundingClientRect();
            return a.width && b.width && getComputedStyle(node).visibility !== 'hidden' &&
              a.left < b.right + 12 && a.right > b.left - 12 && a.top < b.bottom + 12 && a.bottom > b.top - 12;
          });
          if (overlaps) photo.dataset.gemV31PolaroidHidden = 'true';
          else photo.removeAttribute('data-gem-v31-polaroid-hidden');
        }
      };
      const classify = () => {
        const observed = new Set();
        document.querySelectorAll('main[data-app-shell-main-surface], main.main-surface, main[class*="_MainContentSurface_"]').forEach((main) => classifyMain(main, observed));
        for (const node of state.layoutNodes) if (!observed.has(node)) state.layoutObserver.unobserve(node);
        for (const node of observed) if (!state.layoutNodes.has(node)) state.layoutObserver.observe(node);
        state.layoutNodes = observed;
        state.sidebarPeek?.sync();
      };
      const state = { observer: undefined, layoutObserver: undefined, layoutNodes: new Set(), frame: 0, timerBased: true, css: config.css, revision: config.revision,
        sidebarPeek: config.themeId === 'gem-purple-stage-v3-1' ? (${installSidebarPeek.toString()})() : undefined };
      const schedule = () => {
        if (state.frame) return;
        // Background Codex windows can suspend animation frames; a timer keeps
        // route styling in sync when a window is shown again.
        state.frame = setTimeout(() => { state.frame = 0; classify(); }, document.visibilityState === 'hidden' ? 150 : 30);
      };
      state.layoutObserver = new ResizeObserver(schedule);
      state.observer = new MutationObserver(schedule);
      state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'aria-pressed', 'data-state', 'data-app-shell-sidebar-open', 'data-slate-sidebar-peeking', 'data-composer-mode', 'data-composer-layout', 'data-expanded-composer', 'data-homepage-takeover', 'data-home-inline-preview'] });
      window.addEventListener('resize', schedule);
      document.addEventListener('visibilitychange', schedule);
      state.schedule = schedule;
      globalThis[key] = state;
      classify();
    };
    if (document.readyState === 'loading') {
      clear();
      globalThis[key] = { pendingInstall: install };
      document.addEventListener('DOMContentLoaded', install, { once: true });
    }
    else install();
  })();`;
}

const restoreSource = `(() => {
  const state = globalThis.__codexThemesRuntime;
  state?.sidebarPeek?.dispose();
  if (state?.pendingInstall) document.removeEventListener('DOMContentLoaded', state.pendingInstall);
  if (state?.observer) state.observer.disconnect();
  if (state?.layoutObserver) state.layoutObserver.disconnect();
  if (state?.schedule) { window.removeEventListener('resize', state.schedule); document.removeEventListener('visibilitychange', state.schedule); }
  if (state?.frame) {
    if (state.timerBased) clearTimeout(state.frame);
    else cancelAnimationFrame(state.frame);
  }
  delete globalThis.__codexThemesRuntime;
  document.getElementById('codexthemes-runtime-style')?.remove();
  delete document.documentElement.dataset.codexthemesTheme;
  delete document.documentElement.dataset.codexthemesBackgroundScope;
  document.querySelectorAll('[data-codexthemes-owned-main]').forEach((node) => { node.classList.remove('main-surface'); node.removeAttribute('data-codexthemes-owned-main'); });
  document.querySelectorAll('[data-codexthemes-owned-composer]').forEach((node) => { node.classList.remove('composer-surface-chrome'); node.removeAttribute('data-codexthemes-owned-composer'); });
  document.querySelectorAll('[data-codexthemes-page]').forEach((node) => node.removeAttribute('data-codexthemes-page'));
  document.querySelectorAll('[data-gem-v31-home-browser],[data-gem-v31-browser-expanded],[data-gem-v31-browser-frame],[data-gem-v31-browser-scroll],[data-gem-v31-suggestion-list]').forEach(node => {
    ['data-gem-v31-home-browser','data-gem-v31-browser-expanded','data-gem-v31-browser-frame','data-gem-v31-browser-scroll','data-gem-v31-suggestion-list'].forEach(name => node.removeAttribute(name));
  });
  document.querySelectorAll('[data-gem-v31-browser-tabstop]').forEach(node => {node.removeAttribute('tabindex');node.removeAttribute('data-gem-v31-browser-tabstop');});
  document.querySelectorAll('[data-gem-v31-panel-open]').forEach((node) => { node.removeAttribute('data-gem-v31-panel-open'); node.style.removeProperty('--gem-v31-usable-width'); });
  document.querySelectorAll('[data-gem-v31-home-cards-hidden],[data-gem-v31-home-heading-hidden]').forEach((node) => { node.removeAttribute('data-gem-v31-home-cards-hidden'); node.removeAttribute('data-gem-v31-home-heading-hidden'); });
  document.querySelectorAll('[data-gem-v31-home-heading],[data-gem-v31-home-composer],[data-gem-v31-polaroid-hidden]').forEach((node) => {
    node.removeAttribute('data-gem-v31-home-heading'); node.removeAttribute('data-gem-v31-home-composer'); node.removeAttribute('data-gem-v31-polaroid-hidden');
  });
  document.querySelectorAll('main').forEach((node) => node.style.removeProperty('--gem-v31-home-cards-bottom'));
  document.querySelectorAll('[data-gem-v31-home-intro],[data-gem-v31-animated-headline]').forEach((node) => {
    node.removeAttribute('data-gem-v31-home-intro'); node.removeAttribute('data-gem-v31-animated-headline');
    node.style.removeProperty('--gem-v31-headline-height');
  });
  document.querySelectorAll('[data-thread-scroll-footer="true"]').forEach((node) => {
    node.style.removeProperty('--gem-v31-scroll-offset');
    node.style.removeProperty('--gem-v31-footer-left');
    node.style.removeProperty('--gem-v31-footer-width');
    node.style.removeProperty('--gem-v31-footer-bottom');
  });
  document.querySelectorAll('[data-gem-v31-original-placeholder]').forEach((node) => { node.setAttribute('data-placeholder', node.getAttribute('data-gem-v31-original-placeholder') || ''); node.removeAttribute('data-gem-v31-original-placeholder'); });
  document.querySelectorAll('.gem-v3-owned,.gem-v31-owned').forEach((node) => node.remove());
  document.querySelectorAll('.gem-v31-directory-open').forEach((node) => node.classList.remove('gem-v31-directory-open'));
  document.querySelectorAll('.gem-v3-composer-shell,.gem-v3-conversation-composer-shell').forEach((node) => { node.classList.remove('gem-v3-composer-shell','gem-v3-conversation-composer-shell'); });
  document.querySelectorAll('[data-gem-v3-original-text]').forEach((node) => { node.textContent = node.getAttribute('data-gem-v3-original-text'); node.removeAttribute('data-gem-v3-original-text'); });
})()`;

async function connect(options: Options): Promise<{ port: number; targets: Target[] } | undefined> {
  let found = await locateTargets(options.port);
  if (!found && options.launch) {
    const app = await launchWithDebugging(options.port, options.app);
    found = await waitForTargetsOrDiagnose(app, options.port);
  }
  return found;
}

export function launchLogPath(): string {
  return path.join(stateRoot(), 'launch.log');
}

/**
 * Run the quit → relaunch → inject sequence in a detached helper process.
 * When the applying agent is hosted inside Codex itself, quitting Codex kills
 * the agent's tool call (and any process in its group) before the relaunch
 * can happen. The helper starts its own session, so it survives the restart
 * and finishes the injection on its own; its output lands in launch.log.
 */
async function scheduleDetachedLaunch(options: Options): Promise<void> {
  await fs.mkdir(stateRoot(), { recursive: true });
  const logPath = launchLogPath();
  const logFd = openSync(logPath, 'w');
  const args = [
    ...process.execArgv,
    process.argv[1]!,
    'apply', options.themeDir!,
    '--launch', '--launch-worker',
    ...(options.relaunch ? ['--relaunch'] : []),
    '--port', String(options.port),
    ...(options.app ? ['--app', options.app] : []),
  ];
  const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  closeSync(logFd);
  console.log(JSON.stringify({
    status: 'scheduled',
    note: 'Codex is restarting with the debugging endpoint; a detached helper that survives the restart will inject the theme. This tool call may be interrupted by the restart. Afterwards verify with: apply-theme.ts status',
    logPath,
  }, null, 2));
}


const watchPath = path.join(stateRoot(), 'watch.json');
const heartbeatPath = path.join(stateRoot(), 'watch-heartbeat.json');
interface WatchControl { token: string; enabled: boolean; themeDir?: string; port?: number }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function atomicJson(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), {recursive:true});
  const temporary = filename + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value,null,2)+'\n', {mode:0o600});
  await fs.rename(temporary,filename);
}
async function stopWatcher(): Promise<void> {
  const control=await readJson<WatchControl>(watchPath);
  if(!control?.enabled) return;
  await atomicJson(watchPath,{...control,enabled:false});
  // A client restart can leave watch.json enabled after its detached watcher
  // has died. Its CDP session is gone, so there is no owner to acknowledge stop.
  const isStale = (heartbeat: any) => heartbeat?.token !== control.token ||
    typeof heartbeat.at !== 'number' || Date.now() - heartbeat.at > 10_000;
  if(isStale(await readJson<any>(heartbeatPath))) return;
  // A live owner should remove its own early-script registrations.
  const deadline=Date.now()+45_000;
  while(Date.now()<deadline) {
    const heartbeat=await readJson<any>(heartbeatPath);
    if(heartbeat?.token===control.token && heartbeat.stopped) return;
    if(isStale(heartbeat)) return;
    await delay(150);
  }
  // Token revocation still prevents future work; fail rather than race a new owner.
  throw new Error('Watcher stop was not acknowledged. Inspect watch.log before reapplying.');
}
async function clearAvatarOverlay(target: Target, port: number): Promise<boolean> {
  let client: CdpClient | undefined;
  try {
    client = await CdpClient.connect(checkedSocket(target, port));
    const probe = await evaluate(client, probeSource);
    if (probe.stylePresent || probe.themeId) await evaluate(client, restoreSource);
    const after = await evaluate(client, probeSource);
    return !after.stylePresent && !after.themeId;
  } catch (error) {
    console.error(`Could not restore transparent avatar overlay ${target.id}:`, error);
    return false;
  } finally { client?.close(); }
}
async function runWatcher(options: Options): Promise<void> {
  const owns=async()=>{const c=await readJson<WatchControl>(watchPath);return c?.enabled && c.token===options.watchToken;};
  if(!await owns()) return;
  const manifest=JSON.parse(await fs.readFile(path.join(options.themeDir!,'theme.json'),'utf8'));
  const css=await inlineLocalAssets(await fs.readFile(path.join(options.themeDir!,manifest.css),'utf8'),options.themeDir!);
  const revision=runtimeRevision(css);
  const sessions=new TargetSessions(options.port,runtimeSource(manifest.id,manifest.design.backgroundScope,css),manifest.id,revision);
  const clearedOverlays = new Set<string>();
  let stopping=false;
  process.on('SIGTERM',()=>{stopping=true;}); process.on('SIGINT',()=>{stopping=true;});
  try {
    while(!stopping && await owns()) {
      const targets=await targetsAt(options.port);
      const overlays=targets.filter(isAvatarOverlayTarget);
      const overlayIds=new Set(overlays.map(target=>target.id));
      for (const id of clearedOverlays) if (!overlayIds.has(id)) clearedOverlays.delete(id);
      for (const target of overlays) {
        if (!clearedOverlays.has(target.id) && await clearAvatarOverlay(target,options.port)) clearedOverlays.add(target.id);
      }
      const result=await sessions.sync(targets);
      if(!await owns()) break;
      await writeState({port:options.port,themeId:manifest.id,watcherToken:options.watchToken,registrations:result.registrations,pages:result.pages});
      await atomicJson(heartbeatPath,{token:options.watchToken,pid:process.pid,at:Date.now(),stopped:false,
        status:result.pages.length && result.pages.every(p=>p.verified)?'active':result.pages.some(p=>p.verified)?'partial':'inactive'});
      await delay(1200);
    }
  } finally {
    await sessions.close();
    await atomicJson(heartbeatPath,{token:options.watchToken,pid:process.pid,at:Date.now(),stopped:true});
  }
}
async function startWatcher(options: Options, port: number): Promise<void> {
  await stopWatcher();
  const token=randomUUID();
  await atomicJson(watchPath,{token,enabled:true,themeDir:options.themeDir,port});
  const logFd=openSync(path.join(stateRoot(),'watch.log'),'a');
  const child=spawn(process.execPath,[...process.execArgv,process.argv[1]!, 'watch',options.themeDir!,
    '--port',String(port),'--watch-token',token],{detached:true,windowsHide:true,stdio:['ignore',logFd,logFd]});
  child.on('error',error=>console.error('Watcher start failed:',error.message));
  child.unref(); closeSync(logFd);
  const deadline=Date.now()+15_000;
  while(Date.now()<deadline) {
    const heartbeat=await readJson<any>(heartbeatPath);
    if(heartbeat?.token===token && heartbeat.status==='active') return;
    await delay(250);
  }
}

async function apply(options: Options): Promise<void> {
  const themeDir = options.themeDir!;
  const validation = await validateTheme(themeDir);
  if (!validation.valid) throw new Error(`Theme validation failed:\n${validation.errors.join('\n')}`);
  const manifest = JSON.parse(await fs.readFile(path.join(themeDir, 'theme.json'), 'utf8')) as {
    id: string; css: string; design: { backgroundScope: string };
  };
  // Validate local assets before scheduling any process; watcher reads the same files.
  await inlineLocalAssets(await fs.readFile(path.join(themeDir, manifest.css), 'utf8'), themeDir);
  // --relaunch forces a clean quit+relaunch even when an endpoint is live: it
  // evicts stale sessions from earlier tasks whose on-new-document
  // registrations keep re-injecting an old theme that a hot swap cannot
  // remove (their identifiers belong to other CDP sessions).
  const live = await locateTargets(options.port);
  if (options.launch && !options.worker && (!live || options.relaunch)) {
    await scheduleDetachedLaunch(options);
    return;
  }
  if (options.relaunch && !options.launch) {
    throw new Error('--relaunch also requires --launch (and the user\'s explicit restart permission).');
  }
  const connection = options.worker && options.relaunch
    ? await (async () => {
        const app = await launchWithDebugging(options.port, options.app);
        return waitForTargetsOrDiagnose(app, options.port);
      })()
    : await connect(options);
  if (!connection) {
    throw new Error('No debuggable Codex renderer found. With explicit restart permission, rerun with --launch; no external theme program is required.');
  }
  await startWatcher(options, connection.port);
  await status({...options, port:connection.port});

}

async function restore(options: Options): Promise<void> {
  await stopWatcher();
  const state = await readRuntimeState();
  const port = state?.port ?? options.port;
  const targets = (await targetsAt(port)).filter(target => isAppTarget(target) || isAvatarOverlayTarget(target));
  if (!targets.length) {
    await clearState();
    console.log(JSON.stringify({ status: 'inactive', note: 'Codex was not running; local runtime state was cleared.' }, null, 2));
    return;
  }
  const previous = stateRegistrations(state);
  for (const target of targets) {
    const client = await CdpClient.connect(checkedSocket(target, port));
    try {
      for (const registration of previous) {
        if (registration.targetId === target.id) {
          await client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: registration.identifier }).catch(() => undefined);
        }
      }
      await client.call('Runtime.evaluate', { expression: restoreSource, awaitPromise: true });
    } finally {
      client.close();
    }
  }
  await clearState();
  console.log(JSON.stringify({ status: 'inactive', restoredThemeId: state?.themeId, pagesRestored: targets.length }, null, 2));
}

async function status(options: Options): Promise<void> {
  const state = await readRuntimeState();
  const found = await locateTargets(state?.port ?? options.port);
  const pages: any[] = [];
  if (found) {
    for (const target of found.targets) {
      let client: CdpClient | undefined;
      try {
        client = await CdpClient.connect(checkedSocket(target, found.port));
        const probe=await evaluate(client,probeSource);
        pages.push({targetId:target.id,url:target.url,title:target.title,...probe,
          verified:isInstalled(probe,state?.themeId ?? probe?.themeId)});
      } catch(error) {
        pages.push({targetId:target.id,url:target.url,themeId:null,verified:false,error:String(error)});
      } finally { client?.close(); }
    }
  }
  const themed = pages.filter((page) => page.verified);
  const themeIds = [...new Set(themed.map((page) => page.themeId))];
  console.log(JSON.stringify({
    status: themed.length === pages.length && pages.length > 0 && themeIds.length === 1 ? 'active' : themed.length > 0 ? 'partial' : 'inactive',
    themeId: themeIds.length === 1 ? themeIds[0] : themeIds.length > 1 ? themeIds : null,
    pages,
    debugEndpoint: found ? new URL(found.targets[0].webSocketDebuggerUrl).host : null,
    recordedState: state ?? null,
    watcher: await readJson(heartbeatPath) ?? null,
    launchLog: launchLogPath(),
  }, null, 2));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'watch') await runWatcher(options);
  else if (options.command === 'apply') await apply(options);
  else if (options.command === 'restore') await restore(options);
  else await status(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
