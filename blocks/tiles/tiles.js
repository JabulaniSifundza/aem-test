import {
  el, icon, text, rows,
} from '../../scripts/cme-dom.js';

/*
 * Tiles — design-language navigation tiles (cards.md, cme-tile), 4/4/4.
 * Author table, one row per tile:  title as a link | short text
 * Tiles are navigation boxes: every tile needs a link.
 */
export default function decorate(block) {
  const tiles = rows(block)
    .filter(([title]) => title && text(title))
    .map(([title, body]) => {
      const a = title.querySelector('a');
      const heading = el(
        'h3',
        { class: 'cme-h4 cme-tile__title' },
        el('a', { class: 'cme-chevron-link', href: a ? a.getAttribute('href') : '#' }, text(title), icon('chevron-right')),
      );
      return el(
        'div',
        { class: 'cme-col-md-4' },
        el(
          'div',
          { class: 'cme-tile' },
          heading,
          el('hr', { class: 'cme-pipe cme-pipe--gray' }),
          body && text(body) ? el('p', { class: 'cme-small cme-mb-0' }, text(body)) : null,
        ),
      );
    });
  block.replaceChildren(el('div', { class: 'cme-row' }, tiles));
}
