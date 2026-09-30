/* CME Group design language — behaviours (v1.1). No dependencies. Load with <script src=".../js/cme.js" defer></script>.
   Behaviour is driven by the markup documented in components/*.md; pages never need their own scripts for these:
   - Accordion:  .cme-accordion__header[aria-controls]            toggles its panel (hidden) and aria-expanded
   - Dropdown:   .cme-dropdown__trigger[aria-controls]             opens/closes .cme-dropdown__menu; Escape and outside click close
                 .cme-dropdown__menu [data-cme-select]             picking an item updates the trigger label
   - Tabs:       [role=tablist] > [role=tab][aria-controls]        switches [role=tabpanel]; arrow keys move focus
   - Mobile menu: .cme-header__menu-btn                            toggles .is-menu-open on .cme-header
   - Notice:     .cme-notice__close                                hides its .cme-notice
   - Jump nav:   .cme-jump-nav a[href^="#"]                        marks the section in view with aria-current="true"
   Fires a "cme:change" CustomEvent on the component root after every state change. */
(function () {
  'use strict';
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const emit = (el, detail) => el.dispatchEvent(new CustomEvent('cme:change', { bubbles: true, detail }));
  const byId = (id) => (id ? document.getElementById(id) : null);

  function setExpanded(trigger, panel, open) {
    trigger.setAttribute('aria-expanded', String(open));
    if (panel) panel.hidden = !open;
  }

  // Accordion
  document.addEventListener('click', (e) => {
    const h = e.target.closest('.cme-accordion__header');
    if (!h) return;
    const panel = byId(h.getAttribute('aria-controls')) || h.nextElementSibling;
    setExpanded(h, panel, h.getAttribute('aria-expanded') !== 'true');
    emit(h.closest('.cme-accordion') || h, { type: 'accordion', open: h.getAttribute('aria-expanded') === 'true' });
  });

  // Dropdown
  function closeAllDropdowns(except) {
    $$('.cme-dropdown__trigger[aria-expanded="true"]').forEach((t) => {
      if (t === except) return;
      setExpanded(t, byId(t.getAttribute('aria-controls')) || t.parentElement.querySelector('.cme-dropdown__menu'), false);
    });
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.cme-dropdown__trigger');
    if (t) {
      const menu = byId(t.getAttribute('aria-controls')) || t.parentElement.querySelector('.cme-dropdown__menu');
      if (!menu) return;
      const open = t.getAttribute('aria-expanded') !== 'true';
      closeAllDropdowns(t);
      setExpanded(t, menu, open);
      emit(t.closest('.cme-dropdown') || t, { type: 'dropdown', open });
      return;
    }
    const item = e.target.closest('.cme-dropdown__menu [data-cme-select]');
    if (item) {
      const dd = item.closest('.cme-dropdown');
      const trig = dd && dd.querySelector('.cme-dropdown__trigger');
      if (trig) { trig.textContent = item.getAttribute('data-cme-select') || item.textContent.trim(); setExpanded(trig, item.closest('.cme-dropdown__menu'), false); trig.focus(); }
      emit(dd || item, { type: 'select', value: item.getAttribute('data-value') || item.textContent.trim() });
      return;
    }
    if (!e.target.closest('.cme-dropdown__menu')) closeAllDropdowns();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = $$('.cme-dropdown__trigger[aria-expanded="true"]');
    closeAllDropdowns();
    if (open[0]) open[0].focus();
    const header = document.querySelector('.cme-header.is-menu-open');
    if (header) toggleMenu(header, false);
  });

  // Tabs (buttons with aria-controls). Link tabs (page tabs to other pages/anchors) are left to the browser.
  function selectTab(tab) {
    const list = tab.closest('[role="tablist"]');
    $$('[role="tab"]', list).forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.classList.toggle('is-active', on);
      t.tabIndex = on ? 0 : -1;
      const p = byId(t.getAttribute('aria-controls'));
      if (p) p.hidden = !on;
    });
    emit(list, { type: 'tab', id: tab.id || tab.textContent.trim() });
  }
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"][aria-controls]');
    if (tab && tab.tagName !== 'A') selectTab(tab);
  });
  document.addEventListener('keydown', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = $$('[role="tab"]', tab.closest('[role="tablist"]'));
    let i = tabs.indexOf(tab);
    i = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[i].focus();
    if (tabs[i].tagName !== 'A' && tabs[i].hasAttribute('aria-controls')) selectTab(tabs[i]);
    e.preventDefault();
  });

  // Mobile menu
  function toggleMenu(header, open) {
    header.classList.toggle('is-menu-open', open);
    const btn = header.querySelector('.cme-header__menu-btn');
    if (btn) btn.setAttribute('aria-expanded', String(open));
    emit(header, { type: 'menu', open });
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.cme-header__menu-btn');
    if (btn) toggleMenu(btn.closest('.cme-header'), btn.getAttribute('aria-expanded') !== 'true');
  });

  // Notice dismiss
  document.addEventListener('click', (e) => {
    const c = e.target.closest('.cme-notice__close');
    if (!c) return;
    const n = c.closest('.cme-notice');
    n.hidden = true;
    emit(n, { type: 'notice', dismissed: true });
  });

  // Jump nav scroll-spy
  function initJumpNav(nav) {
    const links = $$('a[href^="#"]', nav);
    const targets = links.map((a) => byId(a.getAttribute('href').slice(1))).filter(Boolean);
    if (!('IntersectionObserver' in window) || !targets.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        links.forEach((a) => a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + en.target.id)));
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    targets.forEach((t) => io.observe(t));
  }

  function init() {
    // Sync initial state: collapsed panels hidden, closed menus hidden.
    $$('.cme-accordion__header[aria-expanded]').forEach((h) => { const p = byId(h.getAttribute('aria-controls')); if (p) p.hidden = h.getAttribute('aria-expanded') !== 'true'; });
    $$('.cme-dropdown__trigger[aria-controls]').forEach((t) => { const m = byId(t.getAttribute('aria-controls')); if (m) m.hidden = t.getAttribute('aria-expanded') !== 'true'; });
    $$('[role="tablist"]').forEach((l) => $$('[role="tab"]', l).forEach((t) => { if (t.tagName !== 'A') t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1; }));
    $$('.cme-jump-nav').forEach(initJumpNav);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
