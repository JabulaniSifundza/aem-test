import { el, text, rows } from '../../scripts/cme-dom.js';

/*
 * Tabs — design-language content tabs (tabs.md, cme-tabs): switch a panel in place.
 * Author table, one row per tab: the tab label.
 * The panels are the blocks that follow this one in the same section, in order (e.g. two
 * Data table blocks for "Standard" and "Micro"). Switching and arrow keys come from
 * scripts/cme.js. For links to other pages or sections use Page tabs instead.
 */
let counter = 0;

export default function decorate(block) {
  const labels = rows(block).map(([cell]) => text(cell)).filter(Boolean);
  const panels = [];
  let next = block.parentElement?.nextElementSibling;
  while (next && panels.length < labels.length && !next.classList.contains('default-content-wrapper')) {
    panels.push(next);
    next = next.nextElementSibling;
  }
  if (!labels.length || !panels.length) {
    block.remove();
    return;
  }

  counter += 1;
  const list = el('div', { class: 'cme-tabs', role: 'tablist', 'aria-label': labels.join(' / ') });
  const panelEls = [];
  labels.slice(0, panels.length).forEach((label, i) => {
    const tabId = `tab-${counter}-${i}`;
    const panelId = `tabpanel-${counter}-${i}`;
    const on = i === 0;
    list.append(el('button', {
      class: `cme-tabs__tab${on ? ' is-active' : ''}`,
      role: 'tab',
      type: 'button',
      id: tabId,
      'aria-selected': String(on),
      'aria-controls': panelId,
      tabindex: on ? '0' : '-1',
    }, label));
    const panel = el('div', { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId }, panels[i]);
    panel.hidden = !on;
    panelEls.push(panel);
  });
  block.replaceChildren(list, ...panelEls);
}
