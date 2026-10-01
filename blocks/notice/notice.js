import { el, fullWidth } from '../../scripts/cme-dom.js';

/*
 * Notice — design-language notice bar (notice.md), full width between sections.
 * Author table, one cell: bold text = title, then the message and an optional link.
 * Variants: (neutral) (warning) (critical); default is info. Put it in its own section.
 */
const VARIANTS = {
  info: { cls: '', icon: 'info-filled', role: 'status' },
  neutral: { cls: 'cme-notice--neutral', icon: 'info-filled', role: 'status' },
  warning: { cls: 'cme-notice--warning', icon: 'attention-triangle', role: 'status' },
  critical: { cls: 'cme-notice--critical', icon: 'attention-triangle', role: 'alert' },
};

export default function decorate(block) {
  const cell = block.querySelector(':scope > div > div');
  if (!cell || !cell.textContent.trim()) {
    block.remove(); // nothing authored: render nothing
    return;
  }
  const type = Object.keys(VARIANTS).find((v) => block.classList.contains(v)) || 'info';
  const variant = VARIANTS[type];

  const body = el('p', { class: 'cme-notice__body cme-mb-0' });
  [...cell.querySelectorAll(':scope > p')].forEach((p, i) => {
    if (i) body.append(' ');
    body.append(...p.childNodes);
  });
  if (!body.childNodes.length) body.append(...cell.childNodes);
  const title = body.querySelector('strong, b');
  if (title) {
    const span = el('span', { class: 'cme-notice__title' }, title.textContent.trim());
    title.replaceWith(span);
  }
  body.querySelectorAll('a').forEach((a) => a.removeAttribute('class'));

  const notice = el(
    'div',
    { class: ['cme-notice', variant.cls].filter(Boolean).join(' '), role: variant.role },
    el('div', { class: 'cme-container cme-notice__inner' }, el('span', { class: `cme-icon cme-icon--${variant.icon} cme-notice__icon`, 'aria-hidden': 'true' }), body),
  );
  block.replaceChildren(notice);
  fullWidth(block, notice);
}
