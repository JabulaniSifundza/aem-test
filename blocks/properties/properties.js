import { el, text, rows } from '../../scripts/cme-dom.js';

/*
 * Properties — design-language details panel (events.md cme-properties inside a spec-panel.md
 * panel), e.g. date, time, location and speakers of an event.
 * Author table: first row = panel title; then label | value. Repeat a label for several values
 * (one row per speaker). Speakers are role titles unless the user supplied names.
 */
export default function decorate(block) {
  const [first, ...rest] = rows(block);
  const panel = el('div', { class: 'cme-spec' });
  if (first && text(first[0])) {
    panel.append(el('div', { class: 'cme-spec__header' }, el('h3', { class: 'cme-spec__title' }, text(first[0]))));
  }
  panel.append(el('dl', { class: 'cme-properties' }, rest
    .filter(([label, value]) => label && value && text(value))
    .map(([label, value]) => el('div', { class: 'cme-properties__row' }, el('dt', {}, text(label)), el('dd', {}, text(value))))));
  block.replaceChildren(panel);
}
