/**
 * The product picker that slides out beside the side menu, as in the simulator's New chart and
 * New price ladder: a search box, products grouped by asset class (collapsed until opened or
 * searched), a checkbox per product, then Cancel / Add. Several products can be chosen at once;
 * each becomes its own widget.
 *
 * Markup and styles: design language 1.2.4 `cme-tsheet`. It is a modal dialog for assistive
 * technology (role="dialog", aria-modal), the rest of the workspace is inert while it is open,
 * Escape and the scrim close it, and focus returns to the menu item that opened it.
 */
import { el, icon, iconButton, uid } from './dom.js';
import { SYMBOLS } from '../../shared/symbols.js';

/** Asset classes in the order the simulator lists them; a class with no products is not shown. */
const GROUPS = /** @type {const} */ ([
  ['futures', 'Futures'], ['stock', 'Equities'], ['crypto', 'Cryptocurrencies'],
]);

/**
 * Open the picker and resolve with the chosen symbols (empty if cancelled).
 * @param {object} o
 * @param {HTMLElement} o.host        where the sheet goes (the terminal's main area)
 * @param {string} o.title           "New chart"
 * @param {string} o.intro           "Please select a product in order to add a chart."
 * @param {string} o.addLabel        "Add chart"
 * @param {HTMLElement[]} [o.inert]  elements to make inert while it is open
 * @returns {Promise<string[]>}
 */
export function pickProducts({ host, title, intro, addLabel, inert = [] }) {
  const opener = /** @type {HTMLElement | null} */ (document.activeElement);
  const titleId = uid('sheet');
  /** @type {Set<string>} */
  const chosen = new Set();
  /** @type {Set<string>} */
  const open = new Set();

  const search = /** @type {HTMLInputElement} */ (el('input', { class: 'cme-tinput', type: 'search', placeholder: 'Search', 'aria-label': 'Search products', autocomplete: 'off' }));
  const body = el('div', { class: 'cme-tsheet__body' });
  const add = /** @type {HTMLButtonElement} */ (el('button', { class: 'cme-tbtn', type: 'button', disabled: true }, addLabel));
  const cancel = el('button', { class: 'cme-tbtn cme-tbtn--outline', type: 'button' }, 'Cancel');
  const sheet = el('aside', { class: 'cme-tsheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    el('div', { class: 'cme-tsheet__header' }, el('h2', { class: 'cme-tsheet__title', id: titleId }, title), iconButton('close', 'Close', { onclick: () => finish([]) })),
    el('p', { class: 'cme-tsheet__intro' }, intro),
    el('div', { class: 'cme-tsheet__search' }, search),
    body,
    el('div', { class: 'cme-tsheet__footer' }, cancel, add));
  const scrim = el('div', { class: 'cme-tsheet-scrim', 'aria-hidden': 'true' });

  /** Redraw the groups for the current search. O(products). */
  function draw() {
    const q = search.value.trim().toUpperCase();
    const groups = GROUPS.map(([type, label]) => ({
      type, label,
      items: SYMBOLS.filter((s) => s.type === type && (!q || s.name.includes(q) || s.description.toUpperCase().includes(q))),
    })).filter((g) => g.items.length);
    body.replaceChildren(...groups.map((g) => {
      const listId = uid('opts');
      const expanded = Boolean(q) || open.has(g.type);
      const toggle = el('button', {
        class: 'cme-tsheet__group-toggle', type: 'button', 'aria-expanded': String(expanded), 'aria-controls': listId,
        onclick: () => { if (open.has(g.type)) open.delete(g.type); else open.add(g.type); draw(); },
      }, g.label, icon('chevron-down', 'sm'));
      const list = el('ul', { class: 'cme-tsheet__options', id: listId, hidden: !expanded }, ...g.items.map((s) => {
        const box = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', value: s.name }));
        box.checked = chosen.has(s.name);
        box.addEventListener('change', () => { if (box.checked) chosen.add(s.name); else chosen.delete(s.name); add.disabled = chosen.size === 0; });
        return el('li', {}, el('label', { class: 'cme-tsheet__option' }, box, s.description, el('span', { class: 'cme-tsheet__option-meta' }, s.name)));
      }));
      return el('div', { class: 'cme-tsheet__group' }, toggle, list);
    }));
    if (!groups.length) body.append(el('p', { class: 'cme-tsheet__intro' }, 'No products match.'));
  }

  /** @type {(symbols: string[]) => void} */
  let resolve = () => {};
  /** @param {string[]} symbols */
  function finish(symbols) {
    sheet.remove();
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
    for (const node of inert) node.inert = false;
    opener?.focus?.();
    resolve(symbols);
  }
  /** @param {KeyboardEvent} e */
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish([]); } };

  search.addEventListener('input', draw);
  cancel.addEventListener('click', () => finish([]));
  add.addEventListener('click', () => finish(SYMBOLS.map((s) => s.name).filter((n) => chosen.has(n))));
  scrim.addEventListener('click', () => finish([]));
  draw();
  return new Promise((r) => {
    resolve = r;
    for (const node of inert) node.inert = true;
    host.append(scrim, sheet);
    document.addEventListener('keydown', onKey, true);
    search.focus();
  });
}
