import { el, text, rows } from '../../scripts/cme-dom.js';

/*
 * Lead Form — design-language lead form (forms.md: cme-field, cme-select, cme-fieldset,
 * cme-checkbox-group, cme-consent). Demo only: submitting shows a message and sends nothing.
 * Author table, one row per field:  label | type | options
 *   type: text · email · select (options: comma-separated; a first option starting with
 *         "Select" is the prompt) · checkboxes (options: comma-separated)
 *         consent (label = consent text, supplied by Legal) · submit (label = button text)
 *         note (label = fine print, e.g. privacy notice supplied by Legal)
 *   Add "(required)" to the type to make a field required, e.g. "email (required)".
 */
let counter = 0;
const AUTOCOMPLETE = { email: 'email', name: 'name', company: 'organization' };

function field(label, type, options, required, id) {
  const lab = el('label', { class: 'cme-field__label', for: id }, label);
  if (type === 'select') {
    // a first option starting with "Select" is the prompt (forms.md: select prompt option)
    const hasPrompt = /^select\b/i.test(options[0] || '');
    const prompt = hasPrompt ? options[0] : `Select ${label.toLowerCase()}`;
    const choices = hasPrompt ? options.slice(1) : options;
    const select = el(
      'select',
      {
        class: 'cme-select', id, name: id, required,
      },
      el('option', { value: '' }, prompt),
      choices.map((o) => el('option', { value: o }, o)),
    );
    return el('div', { class: 'cme-col-12' }, el('div', { class: 'cme-field' }, lab, el('div', { class: 'cme-select-wrap' }, select)));
  }
  const hint = Object.keys(AUTOCOMPLETE).find((k) => label.toLowerCase().includes(k));
  const input = el('input', {
    class: 'cme-input', id, name: id, type: type === 'email' ? 'email' : 'text', required, autocomplete: hint ? AUTOCOMPLETE[hint] : null,
  });
  return el('div', { class: 'cme-col-12' }, el('div', { class: 'cme-field' }, lab, input));
}

export default function decorate(block) {
  counter += 1;
  const form = el('form', { action: '#', novalidate: false });
  const grid = el('div', { class: 'cme-row' });
  form.append(grid);
  let submit = null;
  const notes = [];

  rows(block).forEach(([labelCell, typeCell, optionsCell], i) => {
    const label = text(labelCell);
    const typeText = text(typeCell).toLowerCase();
    const type = typeText.replace(/\(required\)/, '').trim() || 'text';
    const required = /required/.test(typeText);
    const options = text(optionsCell).split(',').map((o) => o.trim()).filter(Boolean);
    const id = `lead-${counter}-${i}`;
    if (!label) return;
    if (type === 'submit') submit = label;
    else if (type === 'note') notes.push(label);
    else if (type === 'consent') {
      form.append(el('label', { class: 'cme-checkbox cme-consent cme-mt-s' }, el('input', { type: 'checkbox', name: id, required }), ` ${label}`));
    } else if (type === 'checkboxes') {
      form.append(el(
        'fieldset',
        { class: 'cme-fieldset cme-mt-s' },
        el('legend', { class: 'cme-fieldset__legend' }, label),
        el('div', { class: 'cme-checkbox-group' }, options.map((o) => el('label', { class: 'cme-checkbox' }, el('input', { type: 'checkbox', name: id, value: o }), ` ${o}`))),
      ));
    } else {
      grid.append(field(label, type, options, required, id));
    }
  });

  const status = el('p', { class: 'cme-fine cme-mt-s', role: 'status' });
  form.append(el('button', { class: 'cme-btn cme-btn--primary cme-btn--lg cme-mt-s', type: 'submit' }, submit || 'Send'));
  notes.forEach((n) => form.append(el('p', { class: 'cme-fine cme-mt-s' }, n)));
  form.append(status);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    status.textContent = 'Demonstration form: nothing was sent.';
  });
  block.replaceChildren(form);
}
