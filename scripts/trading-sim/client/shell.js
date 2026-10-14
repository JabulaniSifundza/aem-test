/**
 * The terminal shell, shared by the plain HTML app (app/app.js) and the EDS blocks
 * (blocks/trading-*): the account header, the side menu, workspace tabs and the dock around the
 * widgets. It owns no trading logic; it wires the services (services.js) to the widgets.
 *
 *   mountSimulator(root, services)       everything: header, menu, workspaces, dock
 *   mountWidgets(root, services, spec)   just a dock with the given layout (one or more widgets)
 *   mountAccountStrip(root, services)    just the header
 *
 * Several mounts on one page share one set of services, so an order placed in one shows in all.
 */
// The design language's terminal behaviours (switches, steppers, segmented controls, pills, menus,
// dialog close buttons). Imported here so every page that mounts the shell has them.
import '../vendor/design-language/js/terminal.js';
import { createDock } from './ui/dock.js';
import { loadWorkspaces, TEMPLATES, fromSpec } from './state/workspaces.js';
import { widgetDefs, MENU } from './widgets/index.js';
import { createTicket } from './widgets/ticket.js';
import { errorText } from './widgets/common.js';
import { el, icon, iconButton } from './ui/dom.js';
import { toast, confirm, openMenu, promptText, switchField, dialog } from './ui/feedback.js';
import { formatMoney, formatClock, signClass } from './ui/format.js';

/** @typedef {import('./widgets/common.js').AppContext} AppContext */
/** @typedef {import('./services.js').Services} Services */

/** Widgets that make sense once per dock: opening another focuses the existing one. */
const SINGLETONS = new Set(['markets', 'positions', 'orders', 'executions', 'trade-log', 'data-window', 'news', 'options', 'calendar', 'commentary', 'cme-news', 'discover', 'education', 'trade-plan']);

/** @type {WeakSet<object>} */
const wired = new WeakSet();

/**
 * Page-wide wiring, once per set of services: notifications become toasts, records are saved on
 * leaving the page.
 * @param {Services} services
 */
function wirePage(services) {
  if (wired.has(services)) return;
  wired.add(services);
  services.host.on('notification', (n) => toast({ title: n.title, text: n.text, type: n.type }));
  window.addEventListener('pagehide', () => { services.records.flush?.(); });
}

/**
 * A context for one mount: the services plus where tickets and new widgets go.
 * @param {Services} services @param {HTMLElement} root @param {(kind: string, params?: Record<string, any>) => void} openWidget
 * @returns {AppContext}
 */
function contextFor(services, root, openWidget) {
  const ctx = /** @type {AppContext} */ (/** @type {unknown} */ ({ ...services, root }));
  // The settings object stays shared with services (setSetting writes to it).
  Object.defineProperty(ctx, 'settings', { get: () => services.settings });
  ctx.openTicket = (o) => openTicket(ctx, o);
  ctx.openWidget = openWidget;
  return ctx;
}

/**
 * Make an element a terminal root that follows the theme setting; the page follows it too.
 * @param {HTMLElement} root @param {AppContext} ctx
 */
function bindTheme(root, ctx) {
  root.classList.add('cme-terminal');
  /** @param {string} theme */
  const apply = (theme) => {
    root.dataset.theme = theme;
    root.classList.toggle('cme-inverse', theme === 'dark');
    // The page around the terminal follows it (design language 1.2.3 page-dark theme), so a
    // dark terminal on an EDS page does not sit between a white header and footer.
    document.documentElement.dataset.cmeTheme = theme;
  };
  apply(ctx.settings.theme);
  ctx.on('theme', apply);
}

/**
 * The account header: funds, P&L, margin, clock, connection, 1-Click, user menu.
 * @param {AppContext} ctx @param {{ userName: string }} o
 */
