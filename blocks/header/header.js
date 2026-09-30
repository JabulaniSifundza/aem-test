import { getMetadata } from '../../scripts/aem.js';
import { loadFragment } from '../fragment/fragment.js';
import { el, icon, text } from '../../scripts/cme-dom.js';

/*
 * Header — design-language site header (header.md), built from the /nav document.
 * nav document sections:
 *   1. brand : one link to the home page (an image, if present, is used as the logo)
 *   2. primary: list of links (Markets, Data, Solutions …)
 *   3. secondary (optional): list of links (Insights, Education …);
 *      a "Log in" link becomes the header button
 * Mobile menu open/close comes from scripts/cme.js.
 */
export default async function decorate(block) {
  const navMeta = getMetadata('nav');
  const navPath = navMeta ? new URL(navMeta, window.location).pathname : '/nav';
  const fragment = await loadFragment(navPath);
  const sections = fragment ? [...fragment.querySelectorAll(':scope > .section')] : [];
  const [brandSection, primarySection, secondarySection] = sections;

  const brandLink = brandSection?.querySelector('a');
  const brandImg = brandSection?.querySelector('img');
  const logo = el(
    'a',
    { class: 'cme-header__logo', href: brandLink?.getAttribute('href') || '/' },
    brandImg
      ? el('img', {
        src: brandImg.src, alt: brandImg.alt || text(brandLink) || 'Home', width: '146', height: '23',
      })
      : text(brandLink) || 'Home',
  );

  const nav = el('nav', { class: 'cme-header__nav', 'aria-label': 'Primary' });
  [...(primarySection?.querySelectorAll('a') || [])].forEach((a) => nav.append(el('a', { href: a.getAttribute('href') }, text(a))));

  let loginLink = null;
  const secondary = [...(secondarySection?.querySelectorAll('a') || [])].filter((a) => {
    if (/^log ?in$/i.test(text(a))) {
      loginLink = a;
      return false;
    }
    return true;
  });
  if (secondary.length) {
    nav.append(el('span', { class: 'cme-header__divider', 'aria-hidden': 'true' }));
    secondary.forEach((a) => nav.append(el('a', { class: 'cme-header__secondary', href: a.getAttribute('href') }, text(a))));
  }

  const actions = el(
    'div',
    { class: 'cme-header__actions' },
    el('button', { class: 'cme-header__icon-btn', type: 'button', 'aria-label': 'Search' }, icon('search')),
    el('button', { class: 'cme-header__icon-btn cme-header__account', type: 'button', 'aria-label': 'Account' }, icon('user')),
    loginLink ? el('a', { class: 'cme-btn cme-btn--secondary', href: loginLink.getAttribute('href') }, text(loginLink)) : null,
    el('button', {
      class: 'cme-header__icon-btn cme-header__menu-btn', type: 'button', 'aria-label': 'Menu', 'aria-expanded': 'false',
    }, icon('menu')),
  );

  const header = el('div', { class: 'cme-header' }, el('div', { class: 'cme-container cme-header__inner' }, logo, nav, actions));
  block.replaceChildren(header);
}
