/** Restore Home sidebar hover on narrow desktop windows using the mounted native list. */
export function installSidebarPeek() {
  let active = null;
  let pending = null;
  let enterTimer = 0;
  let leaveTimer = 0;
  let suppressed = false;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const desktopPeek = window.matchMedia('(min-width: 768px)');
  const homeSelector = '[data-slate-sidebar-peek-area="home"]';
  const closed = aside => aside?.closest('[data-app-shell-frame]')?.getAttribute('data-app-shell-sidebar-open') === 'false';
  const eligible = aside => {
    const navigation = aside?.querySelector('[class*="_ConversationSidebar_"]');
    return aside?.isConnected && closed(aside) && finePointer.matches && !desktopPeek.matches &&
      !aside.hasAttribute('data-slate-sidebar-peeking') && navigation?.getBoundingClientRect().width > 0;
  };
  const within = node => node instanceof Element && (active?.aside.contains(node) ||
    !!node.closest('[data-overlay-owner="slate-sidebar"]'));
  const cancelEnter = () => {clearTimeout(enterTimer); enterTimer = 0; pending = null;};
  const cancelLeave = () => {clearTimeout(leaveTimer); leaveTimer = 0;};
  const close = () => {
    cancelEnter(); cancelLeave();
    if (!active) return;
    const {aside, drawer, inert} = active;
    active = null;
    aside.removeAttribute('data-gem-v31-sidebar-peek');
    aside.style.removeProperty('--gem-v31-sidebar-peek-width');
    // A native pin/peek transition may already have made the list interactive.
    if (closed(aside) && !aside.hasAttribute('data-slate-sidebar-peeking')) drawer.inert = inert;
  };
  const updateWidth = () => {
    if (!active) return;
    const r = active.drawer.getBoundingClientRect(), a = active.aside.getBoundingClientRect();
    const width = Math.min(Math.max(a.width + 176, r.right - a.left), window.innerWidth - 12);
    const value = Math.round(width) + 'px';
    if (active.aside.style.getPropertyValue('--gem-v31-sidebar-peek-width') !== value) {
      active.aside.style.setProperty('--gem-v31-sidebar-peek-width', value);
    }
  };
  const open = trigger => {
    const aside = trigger?.closest('aside.app-shell-left-panel');
    if (suppressed || !eligible(aside)) return;
    const drawer = aside.querySelector('[data-slate-sidebar-content]');
    if (active?.drawer !== drawer) {
      close();
      active = {aside, drawer, inert: drawer.inert};
      updateWidth();
      aside.setAttribute('data-gem-v31-sidebar-peek', 'true');
    }
    drawer.inert = false;
  };
  const enter = event => {
    const target = event.target instanceof Element ? event.target : null;
    if (within(target)) cancelLeave();
    const trigger = target?.closest(homeSelector);
    if (!trigger) {
      if (target?.closest('[data-slate-sidebar-peek-area]')) close();
      return;
    }
    if (event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget)) return;
    suppressed = false;
    if (!eligible(trigger.closest('aside.app-shell-left-panel'))) return;
    cancelLeave();
    if (active || pending === trigger) return;
    cancelEnter(); pending = trigger;
    enterTimer = window.setTimeout(() => {pending = null; enterTimer = 0; open(trigger);}, 120);
  };
  const leave = event => {
    const next = event.relatedTarget;
    if (within(next) || (pending && next instanceof Node && pending.contains(next))) return;
    cancelEnter();
    if (active) {
      cancelLeave();
      leaveTimer = window.setTimeout(close, 180);
    }
  };
  const pointerDown = event => {
    if (!within(event.target)) close();
    else if (event.target instanceof Element && event.target.closest('[data-slate-sidebar-peek-area]:not(' + homeSelector + ')')) close();
  };
  const keyDown = event => {
    if (event.key !== 'Escape') return;
    // A native menu owns the first Escape while it has keyboard focus.
    if (event.target instanceof Element && event.target.closest('[data-overlay-owner="slate-sidebar"]')) return;
    suppressed = true; close();
  };
  const sync = () => {
    if (active && (!eligible(active.aside) || !active.drawer.isConnected)) close();
    if (active) {active.drawer.inert = false; updateWidth();}
  };
  document.addEventListener('pointerover', enter, true);
  document.addEventListener('pointerout', leave, true);
  document.addEventListener('pointerdown', pointerDown, true);
  document.addEventListener('keydown', keyDown, true);
  window.addEventListener('blur', close);
  const hovered = document.querySelector(homeSelector + ':hover');
  if (hovered) open(hovered);
  return {
    sync,
    dispose() {
      close();
      document.removeEventListener('pointerover', enter, true);
      document.removeEventListener('pointerout', leave, true);
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('blur', close);
    }
  };
}
