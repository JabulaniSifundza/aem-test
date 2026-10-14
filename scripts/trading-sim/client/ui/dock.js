/**
 * The docking layout (requirement X-2), behaving as the CME simulator's (dockview):
 *
 * - Docked panels sit in nested rows and columns; each panel holds tabs. Gutters resize them.
 * - A widget added to an empty workspace fills it. Added to a workspace that has panels, it opens
 *   as a **floating panel**: 600 × 400, the first at (110, 80) inside the dock and each next one
 *   60 px right and 30 px down, on top. Its tab strip moves it (it stays inside the dock), eight
 *   grips resize it, pressing on it brings it to the front, and its **Dock** button docks it as a
 *   full-width row at the top of the layout, every row then sharing the height equally.
 * - Dragging a tab onto a docked panel: the outer 20% on each side splits the panel on that side,
 *   anywhere else (or the tab strip) adds it as a tab. On a floating panel it always joins as a
 *   tab. A panel left with no tabs disappears.
 * - Docked panels can be maximised, and a widget can pop out into its own browser window.
 *
 * The layout is plain data (DockState), floating panels included, so a workspace is saved and
 * restored as it was left. Widgets are created once and moved between panels without being
 * rebuilt, so a chart keeps its state when its tab is dragged or its panel docked.
 *
 * render() rebuilds the panel frames (tabs, sashes, floating frames) from the state and
 * re-attaches the existing widget elements; it never re-creates widgets. Moving and resizing a
 * floating panel change its element's style directly while the pointer moves, and update the
 * state once on release, so dragging never re-renders. Tree operations walk the layout:
 * O(panels), and a workspace has a handful. onChange gets the new DockState after every change;
 * the shell saves it (debounced) as the workspace.
 */
import { el, icon, iconButton, clear, uid } from './dom.js';
import { toast, watchDocument } from './feedback.js';

/**
 * @typedef {{ type: 'split', dir: 'row' | 'column', sizes: number[], children: DockNode[] }} SplitNode
 * @typedef {{ type: 'group', id: string, tabs: string[], active: string }} GroupNode
 * @typedef {SplitNode | GroupNode} DockNode
 * @typedef {{ group: GroupNode, x: number, y: number, w: number, h: number }} FloatNode  px inside the dock; later entries are on top
 * @typedef {{ kind: string, params: Record<string, any> }} WidgetRef
 * @typedef {{ layout: DockNode | null, widgets: Record<string, WidgetRef>, maximized?: string | null, floating?: FloatNode[] }} DockState
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

/** Share of a docked panel's width or height that counts as its edge when dropping (dockview: 20%). */
const EDGE = 0.2;
/** Height of a panel's tab strip: drops there always add a tab. */
const TAB_STRIP = 34;
/** A new floating panel, as in the simulator. */
const FLOAT = { w: 600, h: 400, x: 110, y: 80, dx: 60, dy: 30, minW: 240, minH: 160 };
const GRIPS = /** @type {const} */ (['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']);
/** The blank same-origin page a popped-out widget opens in (no script; popOut fills it). */
const POPOUT_PAGE = new URL('./popout.html', import.meta.url).href;
/** How long to wait for that page to load before giving up, and then for its stylesheets. */
const POPOUT_LOAD_MS = 10_000;
const STYLES_LOAD_MS = 3_000;

/**
 * @param {{ root: HTMLElement, defs: Map<string, WidgetDef>, onChange: (state: DockState) => void, emptyText?: string }} options
 */
