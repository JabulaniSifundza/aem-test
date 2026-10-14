/**
 * The docking layout (requirement X-2): panels in nested rows and columns, tabs in each panel,
 * drag a tab onto another panel (as a tab, or to an edge to split), resize with the gutters,
 * maximise a panel, pop a widget out into its own window, close tabs.
 *
 * The layout is plain data (DockState) so a workspace can be saved and restored. Widgets are
 * created once and moved between panels without being rebuilt, so a chart keeps its state when its
 * tab is dragged.
 */
import { el, icon, iconButton, clear, uid } from './dom.js';

/**
 * @typedef {{ type: 'split', dir: 'row' | 'column', sizes: number[], children: DockNode[] }} SplitNode
 * @typedef {{ type: 'group', id: string, tabs: string[], active: string }} GroupNode
 * @typedef {SplitNode | GroupNode} DockNode
 * @typedef {{ kind: string, params: Record<string, any> }} WidgetRef
 * @typedef {{ layout: DockNode | null, widgets: Record<string, WidgetRef>, maximized?: string | null }} DockState
 */

/**
 * @typedef {object} WidgetInstance
 * @property {() => void} destroy
 * @property {() => Record<string, any>} [state]    params to save with the workspace
 * @property {() => void} [resize]
 * @property {() => void} [show]                    the widget became visible
 */

/**
 * @typedef {object} WidgetDef
 * @property {string} kind
 * @property {string} icon
 * @property {(params: Record<string, any>) => string} title
 * @property {(container: HTMLElement, params: Record<string, any>, api: WidgetApi) => WidgetInstance} create
 */

/**
 * @typedef {object} WidgetApi
 * @property {(title: string) => void} setTitle
 * @property {(params: Record<string, any>) => void} setParams   merge and save params
 * @property {() => void} close
 * @property {string} id
 */

const EDGE = 0.25; // share of a panel's width/height that counts as its edge when dropping

/**
 * @param {{ root: HTMLElement, defs: Map<string, WidgetDef>, onChange: (state: DockState) => void, emptyText?: string }} options
 */
