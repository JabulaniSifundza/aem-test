import { createOptimizedPicture } from '../../scripts/aem.js';
import { el, icon, text } from '../../scripts/cme-dom.js';

/*
 * Article Cards — design-language article card (cards.md), whole-card links in a grid.
 * Author table, one row per card:
 *   image | meta line (e.g. "5 min read" or "Video · 3 min"), heading, excerpt, link
 * The card links to the row's link. The meta icon follows the meta text:
 * video/watch → play, podcast/listen → podcast, otherwise list (article).
 * 2 cards → 6/6, 3 → 4/4/4, 4 → 3/3/3/3. Keep all cards the same shape (all with images or none).
 * Variants: (two-up) always 6/6 (a 2×2 grid, e.g. in a 3/9 card rail);
 *           (outline) outline cards for dark bands: title + meta line, no image or excerpt.
 */
function metaIcon(meta) {
  if (/video|watch/i.test(meta)) return 'play';
  if (/podcast|listen|audio/i.test(meta)) return 'podcast';
  return 'list';
}

function outlineCard(row) {
  const link = row.querySelector('a');
  const cells = [...row.children];
  const title = text(cells[0]) || text(link);
  const meta = cells.slice(1).map(text).filter(Boolean).join(' · ');
  return el(
    'a',
    { class: 'cme-card--outline', href: link ? link.getAttribute('href') : '#' },
    el('h3', { class: 'cme-card__title' }, title),
    meta ? el('span', { class: 'cme-meta' }, meta) : null,
  );
}

export default function decorate(block) {
  if (block.classList.contains('outline')) {
    const cards = [...block.children].map(outlineCard);
    block.replaceChildren(el('div', { class: 'cme-row' }, cards.map((card) => el('div', { class: 'cme-col-md-6' }, card))));
    return;
  }
  const cards = [...block.children].map((row) => {
    const cells = [...row.children];
    const picture = row.querySelector('picture');
    const body = cells.find((c) => !c.querySelector('picture') || c.textContent.trim()) || cells[cells.length - 1];
    const link = row.querySelector('a');
    const heading = body.querySelector('h1, h2, h3, h4, h5, h6') || body.querySelector('p strong')?.closest('p');
    const paras = [...body.querySelectorAll('p')].filter((p) => p !== heading && !p.querySelector('a') && text(p));
    const headingIndex = heading ? [...body.querySelectorAll('*')].indexOf(heading) : -1;
    const all = [...body.querySelectorAll('*')];
    const before = paras.filter((p) => heading && all.indexOf(p) < headingIndex);
    const after = paras.filter((p) => !before.includes(p));
    const meta = before[0] ? text(before[0]) : '';
    const excerpt = after[0] ? text(after[0]) : '';

    const media = picture
      ? el('div', { class: 'cme-card__media' }, (() => {
        const img = picture.querySelector('img');
        return createOptimizedPicture(img.src, img.alt || '', false, [{ width: '750' }]);
      })())
      : null;
    return el(
      'a',
      { class: 'cme-card', href: link ? link.getAttribute('href') : '#' },
      media,
      el(
        'div',
        { class: 'cme-card__body' },
        meta ? el('span', { class: 'cme-card__meta' }, icon(metaIcon(meta)), meta) : null,
        el('h3', { class: 'cme-card__title' }, text(heading) || text(link) || '{{Article title}}'),
        excerpt ? el('p', { class: 'cme-card__text' }, excerpt) : null,
      ),
    );
  });

  const span = block.classList.contains('two-up') ? 6 : ({ 1: 12, 2: 6, 3: 4 }[cards.length] || 3);
  const grid = el('div', { class: 'cme-row' }, cards.map((card) => el('div', { class: `cme-col-md-${span}` }, card)));
  block.replaceChildren(grid);
}
