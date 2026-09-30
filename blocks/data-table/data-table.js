import {
  el, text, deltaClass, isNumeric,
} from '../../scripts/cme-dom.js';

/*
 * Data Table — design-language data table (table.md).
 * Author table: first row = column headers, then one row per item.
 *   - First column is the name column (links allowed).
 *   - Numeric cells are right-aligned in monospace; other cells use the text style.
 *   - Columns whose header contains "change" colour values by sign (gain/loss). No other colouring.
 * The hidden caption lists the column headers for screen readers.
 * Light inside light sections, dense dark automatically inside dark sections.
 */
export default function decorate(block) {
  const [head, ...body] = [...block.children].map((row) => [...row.children]);
  if (!head) return;
  const headers = head.map(text);
  const changeCols = headers.map((h) => /change/i.test(h));

  const table = el(
    'table',
    { class: 'cme-table' },
    el('caption', { class: 'cme-visually-hidden' }, headers.join(', ')),
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, body.map((cells) => el('tr', {}, cells.map((cell, i) => {
      const value = text(cell);
      const cls = [];
      if (i === 0) cls.push('cme-table__name');
      else if (isNumeric(value)) cls.push('cme-num');
      else cls.push('cme-table__text');
      if (changeCols[i]) {
        const delta = deltaClass(value);
        if (delta) cls.push(delta);
      }
      const link = i === 0 ? cell.querySelector('a') : null;
      return el('td', { class: cls.join(' ') }, link ? el('a', { href: link.getAttribute('href') }, text(link)) : value);
    })))),
  );

  block.replaceChildren(el('div', { class: 'cme-table-wrap' }, table));
}
