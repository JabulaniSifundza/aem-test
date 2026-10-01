/*
 * CME Group design language: behaviours (v1.1.2). No dependencies.
 * Load once with <script src=".../js/cme.js" defer></script>. Behaviour is driven by the
 * markup in components/*.md, so pages never need their own scripts for these:
 *   Accordion    .cme-accordion__header[aria-controls]   toggles its panel and aria-expanded
 *   Dropdown     .cme-dropdown__trigger[aria-controls]    opens/closes .cme-dropdown__menu;
 *                arrow keys and Home/End move through items; Escape, outside click or
 *                tabbing away close; [data-cme-select] items update the trigger label
 *   Tabs         [role=tablist] > button[role=tab][aria-controls]   switches [role=tabpanel]
 *   Mobile menu  .cme-header__menu-btn                    toggles .is-menu-open on .cme-header
 *   Notice       .cme-notice__close                       hides its .cme-notice, keeps focus
 *   Scroll-spy   .cme-jump-nav and .cme-tabs--page links to #ids mark the section in view
 * Content added later (EDS fragments, lazily decorated blocks) is set up automatically.
 * Fires a bubbling "cme:change" CustomEvent on the component root after every state change.
 */
(() => {
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const emit = (el, detail) => el.dispatchEvent(new CustomEvent('cme:change', { bubbles: true, detail }));
  const byId = (id) => (id ? document.getElementById(id) : null);
  const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), '
    + 'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
  const SPY_ROOTS = '.cme-jump-nav, .cme-tabs--page';
  const SPY_MARGIN = '-40% 0px -55% 0px';

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
  const menuOf = (trigger) => byId(trigger.getAttribute('aria-controls'))
    || trigger.parentElement.querySelector('.cme-dropdown__menu');
  const menuItems = (menu) => $$(FOCUSABLE, menu).filter((el) => !el.closest('[hidden]'));

  function closeAllDropdowns(except) {
    $$('.cme-dropdown__trigger[aria-expanded="true"]').forEach((t) => {
      if (t === except) return;
      setExpanded(t, menuOf(t), false);
      emit(t.closest('.cme-dropdown') || t, { type: 'dropdown', open: false });
    });
  }

  function openDropdown(trigger, open) {
    const menu = menuOf(trigger);
    if (!menu) return null;
    closeAllDropdowns(trigger);
    if ((trigger.getAttribute('aria-expanded') === 'true') !== open) {
      setExpanded(trigger, menu, open);
      emit(trigger.closest('.cme-dropdown') || trigger, { type: 'dropdown', open });
    }
    return menu;
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('.cme-dropdown__trigger');
    if (t) {
      openDropdown(t, t.getAttribute('aria-expanded') !== 'true');
      return;
    }
    const item = e.target.closest('.cme-dropdown__menu [data-cme-select]');
    if (item) {
      const dd = item.closest('.cme-dropdown');
      const trig = dd && dd.querySelector('.cme-dropdown__trigger');
      if (trig) {
        trig.textContent = item.getAttribute('data-cme-select') || item.textContent.trim();
        setExpanded(trig, item.closest('.cme-dropdown__menu'), false);
        trig.focus();
      }
      emit(dd || item, { type: 'select', value: item.getAttribute('data-value') || item.textContent.trim() });
      return;
    }
    if (!e.target.closest('.cme-dropdown__menu')) closeAllDropdowns();
  });

  // Arrow keys: on the trigger they open the menu at the first or last item; inside the menu
  // they move between items (wrapping); Home/End jump to the ends.
  document.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const trigger = e.target.closest('.cme-dropdown__trigger');
    const menu = trigger ? null : e.target.closest('.cme-dropdown__menu');
    if (!trigger && !menu) return;
    if (trigger && !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const owner = trigger ? openDropdown(trigger, true) : menu;
    if (!owner) return;
    e.preventDefault();
    const list = menuItems(owner);
    if (!list.length) return;
    let next;
    if (trigger) next = e.key === 'ArrowUp' ? list.length - 1 : 0;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      next = (list.indexOf(e.target.closest(FOCUSABLE)) + step + list.length) % list.length;
    }
    list[next].focus();
  });

  // Tabbing out of an open dropdown closes it (a click elsewhere is handled above).
  document.addEventListener('focusout', (e) => {
    const dd = e.target.closest('.cme-dropdown');
    if (!dd || !e.relatedTarget || dd.contains(e.relatedTarget)) return;
    const t = dd.querySelector('.cme-dropdown__trigger[aria-expanded="true"]');
    if (t) openDropdown(t, false);
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

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = $$('.cme-dropdown__trigger[aria-expanded="true"]');
    closeAllDropdowns();
    if (open[0]) open[0].focus();
    const header = document.querySelector('.cme-header.is-menu-open');
    if (header) toggleMenu(header, false);
  });

  // Content tabs (buttons with aria-controls). Page tabs are links: navigation, not tabs.
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
    if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = tabs.length - 1;
    else i = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[i].focus();
    if (tabs[i].tagName !== 'A' && tabs[i].hasAttribute('aria-controls')) selectTab(tabs[i]);
    e.preventDefault();
  });

  // Notice dismiss: focus moves to what follows the notice, not back to the top of the page.
  document.addEventListener('click', (e) => {
    const c = e.target.closest('.cme-notice__close');
    if (!c) return;
    const n = c.closest('.cme-notice');
    const hadFocus = n.contains(document.activeElement);
    n.hidden = true;
    emit(n, { type: 'notice', dismissed: true });
    const target = hadFocus && (n.nextElementSibling || n.parentElement);
    if (!target) return;
    if (!target.matches(FOCUSABLE)) {
      target.setAttribute('tabindex', '-1');
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    }
    target.focus({ preventScroll: true });
  });

  // Scroll-spy. Jump nav marks the link with aria-current="true"; page tabs also get
  // .is-active, which their styles use.
  function markCurrent(nav, link) {
    const pageTabs = nav.classList.contains('cme-tabs--page');
    $$('a[href^="#"]', nav).forEach((a) => {
      const on = a === link;
      if (!pageTabs) {
        a.setAttribute('aria-current', String(on));
        return;
      }
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  }

  function initSpy(nav) {
    if (nav.dataset.cmeSpy || !('IntersectionObserver' in window)) return;
    const links = $$('a[href^="#"]', nav);
    const targets = links
      .map((a) => byId(decodeURIComponent(a.getAttribute('href').slice(1))))
      .filter(Boolean);
    if (!targets.length) return;
    nav.dataset.cmeSpy = 'true';
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        const link = links.find((a) => a.getAttribute('href') === `#${en.target.id}`);
        if (link) markCurrent(nav, link);
      });
    }, { rootMargin: SPY_MARGIN });
    targets.forEach((t) => io.observe(t));
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('.cme-tabs--page a[href^="#"], .cme-jump-nav a[href^="#"]');
    if (a) markCurrent(a.closest(SPY_ROOTS), a);
  });

  // Sync initial state inside a root. Safe to run more than once on the same content.
  function init(root) {
    const within = (sel) => (root.matches && root.matches(sel) ? [root] : []).concat($$(sel, root));
    within('.cme-accordion__header[aria-expanded]').forEach((h) => {
      const p = byId(h.getAttribute('aria-controls'));
      if (p) p.hidden = h.getAttribute('aria-expanded') !== 'true';
    });
    within('.cme-dropdown__trigger[aria-controls]').forEach((t) => {
      const m = byId(t.getAttribute('aria-controls'));
      if (m) m.hidden = t.getAttribute('aria-expanded') !== 'true';
    });
    within('[role="tablist"]').forEach((l) => $$('[role="tab"]', l).forEach((t) => {
      if (t.tagName !== 'A') t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1;
    }));
    within(SPY_ROOTS).forEach(initSpy);
  }

  function start() {
    init(document);
    // Content added after load (fragments, lazily decorated blocks) gets the same set-up.
    new MutationObserver((records) => {
      records.forEach((r) => r.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) init(node);
      }));
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
