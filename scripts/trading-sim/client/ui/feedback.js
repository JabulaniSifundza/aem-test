/**
 * Toasts, dialogs and popover menus, built from the design language (terminal-controls.md).
 * Widgets call these instead of building their own overlays.
 *
 * Which window: a widget can be popped out into a window of its own (client/ui/dock.js). Overlays
 * open in the window the user is working in: menus in their anchor's document; dialogs and
 * toasts in the document that last had a pointer press, key press or focus (watchDocument()).
 */
import { el, icon, iconButton, uid, clear } from './dom.js';

// ------------------------------------------------------------------------------------ windows

/** The document the user last interacted with: the page, or a pop-out window's. (Node imports
 *  this module in the tests, where there is no document until a page uses it.) */
let activeDoc = globalThis.document;

/**
 * Track interaction in a document, so dialogs and toasts open there. The page's own document is
 * watched from the start; dock.js watches each pop-out window. Capturing listeners, O(1) each.
 * @param {Document} doc
 */
export function watchDocument(doc) {
  const mark = () => { activeDoc = doc; };
  for (const type of ['pointerdown', 'keydown', 'focusin']) doc.addEventListener(type, mark, true);
}
if (activeDoc) watchDocument(activeDoc);

/**
 * Where overlays go: the terminal root (they must inherit its theme) of the active window, or the
 * page's when that window has closed.
 * @returns {HTMLElement}
 */
export function overlayRoot() {
  const win = activeDoc.defaultView;
  const doc = win && !win.closed ? activeDoc : document;
  return /** @type {HTMLElement} */ (doc.querySelector('.cme-terminal') ?? doc.body);
}

// ------------------------------------------------------------------------------------- toasts

/**
 * Show a toast for a few seconds (errors stay until dismissed).
 * @param {{ title: string, text?: string, type?: 'success' | 'error' | 'info', timeoutMs?: number }} t
 * @param {HTMLElement} [root] the terminal root (toasts must inherit its theme)
 */
export function toast({ title, text = '', type = 'info', timeoutMs }, root = overlayRoot()) {
  // One stack per window, as a direct child of its terminal root.
  let stack = /** @type {HTMLElement | null} */ (root.querySelector(':scope > .cme-toast-stack'));
  if (!stack) {
    stack = el('div', { class: 'cme-toast-stack', role: 'status', 'aria-live': 'polite' });
    root.appendChild(stack);
  }
  // The same message from two sources (the order call and the trade stream) shows once.
  const key = `${type}|${title}|${text}`;
  const same = /** @type {HTMLElement | undefined} */ ([...stack.children].find((n) => /** @type {HTMLElement} */ (n).dataset.key === key));
  if (same) return same;
  const iconName = type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info';
  const node = el('div', { class: `cme-toast${type === 'info' ? '' : ` cme-toast--${type}`}`, role: type === 'error' ? 'alert' : null, 'data-key': key },
    icon(iconName, undefined, 'cme-toast__icon'),
    el('div', {}, el('p', { class: 'cme-toast__title' }, title), text ? el('p', { class: 'cme-toast__body' }, text) : null),
    iconButton('close', 'Dismiss', { class: 'cme-icon-btn--sm', onclick: () => node.remove() }));
  stack.appendChild(node);
  while (stack.children.length > 5) stack.firstElementChild?.remove();
  const wait = timeoutMs ?? (type === 'error' ? 10_000 : 4_000);
  setTimeout(() => node.remove(), wait);
  return node;
}

// ------------------------------------------------------------------------------------ dialogs

/**
 * @typedef {object} DialogButton
 * @property {string} label
 * @property {string} value          returned when this button closes the dialog
 * @property {'primary' | 'outline' | 'buy' | 'sell' | 'danger'} [kind]
 * @property {boolean} [submit]       validates the form before closing
 */

/**
 * A modal dialog. Resolves with the value of the button that closed it ('' for Escape / close).
 * `body` can be any node; when it contains form fields, `onSubmit` may return an error message to
 * keep the dialog open.
 * @param {{ title: string, body: Node | Node[], buttons?: DialogButton[], onSubmit?: (value: string) => (string | null | Promise<string | null>), width?: string }} options
 * @returns {Promise<string>}
 */