export function createDock({ root, defs, onChange, emptyText = 'Add widgets from the menu on the left.' }) {
  /** @type {DockState} */
  let state = { layout: null, widgets: {}, maximized: null };
  /** @type {Map<string, { host: HTMLElement, instance: WidgetInstance, title: string, popup: Window | null }>} */
  const live = new Map();
  /** @type {string | null} */
  let focusedGroup = null;
  /** @type {string | null} */
  let dragging = null;

  const ro = new ResizeObserver(() => { for (const w of live.values()) w.instance.resize?.(); });
  ro.observe(root);

  // ------------------------------------------------------------------ tree helpers

  /** @param {DockNode | null} node @param {(g: GroupNode) => void} fn */
  function eachGroup(node, fn) {
    if (!node) return;
    if (node.type === 'group') fn(node);
    else node.children.forEach((c) => eachGroup(c, fn));
  }
  /** @param {string} id */
  function findGroup(id) {
    /** @type {GroupNode | null} */
    let found = null;
    eachGroup(state.layout, (g) => { if (g.id === id) found = g; });
    return /** @type {GroupNode | null} */ (found);
  }
  /** @param {string} widgetId */
  function groupOf(widgetId) {
    /** @type {GroupNode | null} */
    let found = null;
    eachGroup(state.layout, (g) => { if (g.tabs.includes(widgetId)) found = g; });
    return /** @type {GroupNode | null} */ (found);
  }
  /** Remove empty groups and collapse single-child splits. @param {DockNode | null} node @returns {DockNode | null} */
  function normalize(node) {
    if (!node) return null;
    if (node.type === 'group') return node.tabs.length ? node : null;
    const kept = [];
    const sizes = [];
    for (let i = 0; i < node.children.length; i += 1) {
      const c = normalize(node.children[i]);
      if (!c) continue;
      if (c.type === 'split' && c.dir === node.dir) {
        // Flatten nested splits in the same direction.
        const share = node.sizes[i] ?? 1;
        const total = c.sizes.reduce((a, b) => a + b, 0) || 1;
        c.children.forEach((cc, j) => { kept.push(cc); sizes.push(share * (c.sizes[j] / total)); });
      } else { kept.push(c); sizes.push(node.sizes[i] ?? 1); }
    }
    if (!kept.length) return null;
    if (kept.length === 1) return kept[0];
    return { ...node, children: kept, sizes };
  }
  /** Replace a node in the tree. @param {DockNode} target @param {DockNode} replacement */
  function replaceNode(target, replacement) {
    if (state.layout === target) { state.layout = replacement; return; }
    /** @param {DockNode} node */
    const visit = (node) => {
      if (node.type !== 'split') return false;
      const i = node.children.indexOf(target);
      if (i >= 0) { node.children[i] = replacement; return true; }
      return node.children.some(visit);
    };
    if (state.layout) visit(state.layout);
  }

  const newGroup = (/** @type {string} */ widgetId) => /** @type {GroupNode} */ ({ type: 'group', id: uid('grp'), tabs: [widgetId], active: widgetId });

  // ------------------------------------------------------------------ widgets

  /** @param {string} id */
  function ensureWidget(id) {
    const existing = live.get(id);
    if (existing) return existing;
    const ref = state.widgets[id];
    const def = defs.get(ref.kind);
    const host = el('div', { class: 'cme-panel__body cme-panel__body--flush ts-widget', id: `w-${id}`, role: 'tabpanel', 'aria-labelledby': `t-${id}`, 'data-widget': ref.kind });
    const entry = { host, instance: /** @type {WidgetInstance} */ ({ destroy() {} }), title: def ? def.title(ref.params) : ref.kind, popup: /** @type {Window | null} */ (null) };
    live.set(id, entry);
    /** @type {WidgetApi} */
    const api = {
      id,
      setTitle(title) { entry.title = title; const t = root.querySelector(`[data-tab="${id}"] .cme-panel__tab-label`); if (t) t.textContent = title; },
      setParams(params) { state.widgets[id] = { ...state.widgets[id], params: { ...state.widgets[id].params, ...params } }; emit(); },
      close() { closeWidget(id); },
    };
    if (def) {
      try { entry.instance = def.create(host, ref.params, api); } catch (error) {
        console.error(error);
        host.appendChild(el('div', { class: 'cme-tempty' }, `This widget failed to load: ${/** @type {Error} */ (error).message}`));
      }
    } else host.appendChild(el('div', { class: 'cme-tempty' }, `Unknown widget "${ref.kind}"`));
    return entry;
  }

  /** @param {string} id */
  function closeWidget(id) {
    const g = groupOf(id);
    if (g) {
      g.tabs = g.tabs.filter((t) => t !== id);
      if (g.active === id) g.active = g.tabs[Math.max(0, g.tabs.length - 1)] ?? '';
    }
    const entry = live.get(id);
    entry?.popup?.close();
    entry?.instance.destroy();
    entry?.host.remove();
    live.delete(id);
    delete state.widgets[id];
    state.layout = normalize(state.layout);
    if (state.maximized && !findGroup(state.maximized)) state.maximized = null;
    render();
    emit();
  }

  function emit() {
    for (const [id, w] of live) {
      const saved = w.instance.state?.();
      if (saved && state.widgets[id]) state.widgets[id] = { ...state.widgets[id], params: { ...state.widgets[id].params, ...saved } };
    }
    onChange(getState());
  }

  // ------------------------------------------------------------------ rendering

  function render() {
    // Keep widget hosts alive while the structure is rebuilt.
    for (const w of live.values()) if (!w.popup) w.host.remove();
    clear(root);
    if (!state.layout) { root.appendChild(el('div', { class: 'cme-dock__empty' }, emptyText)); return; }
    const maximized = state.maximized ? findGroup(state.maximized) : null;
    root.appendChild(maximized ? renderGroup(maximized, true) : renderNode(state.layout));
    for (const w of live.values()) if (!w.host.hidden) w.instance.resize?.();
  }

  /** @param {DockNode} node @returns {HTMLElement} */
  function renderNode(node) {
    if (node.type === 'group') return renderGroup(node, false);
    const box = el('div', { class: `cme-dock__split cme-dock__split--${node.dir}` });
    const total = node.sizes.reduce((a, b) => a + b, 0) || 1;
    node.children.forEach((child, i) => {
      if (i > 0) box.appendChild(sash(node, i, box));
      const c = renderNode(child);
      c.style.flex = `${node.sizes[i] / total} 1 0`;
      box.appendChild(c);
    });
    return box;
  }

  /** @param {GroupNode} g @param {boolean} maximized */
  function renderGroup(g, maximized) {
    const tablist = el('div', { class: 'cme-panel__tablist', role: 'tablist', 'aria-label': 'Widgets in this panel' });
    for (const id of g.tabs) {
      const w = ensureWidget(id);
      const selected = id === g.active;
      const label = el('button', {
        class: 'cme-panel__tab-label', type: 'button', role: 'tab', 'aria-selected': String(selected), 'aria-controls': `w-${id}`, id: `t-${id}`,
        tabindex: selected ? '0' : '-1', draggable: 'true',
        onclick: () => { g.active = id; focusedGroup = g.id; render(); emit(); },
        onkeydown: (/** @type {KeyboardEvent} */ e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); closeWidget(id); }
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            const i = g.tabs.indexOf(id);
            const next = g.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + g.tabs.length) % g.tabs.length];
            g.active = next; render(); /** @type {HTMLElement | null} */ (root.querySelector(`[data-tab="${next}"] .cme-panel__tab-label`))?.focus();
          }
        },
        ondragstart: (/** @type {DragEvent} */ e) => { dragging = id; e.dataTransfer?.setData('text/plain', id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; },
        ondragend: () => { dragging = null; clearDropMarks(); },
      }, w.title);
      tablist.appendChild(el('div', { class: `cme-panel__tab${selected ? ' is-active' : ''}`, role: 'presentation', 'data-tab': id },
        label,
        el('button', { class: 'cme-panel__tab-close', type: 'button', tabindex: '-1', 'aria-hidden': 'true', title: `Close ${w.title}`, onclick: () => closeWidget(id) }, icon('close', 'sm'))));
    }
    const active = live.get(g.active);
    const actions = el('div', { class: 'cme-panel__actions' },
      iconButton(maximized ? 'restore' : 'maximize', maximized ? 'Restore' : 'Maximise', { onclick: () => { state.maximized = maximized ? null : g.id; render(); emit(); } }),
      iconButton('popout', 'Open in a new window', { onclick: () => popOut(g.active), disabled: !active || Boolean(active.popup) }));
    const body = el('div', { class: 'cme-panel__body cme-panel__body--flush' });
    for (const id of g.tabs) {
      const w = /** @type {NonNullable<ReturnType<typeof live.get>>} */ (live.get(id));
      if (w.popup) {
        if (id === g.active) body.appendChild(el('div', { class: 'cme-tempty' }, 'Open in another window.', el('button', { class: 'cme-tbtn cme-tbtn--outline', type: 'button', onclick: () => w.popup?.close() }, 'Bring it back')));
        continue;
      }
      w.host.hidden = id !== g.active;
      body.appendChild(w.host);
      if (id === g.active) w.instance.show?.();
    }
    const panel = el('section', {
      class: `cme-panel${maximized ? ' cme-panel--maximized' : ''}`, 'aria-label': active?.title ?? 'Panel', 'data-group': g.id,
      onfocusin: () => { focusedGroup = g.id; },
      onmousedown: () => { focusedGroup = g.id; },
      ondragover: (/** @type {DragEvent} */ e) => { if (!dragging) return; e.preventDefault(); markDrop(panel, zoneOf(panel, e)); },
      ondragleave: (/** @type {DragEvent} */ e) => { if (!panel.contains(/** @type {Node} */ (e.relatedTarget))) clearDropMarks(); },
      ondrop: (/** @type {DragEvent} */ e) => { e.preventDefault(); const id = dragging; clearDropMarks(); if (id) moveWidget(id, g.id, zoneOf(panel, e)); },
    }, el('div', { class: 'cme-panel__tabs' }, tablist, actions), body);
    return panel;
  }

  /** A resize handle between child i-1 and i. @param {SplitNode} node @param {number} i @param {HTMLElement} box */
  function sash(node, i, box) {
    const handle = el('div', { class: 'cme-dock__sash', role: 'separator', 'aria-orientation': node.dir === 'row' ? 'vertical' : 'horizontal', 'aria-label': 'Resize panels', tabindex: '0' });
    const horizontal = node.dir === 'row';
    /** The share of the pair before the handle, as a percentage (a focusable separator is a slider). */
    const report = () => {
      const pair = node.sizes[i - 1] + node.sizes[i];
      const v = Math.round((node.sizes[i - 1] / pair) * 100);
      handle.setAttribute('aria-valuenow', String(v));
      handle.setAttribute('aria-valuetext', `${v}%`);
    };
    handle.setAttribute('aria-valuemin', '0');
    handle.setAttribute('aria-valuemax', '100');
    report();
    /** @param {number} delta fraction of the container */
    const moveBy = (delta) => {
      const total = node.sizes.reduce((a, b) => a + b, 0);
      const a = node.sizes[i - 1] / total;
      const b = node.sizes[i] / total;
      const min = 0.08;
      const d = Math.max(min - a, Math.min(b - min, delta));
      node.sizes[i - 1] = (a + d) * total;
      node.sizes[i] = (b - d) * total;
      const kids = [...box.children].filter((c) => !c.classList.contains('cme-dock__sash'));
      kids.forEach((c, j) => { /** @type {HTMLElement} */ (c).style.flex = `${node.sizes[j] / total} 1 0`; });
      report();
      for (const w of live.values()) w.instance.resize?.();
    };
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('is-dragging');
      const rect = box.getBoundingClientRect();
      let last = horizontal ? e.clientX : e.clientY;
      const size = horizontal ? rect.width : rect.height;
      const move = (/** @type {PointerEvent} */ ev) => { const p = horizontal ? ev.clientX : ev.clientY; moveBy((p - last) / size); last = p; };
      const up = () => { handle.classList.remove('is-dragging'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); emit(); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const keys = horizontal ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      moveBy(e.key === keys[0] ? -step : step);
      emit();
    });
    return handle;
  }

  // ------------------------------------------------------------------ drag and drop

  /** @param {HTMLElement} panel @param {DragEvent} e @returns {'center' | 'left' | 'right' | 'top' | 'bottom'} */
  function zoneOf(panel, e) {
    const r = panel.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (e.clientY - r.top < 34) return 'center'; // over the tab strip: add as a tab
    if (x < EDGE) return 'left';
    if (x > 1 - EDGE) return 'right';
    if (y < EDGE) return 'top';
    if (y > 1 - EDGE) return 'bottom';
    return 'center';
  }
  /** @param {HTMLElement} panel @param {string} zone */
  function markDrop(panel, zone) {
    root.querySelectorAll('.cme-panel--drop-target').forEach((p) => { if (p !== panel) { p.classList.remove('cme-panel--drop-target'); p.removeAttribute('data-drop'); } });
    panel.classList.add('cme-panel--drop-target');
    panel.setAttribute('data-drop', zone);
  }
  function clearDropMarks() {
    root.querySelectorAll('.cme-panel--drop-target').forEach((p) => { p.classList.remove('cme-panel--drop-target'); p.removeAttribute('data-drop'); });
  }

  /**
   * Move a widget onto a panel: as a tab (center) or into a new panel beside it.
   * @param {string} id @param {string} targetGroupId @param {'center' | 'left' | 'right' | 'top' | 'bottom'} zone
   */
  function moveWidget(id, targetGroupId, zone) {
    const source = groupOf(id);
    const target = findGroup(targetGroupId);
    if (!source || !target) return;
    if (source === target && (zone === 'center' || source.tabs.length === 1)) return;
    source.tabs = source.tabs.filter((t) => t !== id);
    if (source.active === id) source.active = source.tabs[0] ?? '';
    if (zone === 'center') {
      target.tabs.push(id);
      target.active = id;
    } else {
      const dir = zone === 'left' || zone === 'right' ? 'row' : 'column';
      const fresh = newGroup(id);
      const before = zone === 'left' || zone === 'top';
      /** @type {SplitNode} */
      const split = { type: 'split', dir, sizes: [1, 1], children: before ? [fresh, { ...target }] : [{ ...target }, fresh] };
      replaceNode(target, split);
    }
    state.layout = normalize(state.layout);
    render();
    emit();
  }

  // ------------------------------------------------------------------ pop-out

  /** Move a widget into its own browser window; closing the window brings it back. @param {string} id */
  function popOut(id) {
    const w = live.get(id);
    if (!w || w.popup) return;
    const popup = window.open('', `ts-${id}`, 'width=900,height=640');
    if (!popup) return;
    const doc = popup.document;
    doc.title = w.title;
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      doc.head.appendChild(el('link', { rel: 'stylesheet', href: /** @type {HTMLLinkElement} */ (link).href }));
    }
    const term = /** @type {HTMLElement} */ (root.closest('.cme-terminal') ?? document.querySelector('.cme-terminal'));
    const shell = doc.createElement('div');
    shell.className = term.className;
    shell.dataset.theme = term.dataset.theme ?? 'light';
    shell.style.height = '100vh';
    doc.body.style.margin = '0';
    doc.body.appendChild(shell);
    w.host.hidden = false;
    shell.appendChild(w.host);
    w.popup = popup;
    render();
    const back = () => {
      if (!w.popup) return;
      w.popup = null;
      render();
      emit();
    };
    popup.addEventListener('pagehide', back);
    const timer = setInterval(() => { if (popup.closed) { clearInterval(timer); back(); } }, 500);
    popup.addEventListener('resize', () => w.instance.resize?.());
    setTimeout(() => w.instance.resize?.(), 100);
  }

  // ------------------------------------------------------------------ public

  function getState() {
    return /** @type {DockState} */ (JSON.parse(JSON.stringify(state)));
  }

  return {
    /** Replace the layout (switching workspace). @param {DockState} next */
    load(next) {
      for (const [, w] of live) { w.popup?.close(); w.instance.destroy(); w.host.remove(); }
      live.clear();
      state = JSON.parse(JSON.stringify(next));
      state.layout = normalize(state.layout);
      focusedGroup = null;
      render();
    },
    getState,
    /**
     * Add a widget: as a tab in the focused panel, or beside it, or as the first panel.
     * @param {string} kind @param {Record<string, any>} [params] @param {{ beside?: 'right' | 'bottom' }} [where]
     */
    add(kind, params = {}, where = {}) {
      const id = uid('w');
      state.widgets[id] = { kind, params };
      state.maximized = null;
      const target = (focusedGroup && findGroup(focusedGroup)) || (() => { /** @type {GroupNode | null} */ let first = null; eachGroup(state.layout, (g) => { first ??= g; }); return first; })();
      if (!state.layout || !target) state.layout = newGroup(id);
      else if (where.beside) {
        const split = /** @type {SplitNode} */ ({ type: 'split', dir: where.beside === 'right' ? 'row' : 'column', sizes: [2, 1], children: [{ ...target }, newGroup(id)] });
        replaceNode(target, split);
        state.layout = normalize(state.layout);
      } else { target.tabs.push(id); target.active = id; }
      render();
      emit();
      const g = groupOf(id);
      if (g) focusedGroup = g.id;
      return id;
    },
    /** Show a widget's tab if it is open. @param {(ref: WidgetRef) => boolean} match */
    focus(match) {
      for (const [id, ref] of Object.entries(state.widgets)) {
        if (!match(ref)) continue;
        const g = groupOf(id);
        if (g) { g.active = id; focusedGroup = g.id; render(); return true; }
      }
      return false;
    },
    close: closeWidget,
    destroy() { ro.disconnect(); for (const w of live.values()) { w.popup?.close(); w.instance.destroy(); } live.clear(); },
  };
}

/** @typedef {ReturnType<typeof createDock>} Dock */
