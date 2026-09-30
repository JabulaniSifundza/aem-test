import { el, icon, text } from '../../scripts/cme-dom.js';

/*
 * Promo — design-language campaign tile (cards.md "Promo"), shown in pairs (6/6).
 * Author table, one row per promo:  image | eyebrow, headline (12 words max), link
 * Put the block in a dark section (Section Metadata Style: inverse). Always give promos an image.
 */
export default function decorate(block) {
  const promos = [...block.children].map((row) => {
    const img = row.querySelector('picture img');
    const link = row.querySelector('a');
    const textCell = [...row.children].find((c) => !c.querySelector('picture')) || row;
    const lines = [...textCell.querySelectorAll('p, h2, h3, h4')]
      .filter((p) => !p.querySelector('a') || p.textContent.trim() !== text(p.querySelector('a')))
      .map(text)
      .filter(Boolean);
    const [eyebrow, headline] = lines.length > 1 ? lines : ['', lines[0] || text(link)];

    const promo = el(
      'a',
      { class: 'cme-promo cme-inverse', href: link ? link.getAttribute('href') : '#' },
      eyebrow ? el('p', { class: 'cme-promo__eyebrow' }, eyebrow) : null,
      el('p', { class: 'cme-promo__headline' }, headline || '{{Promo headline}}'),
      el('span', { class: 'cme-promo__arrow' }, icon('arrow-right')),
    );
    if (img) promo.style.setProperty('--cme-bg-image', `url('${img.src}')`);
    return promo;
  });

  const span = promos.length === 1 ? 12 : 6;
  block.replaceChildren(el('div', { class: 'cme-row' }, promos.map((p) => el('div', { class: `cme-col-md-${span}` }, p))));
}