export function dialog({ title, body, buttons = [{ label: 'Close', value: 'close', kind: 'outline' }], onSubmit, width }) {
  const root = overlayRoot();
  const titleId = uid('dlg');
  const error = el('p', { class: 'cme-ticket__message', role: 'alert' });
  const footer = el('div', { class: 'cme-tdialog__footer' });
  const dlg = el('dialog', { class: 'cme-tdialog', 'aria-labelledby': titleId, style: width ? `width: ${width}` : null },
    el('div', { class: 'cme-tdialog__header' },
      el('h2', { class: 'cme-tdialog__title', id: titleId }, title),
      iconButton('close', 'Close', { 'data-cme-close': '' })),
    el('div', { class: 'cme-tdialog__body' }, ...(Array.isArray(body) ? body : [body]), error),
    footer);
  for (const b of buttons) {
    const kind = b.kind ?? 'primary';
    footer.appendChild(el('button', {
      class: `cme-tbtn cme-tbtn--lg${kind === 'primary' ? '' : ` cme-tbtn--${kind}`}`, type: 'button', 'data-value': b.value,
      onclick: async () => {
        if (b.submit && onSubmit) {
          const problem = await onSubmit(b.value);
          if (problem) { error.textContent = problem; return; }
        }
        dlg.close(b.value);
      },
    }, b.label));
  }
  root.appendChild(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { resolve(dlg.returnValue); dlg.remove(); }, { once: true });
    dlg.showModal();
    /** @type {HTMLElement | null} */ (dlg.querySelector('input, select, .cme-tdialog__footer button'))?.focus();
  });
}

/**
 * A yes/no confirmation. Resolves true when confirmed.
 * @param {{ title: string, text: string | Node, confirm: string, cancel?: string, kind?: DialogButton['kind'] }} o
 */
export async function confirm({ title, text, confirm: yes, cancel = 'Cancel', kind = 'primary' }) {
  const body = typeof text === 'string' ? el('p', { class: 'cme-mb-0' }, text) : text;
  const v = await dialog({ title, body, buttons: [{ label: cancel, value: 'cancel', kind: 'outline' }, { label: yes, value: 'confirm', kind }] });
  return v === 'confirm';
}

/**
 * Ask for one line of text (a name). Resolves with the trimmed text, or null if cancelled.
 * @param {{ title: string, label: string, value?: string, confirm: string, validate?: (v: string) => string | null }} o
 */
export async function promptText({ title, label, value = '', confirm: yes, validate }) {
  const id = uid('prompt');
  const input = /** @type {HTMLInputElement} */ (el('input', { class: 'cme-tinput', id, value, maxlength: '60', autocomplete: 'off' }));
  let result = '';
  const body = el('div', { class: 'cme-tfield' }, el('label', { class: 'cme-tfield__label', for: id }, label), input);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    /** @type {HTMLButtonElement | null} */ (input.closest('dialog')?.querySelector('[data-value="ok"]') ?? null)?.click();
  });
  const v = await dialog({
    title, body,
    buttons: [{ label: 'Cancel', value: 'cancel', kind: 'outline' }, { label: yes, value: 'ok', submit: true }],
    onSubmit: () => {
      result = input.value.trim();
      if (!result) return 'Enter a name.';
      return validate?.(result) ?? null;
    },
  });
  return v === 'ok' ? result : null;
}

// -------------------------------------------------------------------------------------- menus

/**
 * @typedef {{ label: string, value?: string, checked?: boolean, danger?: boolean, disabled?: boolean, onSelect?: () => void } | 'separator'} MenuItem
 */

/** @type {(() => void) | null} */
let closeOpenMenu = null;

/**
 * A popover menu under an anchor. Arrow keys move, Escape closes, a click outside closes.
 * @param {HTMLElement} anchor @param {MenuItem[]} items @param {{ align?: 'left' | 'right', label?: string }} [options]
 */
export function openMenu(anchor, items, { align = 'left', label } = {}) {
  closeOpenMenu?.();
  // The anchor's own window: a popped-out widget's menus open in its window.
  const doc = anchor.ownerDocument;
  const win = doc.defaultView ?? window;
  const root = anchor.closest('.cme-terminal') ?? doc.body;
  const menu = el('ul', { class: 'cme-tmenu', role: 'menu', 'aria-label': label ?? anchor.getAttribute('aria-label') ?? null });
  for (const item of items) {
    if (item === 'separator') { menu.appendChild(el('li', { role: 'separator', class: 'cme-tmenu__sep' })); continue; }
    const radio = item.checked !== undefined;
    const button = el('button', {
      class: `cme-tmenu__item${item.danger ? ' cme-tmenu__item--danger' : ''}`, type: 'button',
      role: radio ? 'menuitemradio' : 'menuitem', 'aria-checked': radio ? String(Boolean(item.checked)) : null, disabled: item.disabled ?? false,
      onclick: () => { close(); anchor.focus(); item.onSelect?.(); },
    }, item.label);
    menu.appendChild(el('li', { role: 'none' }, button));
  }
  root.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const host = /** @type {HTMLElement} */ (root).getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${Math.min(rect.bottom + 2, win.innerHeight - menu.offsetHeight - 4)}px`;
  const left = align === 'right' ? rect.right - menu.offsetWidth : rect.left;
  menu.style.left = `${Math.max(host.left + 4, Math.min(left, win.innerWidth - menu.offsetWidth - 4))}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const buttons = () => /** @type {HTMLButtonElement[]} */ ([...menu.querySelectorAll('.cme-tmenu__item:not(:disabled)')]);
  buttons()[0]?.focus();

  /** @param {MouseEvent} e */
  const outside = (e) => { if (!menu.contains(/** @type {Node} */ (e.target)) && e.target !== anchor && !anchor.contains(/** @type {Node} */ (e.target))) close(); };
  /** @param {KeyboardEvent} e */
  const keys = (e) => {
    const list = buttons();
    const i = list.indexOf(/** @type {HTMLButtonElement} */ (doc.activeElement));
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); }
    else if (e.key === 'Tab') close();
  };
  function close() {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    doc.removeEventListener('mousedown', outside, true);
    menu.removeEventListener('keydown', keys);
    if (closeOpenMenu === close) closeOpenMenu = null;
  }
  setTimeout(() => doc.addEventListener('mousedown', outside, true), 0);
  menu.addEventListener('keydown', keys);
  closeOpenMenu = close;
  return close;
}

