import { el, text, rows } from '../../scripts/cme-dom.js';

/*
 * Steps — design-language numbered steps (facts-steps.md, cme-steps). Numbers come from CSS.
 * Author table, one row per step:  title | short text
 */
export default function decorate(block) {
  const steps = rows(block)
    .filter(([title]) => title && text(title))
    .map(([title, body]) => el(
      'li',
      { class: 'cme-step' },
      el('h3', { class: 'cme-h4 cme-step__title' }, text(title)),
      body && text(body) ? el('p', { class: 'cme-small cme-step__text' }, text(body)) : null,
    ));
  block.replaceChildren(el('ol', { class: 'cme-steps' }, steps));
}
