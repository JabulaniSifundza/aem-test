import {
  el, icon, text, rows, deltaClass, cmeLink, exploreMenu,
} from '../../scripts/cme-dom.js';

/*
 * Product Hero — design-language "product hero with live stats" (hero.md).
 * Author table, one row per item (first cell is the key, case-insensitive):
 *   Breadcrumb | link to the asset-class page
 *   Explore …  | links; the key text ("Explore JB Future Index") becomes a link menu
 *   Title      | product name (becomes the page's single h1)
 *   Subtitle   | e.g. Futures and options
 *   Actions    | links; a bold link becomes the one primary button, others secondary
 *   Footnote   | one paragraph per note (last updated, delay notice)
 *   any other  | a stat: label | value. Labels containing "code" get the code tag style;
 *                values starting with + or - are coloured as gain/loss automatically.
 * The block turns its section into the dark hero surface.
 */
const KEYS = ['breadcrumb', 'title', 'subtitle', 'actions', 'footnote'];

export default function decorate(block) {
  const data = { stats: [] };
  rows(block).forEach(([keyCell, valueCell]) => {
    const key = text(keyCell).toLowerCase();
    if (!valueCell) return;
    if (KEYS.includes(key)) data[key] = valueCell;
    else if (key.startsWith('explore')) data.explore = { label: text(keyCell), cell: valueCell };
    else if (key) data.stats.push({ label: text(keyCell), value: text(valueCell) });
  });

  const children = [];

  const navParts = [];
  const crumb = data.breadcrumb?.querySelector('a');
  if (crumb) {
    const link = cmeLink(crumb, 'cme-breadcrumb');
    link.prepend(icon('arrow-left-bold'));
    navParts.push(link);
  }
  if (data.explore) {
    const menu = exploreMenu(data.explore.label, [...data.explore.cell.querySelectorAll('a')]);
    if (menu) navParts.push(menu);
  }
  if (navParts.length) children.push(el('div', { class: 'cme-hero__nav' }, navParts));

  children.push(el('h1', { class: 'cme-hero__title', id: 'product-title' }, text(data.title) || '{{Product}}'));
  if (data.subtitle) children.push(el('p', { class: 'cme-hero__subtitle' }, text(data.subtitle)));

  const stats = el('div', { class: 'cme-stats' });
  data.stats.forEach(({ label, value }) => {
    const valueClass = ['cme-stat__value'];
    if (/code/i.test(label)) valueClass.push('cme-stat__value--code');
    const delta = deltaClass(value);
    if (delta) valueClass.push(delta);
    stats.append(el(
      'div',
      { class: 'cme-stat' },
      el('span', { class: 'cme-stat__label' }, label),
      el('span', { class: valueClass.join(' ') }, value),
    ));
  });

  const links = [...(data.actions?.querySelectorAll('a') || [])];
  if (links.length) {
    const actions = el('div', { class: 'cme-stat__actions' });
    let primaryUsed = false;
    links.forEach((a) => {
      // decorateButtons may already have turned a bold link into .cme-btn--primary
      const bold = !!a.closest('strong, b') || a.classList.contains('cme-btn--primary');
      const primary = bold && !primaryUsed;
      primaryUsed = primaryUsed || primary;
      actions.append(el('a', { class: `cme-btn ${primary ? 'cme-btn--primary' : 'cme-btn--secondary'}`, href: a.getAttribute('href') }, text(a)));
    });
    stats.append(actions);
  }
  if (stats.children.length) children.push(stats);

  const notes = data.footnote ? [...data.footnote.querySelectorAll('p')].map(text).filter(Boolean) : [];
  if (!notes.length && data.footnote && text(data.footnote)) notes.push(text(data.footnote));
  if (notes.length) children.push(el('p', { class: 'cme-hero__footnote' }, notes.map((n) => el('span', {}, n))));

  block.replaceChildren(...children);

  const section = block.closest('.section');
  if (section) {
    section.classList.add('cme-section--inverse', 'cme-inverse', 'cme-hero', 'cme-hero--product');
    section.setAttribute('aria-labelledby', 'product-title');
  }
}
