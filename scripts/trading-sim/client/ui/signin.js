/**
 * The sign-in screen (design language 1.2.4 `cme-tsignin`): an email address and a password.
 * There is no separate sign-up: the server creates the account the first time an address signs
 * in, and remembers its password for next time (server/users.js), which the screen says.
 *
 * Accessibility: real <form> with labelled fields and the browser's autocomplete hints (so
 * password managers work), the error line is role="alert" and the field it concerns gets
 * aria-invalid and focus, and the button shows progress while the server checks.
 */
import { el, uid } from './dom.js';
import { signIn } from '../transport/tokens.js';

/**
 * Show the screen in `root` and resolve with the session once the user is signed in.
 * @param {HTMLElement} root
 * @param {{ authUrl: string, notice?: string }} o  notice: a line above the form (e.g. "You were signed out")
 * @returns {Promise<import('../transport/tokens.js').Session & { created: boolean }>}
 */
export function showSignIn(root, { authUrl, notice }) {
  return new Promise((resolve) => {
    const emailId = uid('email');
    const passwordId = uid('password');
    const email = /** @type {HTMLInputElement} */ (el('input', { class: 'cme-tinput', id: emailId, type: 'email', name: 'email', autocomplete: 'username', required: true, maxlength: '254', inputmode: 'email' }));
    const password = /** @type {HTMLInputElement} */ (el('input', { class: 'cme-tinput', id: passwordId, type: 'password', name: 'password', autocomplete: 'current-password', required: true, minlength: '8', maxlength: '200' }));
    const error = el('p', { class: 'cme-tsignin__error', role: 'alert' });
    const submit = /** @type {HTMLButtonElement} */ (el('button', { class: 'cme-tbtn cme-tsignin__submit', type: 'submit' }, 'Sign in'));
    const form = el('form', { class: 'cme-tsignin__form', novalidate: true },
      el('div', { class: 'cme-tfield' }, el('label', { class: 'cme-tfield__label', for: emailId }, 'Email address'), email),
      el('div', { class: 'cme-tfield' }, el('label', { class: 'cme-tfield__label', for: passwordId }, 'Password'), password,
        el('p', { class: 'cme-tfield__hint' }, 'At least 8 characters.')),
      error, submit);

    /** @param {string} message @param {HTMLInputElement | null} field */
    const fail = (message, field) => {
      error.textContent = message;
      for (const f of [email, password]) f.removeAttribute('aria-invalid');
      if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!email.value.trim() || !email.checkValidity()) { fail('Enter a valid email address.', email); return; }
      if (password.value.length < 8) { fail('Enter a password of at least 8 characters.', password); return; }
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      try {
        resolve(await signIn(authUrl, email.value.trim(), password.value));
      } catch (err) {
        const status = /** @type {any} */ (err).status;
        fail(/** @type {Error} */ (err).message, status === 401 ? password : status === 400 ? email : null);
        if (status === 401) password.select();
        submit.disabled = false;
        submit.textContent = 'Sign in';
      }
    });

    root.replaceChildren(el('main', { class: 'cme-tsignin' },
      el('div', { class: 'cme-tsignin__card' },
        el('p', { class: 'ts-brand' }, 'Trading Simulator'),
        el('h1', { class: 'cme-tsignin__title' }, 'Sign in'),
        notice ? el('p', { class: 'cme-tsignin__text', role: 'status' }, notice) : null,
        el('p', { class: 'cme-tsignin__text' }, 'Practice trading with simulated prices. New here? Signing in with a new email address creates your practice account, and you sign in with the same email and password next time.'),
        form)));
    email.focus();
  });
}
