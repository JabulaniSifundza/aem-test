/*
 * Small DOM helpers shared by the CME blocks. Blocks turn the author's table into the
 * markup documented in the design-language specs (components/*.md); styling comes only
 * from styles/cme/*.css, so blocks carry almost no CSS of their own.
 */

/**
 * Creates an element.
 * @param {string} tag Tag name
 * @param {object} [attrs] Attributes; `class` may be a string
 * @param {...(Node|string)} children Child nodes or text
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  });
  children.flat().forEach((child) => {
    if (child === undefined || child === null || child === '') return;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  });
  return node;
}

/**
 * Design-language icon span (glyphs from tokens/icons.json).
 * @param {string} name Icon name, e.g. "chevron-right"
 * @returns {HTMLElement}
 */
export function icon(name) {
  return el('span', { class: `cme-icon cme-icon--${name}`, 'aria-hidden': 'true' });
}

/**
 * Trimmed text of a cell, collapsing whitespace.
 * @param {Element} cell
 * @returns {string}
 */
export function text(cell) {
  return (cell?.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Rows of a block as arrays of cells.
 * @param {Element} block
 * @returns {Element[][]}
 */
export function rows(block) {
  return [...block.children].map((row) => [...row.children]);
}

/**
 * Class for a signed change value: "+1.2" → cme-gain, "-0'6" → cme-loss, otherwise ''.
 * The sign decides the colour, so authors never pick colours by hand.
 * @param {string} value
 * @returns {string}
 */
export function deltaClass(value) {
  const v = value.trim();
  if (/^\+/.test(v)) return 'cme-gain';
  if (/^[-−]/.test(v)) return 'cme-loss';
  return '';
}

/**
 * True when a cell holds a number as the exchange quotes it:
 * 1,234 · 522'2 · 1.0842 · -0.14% · +1'2
 * @param {string} value
 * @returns {boolean}
 */
export function isNumeric(value) {
  return /^[+\-−]?[\d,]+(['.]\d+)?%?(\s*\([+\-−]?[\d.,']+%?\))?$/.test(value.trim());
}

/**
 * Link text wrapped the way .cme-link expects.
 * @param {HTMLAnchorElement} a
 * @param {string} [cls] Link class
 * @returns {HTMLAnchorElement}
 */
export function cmeLink(a, cls = 'cme-link') {
  const label = el('span', { class: 'cme-link__text' }, text(a));
  return el('a', { class: cls, href: a.getAttribute('href') }, label);
}

let menuCounter = 0;

/**
 * "Explore" link menu for hero navigation (hero.md): a link-styled dropdown trigger and a
 * menu of the links in the cell. Open/close and keyboard come from scripts/cme.js.
 * @param {string} label Trigger text, e.g. "Explore JB Future Index"
 * @param {HTMLAnchorElement[]} links Menu items
 * @returns {HTMLElement|null}
 */
export function exploreMenu(label, links) {
  if (!links.length) return null;
  menuCounter += 1;
  const id = `explore-menu-${menuCounter}`;
  const menu = el('div', { class: 'cme-dropdown__menu', id }, links.map((a) => el('a', { class: 'cme-dropdown__item', href: a.getAttribute('href') }, text(a))));
  menu.hidden = true;
  return el(
    'div',
    { class: 'cme-dropdown' },
    el(
      'button',
      {
        class: 'cme-link', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': id,
      },
      el('span', { class: 'cme-link__text' }, label),
      icon('chevron-down'),
    ),
    menu,
  );
}

/**
 * Key/value rows of a block ("Title | JB Future Index"), keys lower-cased.
 * Repeated keys keep the first value; rows without a value cell are skipped.
 * @param {Element} block
 * @returns {Map<string, Element>} key -> value cell
 */
export function keyedRows(block) {
  const map = new Map();
  rows(block).forEach(([key, value]) => {
    const k = text(key).toLowerCase();
    if (k && value && !map.has(k)) map.set(k, value);
  });
  return map;
}

/**
 * Buttons from authored links: the first bold link becomes the primary button (one per
 * section, button.md); the others use the given secondary style.
 * @param {Element} cell Cell holding the links
 * @param {string} [secondary] Secondary button modifier
 * @returns {HTMLAnchorElement[]}
 */
export function buttonsFrom(cell, secondary = 'cme-btn--secondary') {
  let primaryUsed = false;
  return [...(cell?.querySelectorAll('a') || [])].map((a) => {
    const bold = !!a.closest('strong, b') || a.classList.contains('cme-btn--primary');
    const primary = bold && !primaryUsed;
    primaryUsed = primaryUsed || primary;
    return el('a', { class: `cme-btn ${primary ? 'cme-btn--primary' : secondary}`, href: a.getAttribute('href') }, text(a));
  });
}

/**
 * Bars (notice, jump nav) span the page and bring their own container. When the block is the
 * only content of its section, the section's container is replaced by the bar and the section
 * loses its padding; otherwise the bar stays where it is.
 * @param {Element} block The block element
 * @param {Element} bar The full-width bar it rendered
 */
export function fullWidth(block, bar) {
  const section = block.closest('.section');
  if (!section) return;
  const others = [...section.querySelectorAll('.block')].filter((b) => b !== block);
  const hasText = [...section.querySelectorAll('.default-content-wrapper')].some((w) => w.textContent.trim());
  if (others.length || hasText) return;
  section.classList.add('cme-section--flush');
  section.replaceChildren(bar);
}
