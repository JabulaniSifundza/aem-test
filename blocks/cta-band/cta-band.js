import { el, text, buttonsFrom } from '../../scripts/cme-dom.js';

/*
 * CTA Band — design-language closing band (patterns/sections.md "CTA band"): 3/6/3,
 * heading | short text | one button (cme-btn--secondary-neutral) on an indigo section.
 * Author table, one row:  heading | text | link
 * Put it in a section with Section Metadata Style: indigo.
 */
export default function decorate(block) {
  const [heading, body, action] = [...(block.firstElementChild?.children || [])];
  if (!heading || !text(heading)) {
    block.remove();
    return;
  }
  const [button] = buttonsFrom(action, 'cme-btn--secondary-neutral');
  if (button) button.className = 'cme-btn cme-btn--secondary-neutral';
  block.replaceChildren(el(
    'div',
    { class: 'cme-row cme-row--align-center' },
    el('div', { class: 'cme-col-md-3' }, el('h2', {}, text(heading))),
    el('div', { class: 'cme-col-md-6' }, body && text(body) ? el('p', { class: 'cme-lead cme-mb-0' }, text(body)) : null),
    el('div', { class: 'cme-col-md-3 cme-text-right-md' }, button || null),
  ));
}
