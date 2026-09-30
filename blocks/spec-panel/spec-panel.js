import { el, text, cmeLink } from '../../scripts/cme-dom.js';

/*
 * Spec Panel — design-language contract highlights panel (spec-panel.md).
 * Author table:
 *   first row : panel title | optional link (e.g. View full contract specs)
 *   next rows : label | value      (e.g. Contract unit | 5,000 bushels)
 *   Updated   | text             (optional last row, shown as the small date line)
 * Product specifications must come from supplied data; otherwise leave {{placeholders}}.
 */
export default function decorate(block) {
  const [first, ...rest] = [...block.children].map((row) => [...row.children]);
  const panel = el('div', { class: 'cme-spec' });

  if (first) {
    const link = first[1]?.querySelector('a');
    panel.append(el(
      'div',
      { class: 'cme-spec__header' },
      el('h3', { class: 'cme-spec__title' }, text(first[0])),
      link ? cmeLink(link) : null,
    ));
  }

  const list = el('ul', { class: 'cme-spec__list' });
  let updated = '';
  rest.forEach(([label, value]) => {
    if (/^updated$|^last updated$/i.test(text(label))) {
      updated = text(value);
      return;
    }
    list.append(el(
      'li',
      {},
      el('h4', { class: 'cme-spec__label' }, text(label)),
      el('p', { class: 'cme-spec__value' }, text(value)),
    ));
  });
  panel.append(list);
  if (updated) panel.append(el('p', { class: 'cme-spec__updated' }, updated));

  block.replaceChildren(panel);
}
