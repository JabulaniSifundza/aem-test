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
