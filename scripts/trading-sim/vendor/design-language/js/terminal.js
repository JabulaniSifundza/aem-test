/*
 * CME Group design language 1.2: terminal behaviours. No dependencies; load after js/cme.js:
 *   <script src=".../js/terminal.js" defer></script>
 * Driven by markup (components/terminal-*.md), so pages never re-implement these:
 *   Stepper     .cme-stepper[data-step][data-min][data-max] with .cme-stepper__btn[data-dir="-1|1"]
 *               and .cme-stepper__input: ± buttons and ↑/↓ keys step the value exactly (no float drift);
 *               values are plain numbers (no thousands separators)
 *   Segmented   .cme-segmented[role=radiogroup] > [role=radio]: click or ←/→ select one option
 *   Pills       .cme-pills > .cme-pill[aria-pressed]: one pressed at a time
 *   Switch      button.cme-switch[role=switch]: toggles aria-checked
 *   Menu        button[aria-haspopup=menu][aria-controls] opens .cme-tmenu; ↑/↓, Escape, outside click
 *   Dialog      [data-cme-close] inside a dialog.cme-tdialog closes it with that value
 * Every change fires a bubbling "cme:change" CustomEvent (detail.type = stepper | segmented |
 * pills | switch | menu) on the component, like js/cme.js. Steppers also fire "input" on their input.
 */
(() => {
  const emit = (el, detail) => el.dispatchEvent(new CustomEvent('cme:change', { bubbles: true, detail }));

  // ---- Stepper -------------------------------------------------------------
  // Values are stepped as integers of the step's smallest unit, so 0.1 + 0.2 stays 0.3.
  const decimals = (s) => ((String(s).split('.')[1] || '').length);
  function step(stepper, dir) {
    const input = stepper.querySelector('.cme-stepper__input');
    if (!input || input.disabled || input.readOnly) return;
    const size = stepper.dataset.step || '1';
    const current = (input.value || '').replace(/[,\s]/g, ''); // tolerate thousands separators typed by users
    if (current && !/^-?\d*\.?\d*$/.test(current)) return;
    const places = Math.max(decimals(size), decimals(current || '0'));
    const scale = 10 ** places;
    const toUnits = (v) => Math.round(Number(v) * scale);
    let units = toUnits(current || stepper.dataset.min || '0') + dir * toUnits(size);
    if (stepper.dataset.min !== undefined) units = Math.max(units, toUnits(stepper.dataset.min));
    if (stepper.dataset.max !== undefined) units = Math.min(units, toUnits(stepper.dataset.max));
    const value = (units / scale).toFixed(places);
    if (value === input.value) return;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    emit(stepper, { type: 'stepper', value, name: input.name || input.id });
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.cme-stepper__btn');
    if (btn && !btn.disabled) step(btn.closest('.cme-stepper'), Number(btn.dataset.dir || 1));
  });
  document.addEventListener('keydown', (e) => {
    const input = e.target.closest('.cme-stepper__input');
    if (input && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      step(input.closest('.cme-stepper'), e.key === 'ArrowUp' ? 1 : -1);
    }
  });

  // ---- Segmented control ---------------------------------------------------
  function choose(option) {
    const group = option.closest('.cme-segmented');
    if (!group || option.disabled) return;
    group.querySelectorAll('[role="radio"]').forEach((o) => {
      const on = o === option;
      o.setAttribute('aria-checked', String(on));
      o.tabIndex = on ? 0 : -1;
    });
    emit(group, { type: 'segmented', value: option.value || option.dataset.value || option.textContent.trim() });
  }
  document.addEventListener('click', (e) => {
    const option = e.target.closest('.cme-segmented [role="radio"]');
    if (option && option.getAttribute('aria-checked') !== 'true') choose(option);
  });
  document.addEventListener('keydown', (e) => {
    const option = e.target.closest('.cme-segmented [role="radio"]');
    if (!option || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const options = Array.from(option.closest('.cme-segmented').querySelectorAll('[role="radio"]:not(:disabled)'));
    const i = options.indexOf(option);
    const next = options[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length];
    e.preventDefault();
    choose(next);
    next.focus();
  });

  // ---- Pills ---------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const pill = e.target.closest('.cme-pills .cme-pill');
    if (!pill || pill.getAttribute('aria-pressed') === 'true') return;
    const group = pill.closest('.cme-pills');
    group.querySelectorAll('.cme-pill').forEach((p) => p.setAttribute('aria-pressed', String(p === pill)));
    emit(group, { type: 'pills', value: pill.value || pill.dataset.value || pill.textContent.trim() });
  });

  // ---- Switch --------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const sw = e.target.closest('button.cme-switch[role="switch"]');
    if (!sw || sw.disabled) return;
    const on = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(on));
    emit(sw, { type: 'switch', checked: on, name: sw.name || sw.id });
  });

  // ---- Menu ----------------------------------------------------------------
  const TRIGGER = 'button[aria-haspopup="menu"][aria-controls]';
  const menuOf = (trigger) => document.getElementById(trigger.getAttribute('aria-controls'));
  const items = (menu) => Array.from(menu.querySelectorAll('.cme-tmenu__item:not(:disabled)'));
  function closeMenus(except) {
    document.querySelectorAll(`${TRIGGER}[aria-expanded="true"]`).forEach((t) => {
      if (t === except) return;
      t.setAttribute('aria-expanded', 'false');
      const m = menuOf(t);
      if (m) m.hidden = true;
    });
  }
  function openMenu(trigger, focusLast) {
    const menu = menuOf(trigger);
    if (!menu) return;
    closeMenus(trigger);
    trigger.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    const list = items(menu);
    (focusLast ? list[list.length - 1] : list[0])?.focus();
  }
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest(TRIGGER);
    if (trigger) {
      if (trigger.getAttribute('aria-expanded') === 'true') closeMenus();
      else openMenu(trigger);
      return;
    }
    const item = e.target.closest('.cme-tmenu .cme-tmenu__item');
    if (item) {
      const menu = item.closest('.cme-tmenu');
      const owner = document.querySelector(`${TRIGGER}[aria-controls="${menu.id}"]`);
      emit(menu, { type: 'menu', value: item.value || item.dataset.value || item.textContent.trim() });
      closeMenus();
      owner?.focus();
      return;
    }
    if (!e.target.closest('.cme-tmenu')) closeMenus();
  });
  document.addEventListener('keydown', (e) => {
    const trigger = e.target.closest(TRIGGER);
    if (trigger && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); openMenu(trigger, e.key === 'ArrowUp'); return; }
    const menu = e.target.closest('.cme-tmenu');
    if (!menu) return;
    const list = items(menu);
    const i = list.indexOf(e.target);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    if (e.key === 'Escape' || e.key === 'Tab') {
      const owner = document.querySelector(`${TRIGGER}[aria-controls="${menu.id}"]`);
      closeMenus();
      if (e.key === 'Escape') owner?.focus();
    }
  });

  // ---- Dialog --------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-cme-close]');
    const dialog = closer?.closest('dialog.cme-tdialog');
    if (dialog) dialog.close(closer.dataset.cmeClose || '');
  });
})();