export function createDock({ root, defs, onChange, emptyText = 'Add widgets from the menu on the left.' }) {
  /** @type {Required<DockState>} */
  let state = { layout: null, widgets: {}, maximized: null, floating: [] };
  /** @type {Map<string, { host: HTMLElement, instance: WidgetInstance, title: string, popup: Window | null }>} */
  const live = new Map();
  /** @type {string | null} */
  let dragging = null;
  /** The layer that holds floating panels (rebuilt by render). */
  let floatLayer = el('div', { class: 'cme-dock__floats' });

  const ro = new ResizeObserver(() => { clampFloats(); for (const w of live.values()) w.instance.resize?.(); });
  ro.observe(root);

  // ------------------------------------------------------------------ tree helpers

  /** Every group: docked ones (tree order), then floating ones (bottom to top). @param {(g: GroupNode) => void} fn */
  function eachGroup(fn) {
    /** @param {DockNode | null} node */
    const walk = (node) => {
      if (!node) return;
      if (node.type === 'group') fn(node);
      else node.children.forEach(walk);
    };
    walk(state.layout);
    for (const f of state.floating) fn(f.group);
  }
  /** @param {string} id */
  function findGroup(id) {
    /** @type {GroupNode | null} */
    let found = null;
    eachGroup((g) => { if (g.id === id) found = g; });
    return /** @type {GroupNode | null} */ (found);
  }
  /** @param {string} widgetId */
  function groupOf(widgetId) {
    /** @type {GroupNode | null} */
    let found = null;
    eachGroup((g) => { if (g.tabs.includes(widgetId)) found = g; });
    return /** @type {GroupNode | null} */ (found);
  }
  /** The floating entry for a group, if it floats. @param {string} groupId */
  const floatOf = (groupId) => state.floating.find((f) => f.group.id === groupId) ?? null;

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
  /** Normalise the docked tree and drop floating panels that lost their last tab. */
  function tidy() {
    state.layout = normalize(state.layout);
    state.floating = state.floating.filter((f) => f.group.tabs.length);
    if (state.maximized && (!findGroup(state.maximized) || floatOf(state.maximized))) state.maximized = null;
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

  // ------------------------------------------------------------------ geometry

  /** The floating layer's size (the dock's content box). Falls back to the root's size before the first render. */
  function bounds() {
    const r = floatLayer.getBoundingClientRect();
    if (r.width && r.height) return { w: r.width, h: r.height };
    return { w: Math.max(0, root.clientWidth - 16), h: Math.max(0, root.clientHeight - 8) };
  }
  /** Keep a floating panel inside the dock (and no bigger than it). @param {FloatNode} f */
  function clamp(f) {
    const b = bounds();
    if (!b.w || !b.h) return;
    f.w = Math.min(Math.max(FLOAT.minW, f.w), Math.max(FLOAT.minW, b.w));
    f.h = Math.min(Math.max(FLOAT.minH, f.h), Math.max(FLOAT.minH, b.h));
    f.x = Math.max(0, Math.min(f.x, b.w - f.w));
    f.y = Math.max(0, Math.min(f.y, b.h - f.h));
  }
  /** After the dock shrinks: pull floating panels back inside. */
  function clampFloats() {
    for (const f of state.floating) {
      clamp(f);
      const node = /** @type {HTMLElement | null} */ (floatLayer.querySelector(`[data-float="${f.group.id}"]`));
      if (node) place(node, f);
    }
  }
  /** @param {HTMLElement} node @param {FloatNode} f */
  function place(node, f) {
    node.style.left = `${f.x}px`;
    node.style.top = `${f.y}px`;
    node.style.width = `${f.w}px`;
    node.style.height = `${f.h}px`;
  }

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
      setTitle(title) {
        entry.title = title;
        const t = root.querySelector(`[data-tab="${id}"] .cme-panel__tab-label`);
        if (t) t.textContent = title;
        if (entry.popup && !entry.popup.closed && entry.popup.document.URL !== 'about:blank') entry.popup.document.title = title;
      },
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
    tidy();
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

  /** Tell the widgets in a group that their size changed. @param {GroupNode} g */
  const resizeGroup = (g) => { for (const id of g.tabs) live.get(id)?.instance.resize?.(); };

  // ------------------------------------------------------------------ rendering

  function render() {
    // Keep widget hosts alive while the structure is rebuilt.
    for (const w of live.values()) if (!w.popup) w.host.remove();
    clear(root);
    floatLayer = el('div', { class: 'cme-dock__floats' });
    const maximized = state.maximized ? findGroup(state.maximized) : null;
    if (maximized) root.appendChild(renderGroup(maximized, { maximized: true, floating: false }));
    else if (state.layout) root.appendChild(renderNode(state.layout));
    else if (!state.floating.length) root.appendChild(el('div', { class: 'cme-dock__empty' }, emptyText));
    root.appendChild(floatLayer);
    if (!maximized) state.floating.forEach((f, i) => floatLayer.appendChild(renderFloat(f, i)));
    for (const w of live.values()) if (!w.host.hidden) w.instance.resize?.();
  }

  /** @param {DockNode} node @returns {HTMLElement} */
  function renderNode(node) {
    if (node.type === 'group') return renderGroup(node, { maximized: false, floating: false });
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

  /**
   * A panel: tab strip, actions, and the active widget.
   * @param {GroupNode} g @param {{ maximized: boolean, floating: boolean }} o
   */
  function renderGroup(g, { maximized, floating }) {
    const tablist = el('div', { class: 'cme-panel__tablist', role: 'tablist', 'aria-label': 'Widgets in this panel' });
    for (const id of g.tabs) {
      const w = ensureWidget(id);
      const selected = id === g.active;
      const label = el('button', {
        class: 'cme-panel__tab-label', type: 'button', role: 'tab', 'aria-selected': String(selected), 'aria-controls': `w-${id}`, id: `t-${id}`,
        tabindex: selected ? '0' : '-1', draggable: 'true',
        onclick: () => { g.active = id; render(); emit(); },
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
    // Floating panels have one action, Dock (as in the simulator); docked ones maximise and pop out.
    const actions = floating
      ? el('div', { class: 'cme-panel__actions' }, iconButton('dock', 'Dock', { onclick: () => dockFloat(g.id) }))
      : el('div', { class: 'cme-panel__actions' },
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
    const strip = el('div', { class: 'cme-panel__tabs' }, tablist, actions);
    const panel = el('section', {
      class: `cme-panel${maximized ? ' cme-panel--maximized' : ''}${floating ? ' cme-panel--floating' : ''}`,
      'aria-label': active?.title ?? 'Panel', 'data-group': g.id,
      ondragover: (/** @type {DragEvent} */ e) => { if (!dragging) return; e.preventDefault(); e.stopPropagation(); markDrop(panel, floating ? 'center' : zoneOf(panel, e)); },
      ondragleave: (/** @type {DragEvent} */ e) => { if (!panel.contains(/** @type {Node} */ (e.relatedTarget))) clearDropMarks(); },
      ondrop: (/** @type {DragEvent} */ e) => { e.preventDefault(); e.stopPropagation(); const id = dragging; clearDropMarks(); if (id) moveWidget(id, g.id, floating ? 'center' : zoneOf(panel, e)); },
    }, strip, body);
    if (floating) strip.addEventListener('pointerdown', (e) => startMove(e, g.id));
    return panel;
  }

  /** A floating panel's frame: position, the panel, and its resize grips. @param {FloatNode} f @param {number} i stacking order */
  function renderFloat(f, i) {
    clamp(f);
    const node = el('div', { class: 'cme-dock__float', 'data-float': f.group.id });
    place(node, f);
    node.style.zIndex = String(i + 1);
    node.appendChild(renderGroup(f.group, { maximized: false, floating: true }));
    for (const edge of GRIPS) {
      const grip = el('div', { class: `cme-dock__grip cme-dock__grip--${edge}`, 'aria-hidden': 'true' });
      grip.addEventListener('pointerdown', (e) => startResize(e, f.group.id, edge));
      node.appendChild(grip);
    }
    // Pressing anywhere on it brings it to the front (capture: before the widget handles the press).
    node.addEventListener('pointerdown', () => raise(f.group.id), true);
    return node;
  }

  /** Bring a floating panel to the front, without re-rendering (so the press still clicks). @param {string} groupId */
  function raise(groupId) {
    const i = state.floating.findIndex((f) => f.group.id === groupId);
    if (i < 0 || i === state.floating.length - 1) return;
    const [f] = state.floating.splice(i, 1);
    state.floating.push(f);
    state.floating.forEach((x, k) => {
      const node = /** @type {HTMLElement | null} */ (floatLayer.querySelector(`[data-float="${x.group.id}"]`));
      if (node) node.style.zIndex = String(k + 1);
    });
    emit();
  }

  /**
   * Move a floating panel by its tab strip. Presses on the tabs' own buttons and on the actions
   * are left alone: a tab drag moves the tab (HTML drag and drop), not the window.
   * @param {PointerEvent} e @param {string} groupId
   */
  function startMove(e, groupId) {
    const target = /** @type {HTMLElement} */ (e.target);
    if (e.button !== 0 || target.closest('button, [draggable="true"]')) return;
    const f = floatOf(groupId);
    const node = /** @type {HTMLElement | null} */ (floatLayer.querySelector(`[data-float="${groupId}"]`));
    if (!f || !node) return;
    e.preventDefault();
    const strip = /** @type {HTMLElement} */ (e.currentTarget);
    strip.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, fx: f.x, fy: f.y };
    node.classList.add('is-moving');
    const move = (/** @type {PointerEvent} */ ev) => {
      f.x = start.fx + ev.clientX - start.x;
      f.y = start.fy + ev.clientY - start.y;
      clamp(f);
      place(node, f);
    };
    const up = () => {
      node.classList.remove('is-moving');
      strip.removeEventListener('pointermove', move);
      strip.removeEventListener('pointerup', up);
      strip.removeEventListener('pointercancel', up);
      emit();
    };
    strip.addEventListener('pointermove', move);
    strip.addEventListener('pointerup', up);
    strip.addEventListener('pointercancel', up);
  }

  /** Resize a floating panel from an edge or corner. @param {PointerEvent} e @param {string} groupId @param {typeof GRIPS[number]} edge */
  function startResize(e, groupId, edge) {
    const f = floatOf(groupId);
    const node = /** @type {HTMLElement | null} */ (floatLayer.querySelector(`[data-float="${groupId}"]`));
    if (!f || !node || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = /** @type {HTMLElement} */ (e.currentTarget);
    grip.setPointerCapture(e.pointerId);
    const b = bounds();
    const s = { x: e.clientX, y: e.clientY, fx: f.x, fy: f.y, fw: f.w, fh: f.h };
    let frame = 0;
    const move = (/** @type {PointerEvent} */ ev) => {
      const dx = ev.clientX - s.x;
      const dy = ev.clientY - s.y;
      if (edge.includes('e')) f.w = Math.max(FLOAT.minW, Math.min(s.fw + dx, b.w - s.fx));
      if (edge.includes('s')) f.h = Math.max(FLOAT.minH, Math.min(s.fh + dy, b.h - s.fy));
      if (edge.includes('w')) { const x = Math.max(0, Math.min(s.fx + dx, s.fx + s.fw - FLOAT.minW)); f.w = s.fw + (s.fx - x); f.x = x; }
      if (edge.includes('n')) { const y = Math.max(0, Math.min(s.fy + dy, s.fy + s.fh - FLOAT.minH)); f.h = s.fh + (s.fy - y); f.y = y; }
      place(node, f);
      // Widgets redraw at most once a frame while the edge moves.
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; resizeGroup(f.group); });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      resizeGroup(f.group);
      emit();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  /**
   * Dock a floating panel: a full-width row at the top of the layout, every row then sharing the
   * height equally (as the simulator does).
   * @param {string} groupId
   */
  function dockFloat(groupId) {
    const f = floatOf(groupId);
    if (!f) return;
    state.floating = state.floating.filter((x) => x !== f);
    if (!state.layout) state.layout = f.group;
    else if (state.layout.type === 'split' && state.layout.dir === 'column') {
      state.layout.children.unshift(f.group);
      state.layout.sizes = state.layout.children.map(() => 1);
    } else state.layout = { type: 'split', dir: 'column', sizes: [1, 1], children: [f.group, state.layout] };
    tidy();
    render();
    emit();
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

  /** Where a tab dropped on a docked panel goes. @param {HTMLElement} panel @param {DragEvent} e @returns {'center' | 'left' | 'right' | 'top' | 'bottom'} */
  function zoneOf(panel, e) {
    const r = panel.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (e.clientY - r.top < TAB_STRIP) return 'center'; // over the tab strip: add as a tab
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
   * Move a widget onto a panel: as a tab (center) or into a new panel beside it. A floating
   * target only takes tabs. The source panel disappears if it is left empty.
   * @param {string} id @param {string} targetGroupId @param {'center' | 'left' | 'right' | 'top' | 'bottom'} zone
   */
  function moveWidget(id, targetGroupId, zone) {
    const source = groupOf(id);
    const target = findGroup(targetGroupId);
    if (!source || !target) return;
    if (floatOf(targetGroupId)) zone = 'center';
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
    tidy();
    render();
    emit();
  }

  // ------------------------------------------------------------------ pop-out

  /**
   * Move a widget into a browser window of its own ("Open in a new window"). The widget is not
   * rebuilt: its element moves to the other window and back, so a chart keeps its state.
   *
   * 1. Open client/ui/popout.html, a blank same-origin page with no script. (Not about:blank: that
   *    has no doctype, so it renders in quirks mode, and its origin can differ from the page's.)
   *    The docked panel shows "Open in another window" with Bring it back.
   * 2. Once it has loaded (polled: the window's own load event can fire before a listener added
   *    from here is in place), give it the page's look: every stylesheet, recreated by its own
   *    document so it loads there; the body's classes (EDS shows the body only with "appear");
   *    <html data-cme-theme>; and a wrapper with the terminal root's classes (cme-terminal, and
   *    cme-inverse when dark) and data-theme, kept in step with the page while the window is open.
   * 3. Bind the design language's behaviours (steppers, segmented controls, switches, menus) to
   *    its document, and tell feedback.js to open dialogs and toasts there while it is in use.
   * 4. Move the widget in, once the stylesheets have loaded (at most STYLES_LOAD_MS).
   * 5. Bring the widget back when the window closes or reloads (pagehide, with a poll as a
   *    fallback), when its panel's Bring it back is pressed, or when this page unloads.
   * Widgets draw on the frames of the window that shows them (dom.js frameFor), so a popped-out
   * chart keeps updating while the page's tab is hidden.
   * @param {string} id
   */
  function popOut(id) {
    const found = live.get(id);
    if (!found || found.popup) return;
    const w = found;
    const popup = window.open(POPOUT_PAGE, `ts-${id}`, 'popup,width=900,height=640');
    if (!popup) {
      toast({ title: 'The window did not open', text: 'Allow pop-ups for this site to open a widget in a new window.', type: 'error' });
      return;
    }
    w.popup = popup;
    render();

    let mounted = false;
    let returned = false;
    /** @type {Array<() => void>} */
    const cleanups = [];
    const back = () => {
      if (returned) return;
      returned = true;
      for (const stop of cleanups) stop();
      if (!popup.closed) popup.close();
      if (live.get(id) !== w) return; // the widget was closed meanwhile
      w.popup = null;
      render();
    };
    const started = Date.now();
    const poll = setInterval(() => {
      if (popup.closed) { back(); return; }
      if (mounted) return;
      const doc = popup.document;
      if (doc.readyState === 'complete' && doc.URL !== 'about:blank') { mounted = true; mount(doc); }
      else if (Date.now() - started > POPOUT_LOAD_MS) back();
    }, 250);
    cleanups.push(() => clearInterval(poll));
    const unload = () => back();
    window.addEventListener('pagehide', unload);
    cleanups.push(() => window.removeEventListener('pagehide', unload));

    /** @param {Document} doc */
    async function mount(doc) {
      const win = /** @type {Window} */ (doc.defaultView);
      doc.title = w.title;
      doc.documentElement.lang = document.documentElement.lang || 'en';
      doc.body.className = document.body.className;
      doc.body.style.margin = '0';
      const term = /** @type {HTMLElement | null} */ (root.closest('.cme-terminal') ?? document.querySelector('.cme-terminal'));
      const shell = doc.createElement('div');
      shell.style.cssText = 'height: 100vh; display: flex; flex-direction: column;';
      const syncTheme = () => {
        const page = document.documentElement.dataset.cmeTheme;
        if (page) doc.documentElement.dataset.cmeTheme = page;
        else delete doc.documentElement.dataset.cmeTheme;
        shell.className = `${term?.className ?? 'cme-terminal'} ts-popout`;
        shell.dataset.theme = term?.dataset.theme ?? 'light';
      };
      syncTheme();
      const themes = new MutationObserver(syncTheme);
      themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-cme-theme'] });
      if (term) themes.observe(term, { attributes: true, attributeFilter: ['data-theme', 'class'] });
      cleanups.push(() => themes.disconnect());

      await Promise.race([Promise.all(copyStyles(doc)), new Promise((r) => { setTimeout(r, STYLES_LOAD_MS); })]);
      if (returned) return;
      window.cmeTerminal?.bind(doc);
      watchDocument(doc);
      doc.body.replaceChildren(shell);
      w.host.hidden = false;
      w.host.style.flex = '1';
      w.host.style.minHeight = '0';
      shell.appendChild(w.host);
      cleanups.push(() => { w.host.style.flex = ''; w.host.style.minHeight = ''; });
      win.addEventListener('pagehide', back);
      win.addEventListener('resize', () => w.instance.resize?.());
      w.instance.show?.();
      w.instance.resize?.();
      win.focus();
    }
  }

  /**
   * Give another document the page's stylesheets: each <link rel="stylesheet"> again (absolute
   * URL, same media), each <style> as text, and constructed (adopted) sheets as text, since a
   * constructed sheet belongs to one document. Elements are created by `doc` itself so they load
   * there. Resolves each link on load or error. O(stylesheets).
   * @param {Document} doc @returns {Promise<void>[]}
   */
  function copyStyles(doc) {
    /** @type {Promise<void>[]} */
    const loads = [];
    for (const node of document.querySelectorAll('link[rel~="stylesheet"], style')) {
      if (node instanceof HTMLLinkElement) {
        if (!node.href) continue;
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = node.href;
        if (node.media) link.media = node.media;
        loads.push(new Promise((resolve) => { link.onload = () => resolve(); link.onerror = () => resolve(); }));
        doc.head.appendChild(link);
      } else {
        const style = doc.createElement('style');
        style.textContent = node.textContent;
        doc.head.appendChild(style);
      }
    }
    for (const sheet of document.adoptedStyleSheets) {
      const style = doc.createElement('style');
      style.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
      doc.head.appendChild(style);
    }
    return loads;
  }

  // ------------------------------------------------------------------ public

  function getState() {
    return /** @type {DockState} */ (JSON.parse(JSON.stringify(state)));
  }

  return {
    /** Replace the layout (switching workspace). Workspaces saved before floating panels existed load without any. @param {DockState} next */
    load(next) {
      for (const [, w] of live) { w.popup?.close(); w.instance.destroy(); w.host.remove(); }
      live.clear();
      const copy = JSON.parse(JSON.stringify(next));
      state = { layout: copy.layout ?? null, widgets: copy.widgets ?? {}, maximized: copy.maximized ?? null, floating: copy.floating ?? [] };
      tidy();
      render();
    },
    getState,
    /**
     * Add a widget the way the simulator does: into an empty workspace it fills the dock;
     * otherwise it opens floating, cascading from the last one, on top.
     * @param {string} kind @param {Record<string, any>} [params]
     * @returns {string} the widget id
     */
    add(kind, params = {}) {
      const id = uid('w');
      state.widgets[id] = { kind, params };
      state.maximized = null;
      const group = newGroup(id);
      if (!state.layout && !state.floating.length) state.layout = group;
      else {
        const k = state.floating.length;
        /** @type {FloatNode} */
        const f = { group, x: FLOAT.x + FLOAT.dx * k, y: FLOAT.y + FLOAT.dy * k, w: FLOAT.w, h: FLOAT.h };
        clamp(f);
        state.floating.push(f);
      }
      render();
      emit();
      return id;
    },
    /** Show a widget's tab if it is open (and bring its panel to the front). @param {(ref: WidgetRef) => boolean} match */
    focus(match) {
      for (const [id, ref] of Object.entries(state.widgets)) {
        if (!match(ref)) continue;
        const g = groupOf(id);
        if (!g) continue;
        g.active = id;
        const f = floatOf(g.id);
        if (f) { state.floating = [...state.floating.filter((x) => x !== f), f]; }
        render();
        emit();
        return true;
      }
      return false;
    },
    /** Dock a floating panel (the same as its Dock button). */
    dock: dockFloat,
    close: closeWidget,
    destroy() { ro.disconnect(); for (const w of live.values()) { w.popup?.close(); w.instance.destroy(); } live.clear(); },
  };
}

/** @typedef {ReturnType<typeof createDock>} Dock */
