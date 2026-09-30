import { getMetadata } from '../../scripts/aem.js';
import { loadFragment } from '../fragment/fragment.js';
import { el, text } from '../../scripts/cme-dom.js';

/*
 * Footer — design-language footer (footer.md), built from the /footer document.
 * footer document sections:
 *   - each section with a heading + list of links becomes a footer column
 *   - a section with text only becomes the dark legal band (copy supplied by Legal)
 */
export default async function decorate(block) {
  const footerMeta = getMetadata('footer');
  const footerPath = footerMeta ? new URL(footerMeta, window.location).pathname : '/footer';
  const fragment = await loadFragment(footerPath);
  const sections = fragment ? [...fragment.querySelectorAll(':scope > .section')] : [];

  const cols = el('div', { class: 'cme-row cme-footer__cols' });
  const legal = [];
  sections.forEach((section) => {
    const links = [...section.querySelectorAll('a')];
    const heading = section.querySelector('h1, h2, h3, h4, h5, h6');
    if (links.length) {
      cols.append(el(
        'div',
        { class: 'cme-col-md' },
        heading ? el('h2', { class: 'cme-footer__heading' }, text(heading)) : null,
        el('ul', { class: 'cme-footer__links' }, links.map((a) => el('li', {}, el('a', { href: a.getAttribute('href') }, text(a))))),
      ));
    } else {
      section.querySelectorAll('p').forEach((p) => legal.push(text(p)));
    }
  });

  const parts = [el('div', { class: 'cme-footer' }, el('div', { class: 'cme-container' }, cols))];
  if (legal.length) {
    parts.push(el('div', { class: 'cme-legal cme-inverse' }, el('div', { class: 'cme-container' }, legal.map((t) => el('p', { class: 'cme-fine' }, t)))));
  }
  block.replaceChildren(...parts);
}
