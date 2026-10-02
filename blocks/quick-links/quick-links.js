import { el, icon, text } from '../../scripts/cme-dom.js';

/*
 * Quick Links — design-language quick links for an intro split (patterns/sections.md
 * "Intro split": h6 "Quick links" + cme-link-bold list).
 * Author table: first row = title (e.g. Quick links); then the links, one per row or as a list.
 */
export default function decorate(block) {
  const [first] = [...block.children];
  const title = first && !first.querySelector('a') ? text(first) : '';
  const links = [...block.querySelectorAll('a')];
  const list = el('ul', { class: 'cme-list-plain' }, links.map((a) => el(
    'li',
    { class: 'cme-mb-s' },
    el('a', { class: 'cme-link-bold', href: a.getAttribute('href') }, icon('arrow-right'), el('span', { class: 'cme-link__text' }, text(a))),
  )));
  if (!links.length) {
    block.remove(); // nothing to link to: render nothing
    return;
  }
  block.replaceChildren(...[title ? el('h6', {}, title) : null, list].filter(Boolean));
  // after another block (e.g. steps) the links start a new group, not a caption of the block above
  if (block.parentElement?.previousElementSibling?.querySelector('.block')) block.classList.add('cme-mt-l');
}
