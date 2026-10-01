import { el, text, fullWidth } from '../../scripts/cme-dom.js';

/*
 * Jump Nav — design-language "Jump to" bar (reading.md, cme-jump-nav).
 * Author table: links to sections on the page (#overview …), one per cell or row.
 * Optional first row without a link = the title (default "Jump to").
 * Give target sections an "Id" in Section Metadata. scripts/cme.js marks the section in view.
 * Use jump nav or page tabs on a page, never both.
 */
export default function decorate(block) {
  const links = [...block.querySelectorAll('a')].filter((a) => a.getAttribute('href'));
  if (!links.length) {
    block.remove();
    return;
  }
  const firstRow = block.firstElementChild;
  const title = firstRow && !firstRow.querySelector('a') ? text(firstRow) : 'Jump to';
  const nav = el(
    'nav',
    { class: 'cme-jump-nav', 'aria-label': 'On this page' },
    el(
      'div',
      { class: 'cme-container cme-jump-nav__inner' },
      el('span', { class: 'cme-jump-nav__title' }, title),
      links.map((a, i) => el('a', { href: a.getAttribute('href'), 'aria-current': i === 0 ? 'true' : 'false' }, text(a))),
    ),
  );
  block.replaceChildren(nav);
  fullWidth(block, nav);
}