// --------------------------------------------------------------------------------- form parts

/**
 * A labelled field.
 * @param {string} label @param {HTMLElement} control @param {{ hint?: string, id?: string }} [o]
 */
export function field(label, control, { hint, id } = {}) {
  const controlId = id ?? control.id ?? uid('f');
  const target = control.matches('input, select, textarea') ? control : control.querySelector('input, select, textarea');
  if (target && !target.id) target.id = controlId;
  return el('div', { class: 'cme-tfield' },
    el('label', { class: 'cme-tfield__label', for: target?.id ?? controlId }, label),
    control,
    hint ? el('p', { class: 'cme-tfield__hint cme-mb-0' }, hint) : null);
}

/**
 * A stepper (− value +) whose steps js/terminal.js performs exactly.
 * @param {{ name: string, value?: string, step: string, min?: string, max?: string, label: string, disabled?: boolean }} o
 */
export function stepper({ name, value = '', step, min, max, label, disabled = false }) {
  const input = el('input', { class: 'cme-stepper__input', name, value, inputmode: 'decimal', autocomplete: 'off', disabled, 'aria-label': label });
  const node = el('div', { class: 'cme-stepper', 'data-step': step, 'data-min': min ?? null, 'data-max': max ?? null, 'aria-disabled': disabled ? 'true' : null },
    el('button', { class: 'cme-stepper__btn', type: 'button', 'data-dir': '-1', 'aria-label': `Decrease ${label.toLowerCase()}`, disabled, tabindex: '-1' }, icon('minus', 'sm')),
    input,
    el('button', { class: 'cme-stepper__btn', type: 'button', 'data-dir': '1', 'aria-label': `Increase ${label.toLowerCase()}`, disabled, tabindex: '-1' }, icon('plus', 'sm')));
  return { node, input, setDisabled(/** @type {boolean} */ off) {
    input.disabled = off;
    node.querySelectorAll('button').forEach((b) => { b.disabled = off; });
    if (off) node.setAttribute('aria-disabled', 'true'); else node.removeAttribute('aria-disabled');
  } };
}

/**
 * A segmented control (radio group). js/terminal.js handles clicks and arrow keys.
 * @param {{ label: string, options: Array<{ value: string, label: string, side?: string }>, value: string, size?: 'lg', block?: boolean, buySell?: boolean }} o
 */
export function segmented({ label, options, value, size, block = false, buySell = false }) {
  const node = el('div', { class: ['cme-segmented', size ? 'cme-segmented--lg' : '', block ? 'cme-segmented--block' : '', buySell ? 'cme-segmented--buy-sell' : ''].filter(Boolean).join(' '), role: 'radiogroup', 'aria-label': label });
  for (const o of options) {
    node.appendChild(el('button', { class: 'cme-segmented__option', type: 'button', role: 'radio', value: o.value, 'data-side': o.side ?? null, 'aria-checked': String(o.value === value), tabindex: o.value === value ? '0' : '-1' }, o.label));
  }
  return {
    node,
    get value() { return /** @type {HTMLButtonElement | null} */ (node.querySelector('[aria-checked="true"]'))?.value ?? value; },
    set(/** @type {string} */ v) { node.querySelectorAll('[role="radio"]').forEach((b) => { const on = /** @type {HTMLButtonElement} */ (b).value === v; b.setAttribute('aria-checked', String(on)); b.setAttribute('tabindex', on ? '0' : '-1'); }); },
  };
}

/**
 * A switch with a visible label.
 * @param {{ label: string, checked?: boolean, name?: string }} o
 */
export function switchField({ label, checked = false, name }) {
  const labelId = uid('sw');
  const sw = el('button', { class: 'cme-switch', type: 'button', role: 'switch', 'aria-checked': String(checked), 'aria-labelledby': labelId, name: name ?? null });
  const node = el('div', { class: 'cme-switch-field' }, el('span', { class: 'cme-switch-field__label', id: labelId }, label), sw);
  return { node, sw, get checked() { return sw.getAttribute('aria-checked') === 'true'; }, set(/** @type {boolean} */ on) { sw.setAttribute('aria-checked', String(on)); } };
}

/** Empty a container and show an empty state. @param {HTMLElement} container @param {string} text */
export function emptyState(container, text) {
  clear(container);
  container.appendChild(el('div', { class: 'cme-tempty' }, text));
}
