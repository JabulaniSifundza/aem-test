import { el, text, cmeLink } from '../../scripts/cme-dom.js';

/*
 * Link Accordion — design-language accordion (accordion.md) used as a sidebar of link lists.
 * Author table, one row per panel:  title | list of links (or any short content)
 * The first panel starts open. Open/close behaviour comes from scripts/cme.js.
 */
let counter = 0;

export default function decorate(block) {
  const accordion = el('div', { class: 'cme-accordion' });
  [...block.children].forEach((row, i) => {
    const [titleCell, contentCell] = row.children;
    counter += 1;
    const id = `acc-${counter}`;
    const open = i === 0;
    const panel = el('div', { class: 'cme-accordion__panel', id });
    panel.hidden = !open;

    const links = contentCell ? [...contentCell.querySelectorAll('a')] : [];
    if (links.length) {
      panel.append(el('ul', {}, links.map((a) => el('li', {}, cmeLink(a)))));
    } else if (contentCell) {
      panel.append(...contentCell.childNodes);
    }

    accordion.append(el(
      'div',
      { class: 'cme-accordion__item' },
      el('button', {
        class: 'cme-accordion__header', type: 'button', 'aria-expanded': String(open), 'aria-controls': id,
      }, text(titleCell)),
      panel,
    ));
  });
  block.replaceChildren(accordion);
}
