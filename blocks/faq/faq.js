import { el, text, rows } from '../../scripts/cme-dom.js';

/*
 * FAQ — design-language accordion of questions (accordion.md).
 * Author table, one row per question:  question | answer (paragraphs, lists and links kept)
 * All answers start closed. Open/close behaviour comes from scripts/cme.js.
 */
let counter = 0;

export default function decorate(block) {
  const accordion = el('div', { class: 'cme-accordion' });
  rows(block).forEach(([question, answer]) => {
    if (!question || !text(question)) return;
    counter += 1;
    const id = `faq-${counter}`;
    const panel = el('div', { class: 'cme-accordion__panel', id });
    panel.hidden = true;
    if (answer) {
      const hasBlocks = answer.querySelector('p, ul, ol');
      if (hasBlocks) panel.append(...answer.childNodes);
      else panel.append(el('p', {}, ...answer.childNodes));
    }
    accordion.append(el(
      'div',
      { class: 'cme-accordion__item' },
      el('button', {
        class: 'cme-accordion__header', type: 'button', 'aria-expanded': 'false', 'aria-controls': id,
      }, text(question)),
      panel,
    ));
  });
  block.replaceChildren(accordion);
}
