import { createOptimizedPicture } from '../../scripts/aem.js';
import {
  el, icon, text, rows, buttonsFrom,
} from '../../scripts/cme-dom.js';

/*
 * Event List — design-language event cards grouped by month (events.md, cme-event-card with
 * cme-card--with-action).
 * Author table:
 *   a row with one cell     = month divider (e.g. November 2026)
 *   event rows              = image (optional) | date | title as a link | type line | time
 *                             | action link
 * An event without an image keeps the empty media slot and is reported as a gap (event-image).
 */
export default function decorate(block) {
  const out = [];
  let list = null;
  rows(block).forEach((cells) => {
    if (cells.length === 1) {
      out.push(el('h3', { class: 'cme-list-divider' }, text(cells[0])));
      list = null;
      return;
    }
    const picture = cells[0].querySelector('picture');
    const [date, title, meta, time, action] = picture ? cells.slice(1) : cells;
    if (!title || !text(title)) return;
    if (!list) {
      list = el('ul', { class: 'cme-event-list' });
      out.push(list);
    }
    const img = picture?.querySelector('img');
    const media = img
      ? el('div', { class: 'cme-event-card__media' }, createOptimizedPicture(img.src, img.alt || '', false, [{ width: '400' }]))
      : el('div', { class: 'cme-event-card__media', 'data-cme-gap': 'event-image', 'data-cme-gap-note': 'No event image supplied.' });
    const link = title.querySelector('a');
    const buttons = buttonsFrom(action);
    list.append(el('li', {}, el(
      'article',
      { class: 'cme-event-card cme-card--with-action' },
      media,
      el(
        'div',
        { class: 'cme-event-card__body' },
        date && text(date) ? el('p', { class: 'cme-event-card__date cme-mb-0' }, text(date)) : null,
        el('h4', { class: 'cme-event-card__title' }, el('a', { class: 'cme-card__link', href: link ? link.getAttribute('href') : '#' }, text(title))),
        meta && text(meta) ? el('p', { class: 'cme-event-card__meta cme-mb-0' }, icon('webinar'), text(meta)) : null,
        time && text(time) ? el('p', { class: 'cme-event-card__time cme-mb-0' }, text(time)) : null,
        buttons.length ? el('div', { class: 'cme-card__actions' }, buttons) : null,
      ),
    )));
  });
  block.replaceChildren(...out);
}
