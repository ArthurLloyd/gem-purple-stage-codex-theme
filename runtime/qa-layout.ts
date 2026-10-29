// Read-only layout checks for the currently open native surfaces. No chat text is emitted.
import { CdpClient, checkedSocket, evaluate, isAppTarget, probeSource, targetsAt } from './injection-session.ts';
import { pathToFileURL } from 'node:url';

export const layoutProbeSource = `(() => {
  const issues = [];
  const visible = node => {
    if (!node || !node.getBoundingClientRect().width) return false;
    if (getComputedStyle(node).visibility === 'hidden') return false;
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.opacity === '0') return false;
    }
    return true;
  };
  const overlaps = (a, b) => visible(a) && visible(b) && (() => {
    const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
    return x.left < y.right - 1 && x.right > y.left + 1 && x.top < y.bottom - 1 && x.bottom > y.top + 1;
  })();
  // The editor's full text can be taller than its native scrolling viewport.
  const clippedRect = node => {
    const r = node.getBoundingClientRect();
    let left=r.left, right=r.right, top=r.top, bottom=r.bottom;
    for (let ancestor=node.parentElement; ancestor; ancestor=ancestor.parentElement) {
      const s=getComputedStyle(ancestor), a=ancestor.getBoundingClientRect();
      if (!a.width || !a.height) continue;
      if (['auto','scroll','hidden','clip'].includes(s.overflowX)) {left=Math.max(left,a.left);right=Math.min(right,a.right);}
      if (['auto','scroll','hidden','clip'].includes(s.overflowY)) {top=Math.max(top,a.top);bottom=Math.min(bottom,a.bottom);}
    }
    return {left,right,top,bottom};
  };
  const mains = [...document.querySelectorAll('main[data-app-shell-main-surface],main.main-surface,main[class*="_MainContentSurface_"]')];
  let searchInputs = 0, placeholders = 0, suggestionMenus = 0, homeActionBrowsers = 0, homeActionRows = 0, homeExpandedEditors = 0, sidebarPeeks = 0, sidebarActivityRows = 0, multilineComposers = 0, composerActionGroups = 0, homeShortcutGroups = 0, homeShortcutButtons = 0;
  for (const row of document.querySelectorAll('aside.app-shell-left-panel .sidebar-item:has([data-thread-secondary-title])')) {
    if (!visible(row) || row.closest('[inert]')) continue;
    sidebarActivityRows++;
    const bounds = row.getBoundingClientRect();
    const content = row.querySelector('[data-thread-title-trigger]');
    const r = content?.getBoundingClientRect();
    if (row.scrollHeight > row.clientHeight + 1 || (r && (r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1))) issues.push('sidebar-activity-content-overflows-row');
  }
  for (const drawer of document.querySelectorAll('aside.app-shell-left-panel:is([data-slate-sidebar-peeking="true"],[data-gem-v31-sidebar-peek="true"]) [data-slate-sidebar-content]')) {
    if (!visible(drawer)) continue;
    sidebarPeeks++;
    const style = getComputedStyle(drawer);
    const color = style.backgroundColor.match(/^rgba?\\(([^)]+)\\)$/)?.[1].split(',').map(Number);
    let opacity = 1;
    for (let node = drawer; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    if (!color || ![3,4].includes(color.length) || color.some(Number.isNaN) || (color.length === 4 && color[3] < 1) || opacity < 0.99) issues.push('sidebar-peek-transparent');
    if (drawer.inert) issues.push('sidebar-peek-inert');
    const navigation = drawer.firstElementChild;
    if (navigation && getComputedStyle(navigation).opacity === '0') issues.push('sidebar-peek-content-hidden');
    const r = drawer.getBoundingClientRect();
    if (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1) issues.push('sidebar-peek-outside-viewport');
    const hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    if (!hit || (!drawer.contains(hit) && !hit.closest('[role="menu"],[role="dialog"],[role="listbox"]'))) issues.push('sidebar-peek-obstructed');
  }
  for (const input of document.querySelectorAll('input.bg-transparent')) {
    if (!visible(input) || !input.parentElement.classList.contains('border-primary-outline')) continue;
    searchInputs++;
    if (parseFloat(getComputedStyle(input).borderTopWidth) > 0) issues.push('search-double-border');
    if (getComputedStyle(input).backgroundColor !== 'rgba(0, 0, 0, 0)') issues.push('search-opaque-inner-input');
  }
  for (const main of mains.filter(visible)) {
    const composer = main.querySelector('.composer-surface-chrome');
    for (const footer of main.querySelectorAll('.composer-surface-chrome [data-composer-footer-responsive][data-composer-layout="multiline"]')) {
      if (!visible(footer)) continue;
      multilineComposers++;
      const input = footer.querySelector('[data-composer-input]');
      const viewport = input && clippedRect(input);
      for (const group of footer.children) {
        if (!group.classList.contains('bg-(--composer-layout-surface-background)') || !visible(group)) continue;
        composerActionGroups++;
        if (getComputedStyle(group).backgroundColor !== 'rgba(0, 0, 0, 0)') issues.push('multiline-composer-opaque-action-bar');
        const controls = group.getBoundingClientRect();
        if (viewport && viewport.bottom > controls.top + 1) issues.push('multiline-composer-controls-overlap-input');
      }
    }
    const shell = main.querySelector('.gem-v3-composer-shell') || composer;
    if (overlaps(main.querySelector('.gem-v3-cards'), shell)) issues.push('home-cards-overlap-composer-controls');
    if (overlaps(main.querySelector('[data-gem-v31-home-heading]'), shell)) issues.push('home-heading-overlap-composer');
    const heading = [...main.querySelectorAll('.heading-xl')].find(visible);
    if (overlaps(heading, main.querySelector('.gem-v3-tagline'))) issues.push('home-title-overlap-tagline');
    if (overlaps(heading, main.querySelector('.gem-v3-brand'))) issues.push('home-title-overlap-brand');
    if (overlaps(main.querySelector('[data-gem-v31-home-heading]'), main.querySelector('.gem-v3-cards'))) issues.push('home-heading-overlap-shortcuts');
    if (main.dataset.codexthemesPage === 'home') {
      const cards = main.querySelector('.gem-v3-cards');
      if (visible(cards)) {
        homeShortcutGroups++;
        const bounds = clippedRect(cards);
        const buttons = [...cards.querySelectorAll('button')];
        if (buttons.length !== 4) issues.push('home-shortcuts-incomplete');
        if (cards.scrollWidth > cards.clientWidth + 1 || cards.scrollHeight > cards.clientHeight + 1) issues.push('home-shortcuts-scroll-overflow');
        for (const button of buttons) {
          homeShortcutButtons++;
          const r = button.getBoundingClientRect();
          if (r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1) issues.push('home-shortcut-clipped');
          const title = button.querySelector('b');
          if (title && title.scrollWidth > title.clientWidth + 1) issues.push('home-shortcut-title-truncated');
          if (r.height < 44) issues.push('home-shortcut-target-too-small');
        }
      }
      const browser = main.dataset.gemV31HomeBrowser;
      const nativeOptions = main.querySelector('[class~="group/home-suggestions-header"],[role="tabpanel"]');
      const takeover = main.querySelector('[data-expanded-composer],[data-homepage-takeover],[data-home-inline-preview]');
      if (visible(nativeOptions) && !takeover && !browser) issues.push('home-action-browser-unbounded');
      if (browser) {
        homeActionBrowsers++;
        const panel = main.querySelector('.gem-v3-composer-shell');
        const scroller = main.querySelector('[data-gem-v31-browser-scroll]');
        const back = main.querySelector('.gem-v31-browser-back');
        const bounds = main.getBoundingClientRect(), p = panel?.getBoundingClientRect();
        if (!visible(panel) || p.left < bounds.left-1 || p.right > bounds.right+1 || p.top < bounds.top-1 || p.bottom > bounds.bottom+1) issues.push('home-action-browser-outside-surface');
        if (!main.hasAttribute('data-gem-v31-browser-expanded') && (!visible(scroller) || scroller.clientHeight < 40 || !['auto','scroll'].includes(getComputedStyle(scroller).overflowY))) issues.push('home-action-browser-no-scroll-viewport');
        if (!visible(back)) issues.push('home-action-browser-no-return-control');
        else {
          const r = back.getBoundingClientRect(), hit = document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          if (!hit || !back.contains(hit)) issues.push('home-action-return-obstructed');
        }
      }
      for (const toggle of main.querySelectorAll('button[data-composer-expand-toggle][data-expanded-composer]')) {
        homeExpandedEditors++;
        const r = toggle.getBoundingClientRect(), hit = document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        if (!visible(toggle) || r.top < 0 || r.bottom > innerHeight || !hit || !toggle.contains(hit)) issues.push('home-expanded-editor-collapse-inaccessible');
      }
      for (const row of main.querySelectorAll('[class~="group/home-suggestion-list-item"] button[data-composer-mode]')) {
        if (!visible(row)) continue;
        homeActionRows++;
        const height = row.getBoundingClientRect().height;
        if (height < 40 || height > 100) issues.push('home-action-row-unreasonable-height');
      }
      const editor = main.querySelector('.composer-surface-chrome [contenteditable="true"]');
      const r = editor && clippedRect(editor);
      if (visible(editor) && (r.left < main.getBoundingClientRect().left - 1 || r.right > innerWidth + 1 || r.top < 0 || r.bottom > innerHeight + 1)) issues.push('home-editor-outside-viewport');
      for (const button of main.querySelectorAll('.gem-v3-cards button,[class~="group/home-suggestions"] button[data-composer-mode]')) {
        if (!visible(button) || button.disabled) continue;
        const b = clippedRect(button);
        const left=Math.max(0,b.left), right=Math.min(innerWidth,b.right), top=Math.max(0,b.top), bottom=Math.min(innerHeight,b.bottom);
        if (right-left < 4 || bottom-top < 4) continue;
        const hit = document.elementFromPoint((left+right)/2, (top+bottom)/2);
        // Native popovers and the collapsed sidebar drawer cover underlying controls.
        if (!hit || (!button.contains(hit) && !hit.closest('[class*="_suggestionMenu_"],[role="menu"],[role="listbox"],[role="dialog"],aside:is([data-slate-sidebar-peeking="true"],[data-gem-v31-sidebar-peek="true"]) [data-slate-sidebar-content]'))) issues.push('home-shortcut-obstructed');
      }
    }
    for (const photo of main.querySelectorAll('.gem-v3-polaroid')) {
      if (overlaps(photo, composer)) issues.push('polaroid-overlap-composer');
      if (overlaps(photo, main.querySelector('.gem-v3-cards'))) issues.push('polaroid-overlap-shortcuts');
      if (overlaps(photo, main.querySelector('[class~="group/home-suggestions"]'))) issues.push('polaroid-overlap-native-suggestions');
    }
    for (const placeholder of main.querySelectorAll('.composer-surface-chrome p.placeholder')) {
      if (!visible(placeholder)) continue;
      placeholders++;
      const hasContent = pseudo => !['none', 'normal', '""'].includes(getComputedStyle(placeholder, pseudo).content);
      if (hasContent('::before') && hasContent('::after')) issues.push('composer-double-placeholder');
    }
  }
  // Suggestions are portaled outside the native main surface in current builds.
  for (const menu of document.querySelectorAll('[class*="_suggestionMenu_"]')) {
    if (!visible(menu)) continue;
    suggestionMenus++;
    const r = menu.getBoundingClientRect();
    if (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1) issues.push('suggestion-menu-outside-viewport');
    for (const composer of document.querySelectorAll('.composer-surface-chrome')) {
      if (overlaps(menu, composer)) issues.push('suggestion-menu-overlap-editor');
    }
  }
  return {issues: [...new Set(issues)], surfaces: mains.length, visibleSurfaces: mains.filter(visible).length,
    searchInputs, placeholders, suggestionMenus, homeActionBrowsers, homeActionRows, homeExpandedEditors, sidebarPeeks, sidebarActivityRows, multilineComposers, composerActionGroups, homeShortcutGroups, homeShortcutButtons};
})()`;

export async function checkLayouts(port = 9335) {
  const targets = (await targetsAt(port)).filter(isAppTarget);
  const pages = await Promise.all(targets.map(async target => {
    const client = await CdpClient.connect(checkedSocket(target, port));
    try {
      const probe = await evaluate(client, probeSource);
      const layout = await evaluate(client, layoutProbeSource);
      if (!probe.surfacesReady) layout.issues.push('unclassified-native-surface');
      if (probe.nativeContentReady === false) layout.issues.push('native-main-content-empty');
      if (!probe.styleMatches || !probe.styleEnabled || !probe.rules) layout.issues.push('inactive-theme-style');
      return {targetId: target.id, route: probe.route, ...layout};
    } finally { client.close(); }
  }));
  return {status: pages.length && pages.every(page => !page.issues.length) ? 'pass' : 'fail', pages};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex < 0 ? 9335 : Number(process.argv[portIndex + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local debugging port');
  const result = await checkLayouts(port);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'pass') process.exitCode = 1;
}
