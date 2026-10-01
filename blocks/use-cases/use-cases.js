import { el, text, rows } from '../../scripts/cme-dom.js';

/*
 * Use Cases — a 4/4/4 grid of short explanations without links (title, pipe, text).
 * The design language has no component for this (tiles are navigation, cards are articles),
 * so it is built from layout.md, typography.md and divider.md parts and marked as a gap
 * (DR gap protocol): data-cme-gap="use-case-grid".
 * Author table, one row per item:  title | short text
 */
export default function decorate(block) {
  const items = rows(block)
    .filter(([title]) => title && text(title))
    .map(([title, body]) => el(
      'div',
      { class: 'cme-col-md-4' },
      el('h3', { class: 'cme-h4' }, text(title)),
      el('hr', { class: 'cme-pipe' }),
      body && text(body) ? el('p', { class: 'cme-small' }, text(body)) : null,
    ));
  block.replaceChildren(el('div', {
    class: 'cme-row',
    'data-cme-gap': 'use-case-grid',
    'data-cme-gap-note': 'Non-navigational grid of short explanations; no documented component.',
  }, items));
}
