import {
  el, icon, text, keyedRows, cmeLink, exploreMenu, buttonsFrom,
} from '../../scripts/cme-dom.js';

/*
 * Page Hero — design-language page hero without a photo (hero.md, "Page hero").
 * Author table, one row per item (first cell is the key, case-insensitive):
 *   Breadcrumb   | link to the parent page
 *   Explore …    | links; the key text ("Explore JB Future Index") becomes a link menu
 *   Eyebrow      | short label above the title
 *   Title        | page title (becomes the page's single h1)
 *   Text         | one or two sentences
 *   Actions      | links; a bold link becomes the one primary button, others secondary
 * Variant: (deep) uses the deep navy surface. The block turns its section into the hero.
 */
export default function decorate(block) {
  const data = keyedRows(block);
  const exploreKey = [...data.keys()].find((k) => k.startsWith('explore'));
  const keyOf = (row) => text(row.children[0]).toLowerCase();
  const exploreRow = [...block.children].find((r) => keyOf(r) === exploreKey);
  const exploreLabel = exploreRow ? text(exploreRow.children[0]) : '';

  const navParts = [];
  const crumb = data.get('breadcrumb')?.querySelector('a');
  if (crumb) {
    const link = cmeLink(crumb, 'cme-breadcrumb');
    link.prepend(icon('arrow-left-bold'));
    navParts.push(link);
  }
  if (exploreKey) navParts.push(exploreMenu(exploreLabel, [...data.get(exploreKey).querySelectorAll('a')]));

  const content = el('div', { class: 'cme-hero__content' });
  if (data.has('eyebrow')) content.append(el('p', { class: 'cme-eyebrow cme-hero__eyebrow' }, text(data.get('eyebrow'))));
  content.append(el('h1', { class: 'cme-hero__title', id: 'page-title' }, text(data.get('title')) || '{{Page title}}'));
  if (data.has('text')) content.append(el('p', { class: 'cme-lead' }, text(data.get('text'))));
  content.append(...buttonsFrom(data.get('actions')));

  block.replaceChildren(...[navParts.length ? el('div', { class: 'cme-hero__nav' }, navParts) : null, content].filter(Boolean));

  const section = block.closest('.section');
  if (section) {
    const surface = block.classList.contains('deep') ? 'cme-section--deep' : 'cme-section--inverse';
    section.classList.add(surface, 'cme-inverse', 'cme-hero');
    section.setAttribute('aria-labelledby', 'page-title');
  }
}
