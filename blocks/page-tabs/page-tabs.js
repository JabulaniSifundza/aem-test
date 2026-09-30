import { el, text } from '../../scripts/cme-dom.js';

/*
 * Page Tabs — design-language page tabs (tabs.md, cme-tabs--page).
 * Author table: one link per cell or per row, each pointing at a section anchor (#overview)
 * or another page. Give target sections an "Id" in Section Metadata.
 * The tab for the section in view is highlighted as the page scrolls.
 */
export default function decorate(block) {
  const links = [...block.querySelectorAll('a')];
  const list = el('div', { class: 'cme-tabs__list', role: 'tablist' });
  links.forEach((a, i) => {
    list.append(el('a', {
      class: `cme-tabs__tab${i === 0 ? ' is-active' : ''}`,
      role: 'tab',
      'aria-selected': i === 0 ? 'true' : 'false',
      href: a.getAttribute('href'),
    }, text(a)));
  });
  const nav = el('nav', { class: 'cme-tabs cme-tabs--page', 'aria-label': 'Page sections' }, list);
  block.replaceChildren(nav);

  const tabs = [...list.children];
  const select = (tab) => tabs.forEach((t) => {
    const on = t === tab;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  tabs.forEach((t) => t.addEventListener('click', () => select(t)));

  const targets = tabs
    .map((t) => {
      const href = t.getAttribute('href') || '';
      return href.startsWith('#') ? document.getElementById(href.slice(1)) : null;
    })
    .filter(Boolean);
  if (targets.length && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const tab = tabs.find((t) => t.getAttribute('href') === `#${entry.target.id}`);
        if (tab) select(tab);
      });
    }, { rootMargin: '-35% 0px -60% 0px' });
    targets.forEach((t) => io.observe(t));
  }

  const section = block.closest('.section');
  if (section) section.classList.add('cme-section--flush');
}
