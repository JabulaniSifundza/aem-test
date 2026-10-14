/**
 * Building DOM without markup strings (requirement SEC-5: no unsanitised text in the UI).
 * Text always goes in as text; attributes are set one by one. Every widget uses these helpers.
 */

/** Where the design-language icons live, relative to this file. */
export const ICONS = new URL('../../vendor/design-language/icons/terminal-icons.svg', import.meta.url).href;

/**
 * @typedef {Record<string, string | number | boolean | null | undefined | ((e: any) => void)>} Attrs
 *   class, id, role, aria-*, data-*, type, …; values false/null/undefined are skipped;
 *   keys starting with "on" (onclick) add event listeners.
 */

/**
 * Create an element. Children may be nodes, strings (as text) or null/false (skipped).
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Attrs} [attrs]
 * @param {...(Node | string | number | null | undefined | false)} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), /** @type {EventListener} */ (value));
    else if (key === 'value' && 'value' in node) /** @type {HTMLInputElement} */ (node).value = String(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, ...children);
  return node;
}

/**
 * Append children (text-safe).
 * @param {Node} parent
 * @param {...(Node | string | number | null | undefined | false)} children
 */
export function append(parent, ...children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Remove every child. @param {Node} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replace the children of a node. @param {Node} node @param {...(Node | string | null | undefined | false)} children */
export function replace(node, ...children) {
  clear(node);
  return append(node, ...children);
}

/**
 * A design-language icon: <svg class="cme-ticon"><use href="…#name"></use></svg>.
 * @param {string} name @param {'sm' | 'lg'} [size] @param {string} [extraClass]
 */
export function icon(name, size, extraClass) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', ['cme-ticon', size ? `cme-ticon--${size}` : '', extraClass ?? ''].filter(Boolean).join(' '));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `${ICONS}#${name}`);
  svg.appendChild(use);
  return svg;
}

/**
 * An icon-only button with an accessible name.
 * @param {string} iconName @param {string} label @param {Attrs} [attrs] @param {'sm' | 'lg'} [size]
 */
export function iconButton(iconName, label, attrs = {}, size) {
  const { class: cls, ...rest } = attrs;
  return el('button', { class: ['cme-icon-btn', cls].filter(Boolean).join(' '), type: 'button', 'aria-label': label, title: label, ...rest }, icon(iconName, size));
}

let idSeq = 0;
/** A unique id for aria wiring. @param {string} [prefix] */
export const uid = (prefix = 'ts') => `${prefix}-${(idSeq += 1)}`;

/**
 * Listen and return a function that stops listening.
 * @param {EventTarget} target @param {string} type @param {(e: any) => void} fn @param {AddEventListenerOptions} [opts]
 */
export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}
