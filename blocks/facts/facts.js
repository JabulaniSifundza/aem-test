import { el, text, rows } from '../../scripts/cme-dom.js';

/*
 * Facts — design-language key numbers (facts-steps.md, cme-facts).
 * Author table, one row per number:  value | label | note (optional)
 * Variant: (boxed) for boxed facts on a subtle section. On dark sections the facts turn
 * light automatically (Section Metadata Style: deep / inverse).
 */
export default function decorate(block) {
  const facts = rows(block)
    .filter(([value]) => value && text(value))
    .map(([value, label, note]) => el(
      'li',
      { class: 'cme-fact' },
      el('span', { class: 'cme-fact__value' }, text(value)),
      label && text(label) ? el('span', { class: 'cme-fact__label' }, text(label)) : null,
      note && text(note) ? el('span', { class: 'cme-fact__note' }, text(note)) : null,
    ));
  const cls = ['cme-facts'];
  if (block.classList.contains('boxed')) cls.push('cme-facts--boxed');
  block.replaceChildren(el('ul', { class: cls.join(' ') }, facts));
}