function buildHeader(ctx, { userName }) {
  // ---------------------------------------------------------------- header
  const stat = (/** @type {string} */ label) => {
    const value = el('span', { class: 'cme-account-stat__value' }, '–');
    return { value, node: el('div', { class: 'cme-account-stat' }, el('span', { class: 'cme-account-stat__label' }, label), value) };
  };
  const funds = stat('Practice funds'), pl = stat('Profit/loss'), margin = stat('Margin'), available = stat('Available');
  /** @param {Record<string, any>} a */
  const showAccount = (a) => {
    funds.value.textContent = formatMoney(a.balance);
    pl.value.textContent = formatMoney(a.unrealizedPL, true);
    pl.value.className = `cme-account-stat__value ${signClass(a.unrealizedPL)}`.trim();
    margin.value.textContent = formatMoney(a.marginUsed);
    available.value.textContent = formatMoney(a.freeMargin);
  };
  showAccount(ctx.broker.account());
  ctx.host.on('equity', showAccount);

  const clock = el('span', { class: 'cme-terminal-header__clock', 'aria-label': 'Simulated time' });
  const tick = () => { if (!clock.isConnected && started) { clearInterval(timer); return; } clock.textContent = formatClock(ctx.now()); };
  let started = false;
  tick();
  const timer = setInterval(() => { started = true; tick(); }, 1000);

  const conn = el('span', { class: 'ts-conn', role: 'status' });
  /** @param {'connecting' | 'connected' | 'disconnected'} s */
  const showConn = (s) => {
    conn.dataset.status = s;
    conn.textContent = s === 'connected' ? 'Live' : s === 'connecting' ? 'Connecting' : 'Offline';
  };
  const status = ctx.broker.connectionStatus();
  showConn(status === 1 ? 'connected' : status === 2 ? 'connecting' : 'disconnected');
  ctx.host.on('connection', (s) => {
    showConn(s);
    if (s === 'disconnected') toast({ title: 'Connection lost', text: 'Reconnecting. Prices and orders resume when the connection is back.', type: 'error' });
  });

  const oneClick = switchField({ label: '1-Click', checked: ctx.settings.oneClick, name: 'one-click' });
  oneClick.sw.addEventListener('cme:change', async () => {
    if (oneClick.checked) {
      const ok = await confirm({
        title: 'Turn on 1-Click trading',
        text: 'Orders from the chart and the price ladder will be placed as soon as you click, without a preview, and cancels will not ask first.',
        confirm: 'Turn on',
      });
      if (!ok) { oneClick.set(false); return; }
    }
    ctx.setSetting('oneClick', oneClick.checked);
  });
  const oneClickInfo = iconButton('info', 'About 1-Click trading', {
    class: 'cme-icon-btn--sm',
    onclick: () => dialog({ title: '1-Click trading', body: el('p', { class: 'cme-mb-0' }, 'With 1-Click on, the Buy and Sell buttons on charts and the price ladder place orders straight away. With it off, you see a preview first. The order ticket always shows a preview.') }),
  }, 'sm');

  const userBtn = el('button', { class: 'ts-user', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    el('span', { class: 'cme-visually-hidden' }, 'Account menu: '),
    el('span', { class: 'cme-avatar', 'aria-hidden': 'true' }, userName[0].toUpperCase()),
    el('span', {}, el('span', { class: 'cme-terminal-header__name' }, userName), el('span', { class: 'cme-terminal-header__mode' }, ctx.mode === 'server' ? 'Practice · server' : 'Practice · in this browser')));
  userBtn.addEventListener('click', () => openMenu(userBtn, [
    { label: 'Light theme', checked: ctx.settings.theme === 'light', onSelect: () => setTheme('light') },
    { label: 'Dark theme', checked: ctx.settings.theme === 'dark', onSelect: () => setTheme('dark') },
    'separator',
    { label: 'Reset practice account…', danger: true, onSelect: resetAccount },
  ], { align: 'right', label: 'Account' }));

  /** @param {'light' | 'dark'} theme */
  function setTheme(theme) {
    ctx.setSetting('theme', theme);
    ctx.emit('theme', theme);
  }

  async function resetAccount() {
    const ok = await confirm({ title: 'Reset practice account', text: 'Close every position, cancel every order and start again with the starting funds? Your trade history is cleared too.', confirm: 'Reset account', kind: 'danger' });
    if (!ok) return;
    try {
      await ctx.broker.resetAccount();
      toast({ title: 'Account reset', text: 'You have your starting funds again.', type: 'success' });
    } catch (error) { toast({ title: 'Could not reset the account', text: errorText(error), type: 'error' }); }
  }

  const header = el('header', { class: 'cme-terminal-header' },
    el('div', { class: 'cme-terminal-header__brand' }, el('span', { class: 'ts-brand' }, 'Trading Simulator')),
    el('div', { class: 'cme-terminal-header__stats', role: 'group', 'aria-label': 'Account' }, funds.node, pl.node, margin.node, available.node),
    el('span', { class: 'cme-terminal-header__spacer' }),
    conn, clock,
    el('div', { class: 'ts-one-click' }, oneClick.node, oneClickInfo),
    userBtn);

  return header;
}

/**
 * The whole simulator: header, side menu, workspace tabs and dock.
 * @param {HTMLElement} root @param {Services} services
 * @param {{ userName?: string, menu?: boolean, template?: string }} [o]  template: the first workspace of a new user
 */
export async function mountSimulator(root, services, { userName = 'demo', menu: showMenu = true, template } = {}) {
  wirePage(services);
  const ctx = contextFor(services, root, (kind, params) => openWidget(kind, params));
  bindTheme(root, ctx);
  const header = buildHeader(ctx, { userName });
  const defs = widgetDefs(ctx);

  // ---------------------------------------------------------------- side menu
  const menu = el('nav', { class: 'cme-side-menu', 'aria-label': 'Widgets' });
  const menuToggle = el('button', { class: 'cme-side-menu__toggle', type: 'button', 'aria-expanded': 'true' });
  /** @param {boolean} collapsed */
  const setCollapsed = (collapsed) => {
    menu.classList.toggle('cme-side-menu--collapsed', collapsed);
    menuToggle.setAttribute('aria-expanded', String(!collapsed));
    menuToggle.replaceChildren(collapsed ? '' : el('span', { class: 'cme-side-menu__label' }, 'Hide menu'), icon(collapsed ? 'chevron-right' : 'chevron-left'));
    menuToggle.setAttribute('aria-label', collapsed ? 'Show menu' : 'Hide menu');
  };
  menuToggle.addEventListener('click', () => {
    const next = !menu.classList.contains('cme-side-menu--collapsed');
    setCollapsed(next);
    ctx.setSetting('menuCollapsed', next);
  });
  setCollapsed(ctx.settings.menuCollapsed);
  menu.append(menuToggle);
  for (const section of MENU) {
    menu.append(el('h2', { class: 'cme-side-menu__section' }, section.title));
    menu.append(el('ul', { class: 'cme-side-menu__list' }, ...section.items.map((item) => {
      const def = defs.get(item.kind);
      return el('li', {}, el('button', { class: 'cme-side-menu__item', type: 'button', title: item.label, onclick: () => openWidget(item.kind, item.params) },
        icon(def?.icon ?? 'plus'), el('span', { class: 'cme-side-menu__label' }, item.label)));
    })));
  }

  // ---------------------------------------------------------------- workspaces and dock
  const workspaces = await loadWorkspaces(ctx.records, template);
  const dockEl = el('div', { class: 'cme-dock' });
  const dock = createDock({ root: dockEl, defs, onChange: (state) => workspaces.updateActive(state) });

  const tabList = el('div', { class: 'cme-workspace-tabs__list', role: 'tablist', 'aria-label': 'Workspaces' });
  const addBtn = iconButton('plus', 'New workspace', { class: 'cme-workspace-tabs__add', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  addBtn.addEventListener('click', () => openMenu(addBtn, TEMPLATES.map((t) => ({ label: t.name, onSelect: () => { workspaces.create(t.id); showWorkspace(); } })), { label: 'New workspace from' }));
  const actionsBtn = iconButton('kebab', 'Workspace actions', { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  actionsBtn.addEventListener('click', () => workspaceMenu(actionsBtn, workspaces.active.id));
  const wsTabs = el('div', { class: 'cme-workspace-tabs' }, tabList, addBtn, actionsBtn);

  function renderTabs() {
    const activeId = workspaces.active.id;
    tabList.replaceChildren(...workspaces.store.list.map((ws) => {
      const name = el('button', {
        class: 'cme-workspace-tabs__name', type: 'button', role: 'tab', 'aria-selected': String(ws.id === activeId), tabindex: ws.id === activeId ? '0' : '-1',
        title: ws.favorite ? `${ws.name} (favourite)` : ws.name,
        onclick: () => { if (ws.id !== workspaces.active.id) { workspaces.activate(ws.id); showWorkspace(); } },
        ondblclick: () => rename(ws.id),
        onkeydown: (/** @type {KeyboardEvent} */ e) => {
          const tabs = /** @type {HTMLButtonElement[]} */ ([...tabList.querySelectorAll('[role="tab"]')]);
          const i = tabs.indexOf(/** @type {HTMLButtonElement} */ (e.currentTarget));
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]?.focus(); }
          else if (e.key === 'F2') { e.preventDefault(); rename(ws.id); }
          else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); workspaceMenu(/** @type {HTMLElement} */ (e.currentTarget), ws.id); }
        },
        oncontextmenu: (/** @type {MouseEvent} */ e) => { e.preventDefault(); workspaceMenu(/** @type {HTMLElement} */ (e.currentTarget), ws.id); },
      }, ws.name);
      const kebab = iconButton('kebab', `Actions for ${ws.name}`, { class: 'cme-icon-btn--sm', tabindex: '-1', 'aria-hidden': 'true', onclick: (/** @type {MouseEvent} */ e) => workspaceMenu(/** @type {HTMLElement} */ (e.currentTarget), ws.id) }, 'sm');
      return el('div', { class: `cme-workspace-tabs__tab${ws.id === activeId ? ' is-active' : ''}`, role: 'presentation' },
        ws.favorite ? icon('star-filled', 'sm') : null, name, kebab);
    }));
  }

  /** @param {HTMLElement} anchor @param {string} id */
  function workspaceMenu(anchor, id) {
    const ws = workspaces.store.list.find((w) => w.id === id);
    if (!ws) return;
    openMenu(anchor, [
      { label: 'Rename…', onSelect: () => rename(id) },
      { label: 'Duplicate', onSelect: () => { workspaces.duplicate(id); showWorkspace(); } },
      { label: ws.favorite ? 'Favourite (opens first)' : 'Make favourite', disabled: ws.favorite, onSelect: () => { workspaces.setFavorite(id); renderTabs(); } },
      'separator',
      { label: 'Delete…', danger: true, disabled: workspaces.store.list.length <= 1, onSelect: () => remove(id) },
    ], { label: `Workspace ${ws.name}` });
  }

  /** @param {string} id */
  async function rename(id) {
    const ws = workspaces.store.list.find((w) => w.id === id);
    if (!ws) return;
    const name = await promptText({ title: 'Rename workspace', label: 'Workspace name', value: ws.name, confirm: 'Rename' });
    if (name) { workspaces.rename(id, name); renderTabs(); }
  }

  /** @param {string} id */
  async function remove(id) {
    const ws = workspaces.store.list.find((w) => w.id === id);
    if (!ws) return;
    if (!(await confirm({ title: 'Delete workspace', text: `Delete “${ws.name}” and its layout?`, confirm: 'Delete', kind: 'danger' }))) return;
    const wasActive = workspaces.active.id === id;
    workspaces.remove(id);
    if (wasActive) showWorkspace(); else renderTabs();
  }

  function showWorkspace() {
    dock.load(workspaces.active.dock);
    renderTabs();
  }

  /** @param {string} kind @param {Record<string, any>} [params] */
  function openWidget(kind, params = {}) {
    if (!defs.has(kind)) return;
    if (SINGLETONS.has(kind) && dock.focus((ref) => ref.kind === kind)) return;
    dock.add(kind, params);
  }

  root.replaceChildren(header, el('div', { class: 'cme-terminal__body' }, ...(showMenu ? [menu] : []), el('main', { class: 'cme-terminal__main' }, wsTabs, dockEl)));
  showWorkspace();
  return { dock, destroy: () => dock.destroy() };
}

/**
 * A dock with a fixed starting layout and no workspace tabs, for a page that places one or a few
 * widgets (an EDS block). Widgets opened from inside it (a chart from the markets grid) join it.
 * @param {HTMLElement} root @param {Services} services @param {any} spec  a layout for fromSpec() (state/workspaces.js)
 */
export function mountWidgets(root, services, spec) {
  wirePage(services);
  const ctx = contextFor(services, root, (kind, params) => {
    if (SINGLETONS.has(kind) && dock.focus((ref) => ref.kind === kind)) return;
    dock.add(kind, params);
  });
  bindTheme(root, ctx);
  const dockEl = el('div', { class: 'cme-dock' });
  const dock = createDock({ root: dockEl, defs: widgetDefs(ctx), onChange: () => {} });
  root.replaceChildren(dockEl);
  dock.load(fromSpec(spec));
  return { dock, destroy: () => dock.destroy() };
}

/**
 * Just the account header (funds, P&L, margin, clock, 1-Click, theme and reset).
 * @param {HTMLElement} root @param {Services} services @param {{ userName?: string }} [o]
 */
export function mountAccountStrip(root, services, { userName = 'demo' } = {}) {
  wirePage(services);
  const ctx = contextFor(services, root, () => {});
  bindTheme(root, ctx);
  root.replaceChildren(buildHeader(ctx, { userName }));
}

/**
 * The order ticket as a floating dialog (from a grid's Trade button or the chart's menu).
 * @param {AppContext} ctx @param {{ symbol: string, side?: 'BUY' | 'SELL', type?: any, price?: string }} o
 */
function openTicket(ctx, o) {
  const dlg = /** @type {HTMLDialogElement} */ (el('dialog', { class: 'cme-tdialog ts-ticket-dialog', 'aria-label': `Trade ${o.symbol}` }));
  ctx.root.append(dlg);
  const ticket = createTicket(ctx, dlg, { ...o, onClose: () => dlg.close() });
  dlg.addEventListener('close', () => { ticket.destroy(); dlg.remove(); }, { once: true });
  dlg.showModal();
}
