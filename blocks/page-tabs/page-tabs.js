import { el, text } from '../../scripts/cme-dom.js';

/*
 * Page Tabs — design-language page tabs (tabs.md, cme-tabs--page).
 * Author table: one link per cell or per row, each pointing at a section anchor (#overview)
 * or another page. Give target sections an "Id" in Section Metadata.
 * Page tabs are navigation links, not ARIA tabs. The current one carries `is-active` and
 * aria-current; for #section links, scripts/cme.js moves both to the section in view as the
 * page scrolls (and on click), so this block only builds the markup.
 */
export default function decorate(block) {
  const links = [...block.querySelectorAll('a')].filter((a) => a.getAttribute('href'));
  if (!links.length) {
    block.remove(); // nothing authored: render nothing rather than an empty bar
    return;
  }

  const here = window.location.pathname;
  const pathOf = (href) => {
    try {
      return new URL(href, window.location.href).pathname;
    } catch (e) {
      return '';
    }
  };
  // A link to this page is current; otherwise, for section links, start on the first one.
  const isSection = (a) => a.getAttribute('href').startsWith('#');
  let current = links.findIndex((a) => !isSection(a) && pathOf(a.getAttribute('href')) === here);
  const pageLink = current >= 0;
  if (!pageLink && isSection(links[0])) current = 0;

  const list = el('div', { class: 'cme-tabs__list' });
  links.forEach((a, i) => {
    let ariaCurrent;
    if (i === current) ariaCurrent = pageLink ? 'page' : 'true';
    list.append(el('a', {
      class: `cme-tabs__tab${i === current ? ' is-active' : ''}`,
      href: a.getAttribute('href'),
      'aria-current': ariaCurrent,
    }, text(a)));
  });
  const nav = el('nav', { class: 'cme-tabs cme-tabs--page', 'aria-label': 'Page sections' }, list);
  block.replaceChildren(nav);

  const section = block.closest('.section');
  if (section) section.classList.add('cme-section--flush');
}
