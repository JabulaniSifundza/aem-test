/**
 * Order ticket (spec §8, requirements UI-1 to UI-3, UI-5, P-3, P-7, P-9, P-12): side, quantity,
 * time in force, order type and prices, leverage, take profit and stop loss with four linked
 * fields each (ticks, price, $ and %), a risk meter, and a preview before every order.
 */
import { el, iconButton, uid } from '../ui/dom.js';
import { segmented, switchField, stepper, field, toast } from '../ui/feedback.js';
import { formatPrice, formatQty, formatMoney, signClass, LABELS } from '../ui/format.js';
import { D } from '../../shared/decimal.js';
import { symbolDef, symbolSelect, watchQuotes, placeOrder, errorText } from './common.js';

/** @typedef {import('./common.js').AppContext} AppContext */
/** @typedef {import('../broker/broker.js').PreOrder} PreOrder */

/** Parse a field the user typed ("4,380.50") into a decimal string, or null. @param {string} v */
const num = (v) => { const s = v.replace(/[,\s]/g, ''); return /^\d*\.?\d+$|^\d+\.$/.test(s) ? s : null; };

/**
 * One bracket section: a switch and four linked steppers.
 * @param {'tp' | 'sl'} kind @param {import('../../shared/symbols.js').SymbolDef} s
 */
function bracketSection(kind, s) {
  const title = kind === 'tp' ? 'Take profit' : 'Stop loss';
  const sw = switchField({ label: title });
  sw.node.querySelector('.cme-switch-field__label')?.classList.replace('cme-switch-field__label', 'cme-ticket__section-title');
  const ticks = stepper({ name: `${kind}-ticks`, value: kind === 'tp' ? '100' : '50', step: '1', min: '1', label: `${title} ticks` });
  const price = stepper({ name: `${kind}-price`, value: '', step: s.tick, label: `${title} price` });
  const money = stepper({ name: `${kind}-money`, value: '', step: '1', min: '0', label: kind === 'tp' ? 'Profit $' : 'Loss $' });
  const pct = stepper({ name: `${kind}-pct`, value: '', step: '0.01', min: '0', label: `${title} percentage` });
  const trailing = kind === 'sl' ? switchField({ label: 'Trailing' }) : null;
  const grid = el('div', { class: 'cme-ticket__grid' },
    field('Ticks', ticks.node), field('Price', price.node),
    field(kind === 'tp' ? 'Profit $' : 'Loss $', money.node), field('Percentage %', pct.node),
    trailing ? el('div', { class: 'cme-ticket__wide' }, trailing.node) : null);
  const node = el('div', { class: 'cme-ticket__section', 'data-bracket': kind }, el('div', { class: 'cme-ticket__section-head' }, sw.node), grid);
  return { node, sw, grid, ticks, price, money, pct, trailing };
}

/**
 * Build a ticket into a container.
 * @param {AppContext} ctx
 * @param {HTMLElement} container
 * @param {{ symbol?: string, side?: 'BUY' | 'SELL', type?: PreOrder['type'], price?: string, onClose?: () => void, onSymbol?: (s: string) => void, fill?: boolean }} init
 */
export function createTicket(ctx, container, init = {}) {
  let symbol = init.symbol ?? 'BTCUSDT';
  let s = symbolDef(symbol);
  /** @type {{ bid?: string, ask?: string, lp?: string, ch?: string }} */
  let quote = {};
  let stopQuotes = () => {};
  let busy = false;

  const form = el('form', { class: `cme-ticket${init.fill ? ' cme-ticket--fill' : ''}`, novalidate: true, 'aria-label': 'Order ticket' });
  const titleId = uid('tk');
  const header = el('div', { class: 'cme-ticket__header' }, el('h2', { class: 'cme-ticket__title', id: titleId }, 'Trade'),
    init.onClose ? iconButton('close', 'Close ticket', { onclick: init.onClose }) : null);
  const picker = symbolSelect({ value: symbol, label: 'Contract', onChange: (v) => setSymbol(v) });
  const bbo = el('div', { class: 'cme-bbo' });
  const tabs = el('div', { class: 'cme-ttabs', role: 'tablist', 'aria-label': 'Product type' },
    el('button', { class: 'cme-ttabs__tab', type: 'button', role: 'tab', 'aria-selected': 'true', 'aria-controls': `${titleId}-f`, id: `${titleId}-tf` }, s.type === 'crypto' ? 'Spot & perps' : 'Shares'),
    el('button', { class: 'cme-ttabs__tab', type: 'button', role: 'tab', 'aria-selected': 'false', 'aria-controls': `${titleId}-o`, id: `${titleId}-to` }, 'Options'));

  const side = segmented({ label: 'Side', options: [{ value: 'BUY', label: 'Buy', side: 'BUY' }, { value: 'SELL', label: 'Sell', side: 'SELL' }], value: init.side ?? 'BUY', size: 'lg', block: true, buySell: true });
  const qty = stepper({ name: 'qty', value: s.minQty, step: s.lot, min: s.minQty, max: s.maxQty, label: 'Quantity' });
  const tif = segmented({ label: 'Time in force', options: ['DAY', 'GTC', 'IOC', 'FOK'].map((v) => ({ value: v, label: LABELS.duration[v] })), value: 'DAY', block: true });
  const type = el('select', { class: 'cme-tselect', name: 'type', 'aria-label': 'Order type' }, ...['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT', 'TRAILING_STOP'].map((t) => el('option', { value: t, selected: t === (init.type ?? 'MARKET') }, LABELS.type[t])));
  const limit = stepper({ name: 'limit', value: init.price ?? '', step: s.tick, min: s.tick, label: 'Limit price' });
  const stop = stepper({ name: 'stop', value: '', step: s.tick, min: s.tick, label: 'Stop price' });
  const trail = stepper({ name: 'trail', value: '100', step: '1', min: '1', label: 'Trail distance (ticks)' });
  const leverage = el('select', { class: 'cme-tselect', name: 'leverage', 'aria-label': 'Leverage' });
  const trailField = field('Trail (ticks)', trail.node);
  const tp = bracketSection('tp', s);
  const sl = bracketSection('sl', s);
  const risk = el('div', { class: 'cme-risk', hidden: true });
  const summary = el('dl', { class: 'cme-ticket__summary' });
  const message = el('p', { class: 'cme-ticket__message', role: 'alert' });
  const submit = el('button', { class: 'cme-tbtn cme-tbtn--buy cme-tbtn--lg cme-tbtn--block', type: 'submit' }, 'Buy');

  const futures = el('div', { role: 'tabpanel', id: `${titleId}-f`, 'aria-labelledby': `${titleId}-tf`, class: 'ts-stack' },
    el('div', { class: 'cme-ticket__grid' },
      el('div', { class: 'cme-tfield' }, el('span', { class: 'cme-tfield__label' }, 'Side'), side.node),
      field(`Quantity (lot ${s.lot})`, qty.node),
      el('div', { class: 'cme-tfield cme-ticket__wide' }, el('span', { class: 'cme-tfield__label' }, 'Time in force'), tif.node),
      field('Order type', type), field('Leverage', leverage),
      field('Limit price', limit.node), field('Stop price', stop.node),
      el('div', { class: 'cme-ticket__wide' }, trailField)),
    tp.node, sl.node, risk,
    el('div', { class: 'cme-ticket__footer' }, summary, message, submit));
  const options = el('div', { role: 'tabpanel', id: `${titleId}-o`, 'aria-labelledby': `${titleId}-to`, hidden: true },
    el('div', { class: 'cme-widget-link' }, el('h3', { class: 'cme-widget-link__title' }, 'Options'), el('p', { class: 'cme-widget-link__text' }, 'Options trading is not part of this simulator. Explore options on cmegroup.com.'),
      el('a', { class: 'cme-tbtn cme-tbtn--outline', href: 'https://www.cmegroup.com/markets/options.html', target: '_blank', rel: 'noopener' }, 'Options on cmegroup.com')));
  form.append(header, picker, bbo, tabs, futures, options);
  container.appendChild(form);

  // ------------------------------------------------------------------ derived values

  const sideValue = () => /** @type {'BUY' | 'SELL'} */ (side.value);
  const qtyValue = () => num(qty.input.value);
  /** The price the order should fill at, for bracket maths and estimates. */
  function entry() {
    const t = type.value;
    if ((t === 'LIMIT' || t === 'STOP_LIMIT') && num(limit.input.value)) return D(/** @type {string} */ (num(limit.input.value)));
    if (t === 'STOP' && num(stop.input.value)) return D(/** @type {string} */ (num(stop.input.value)));
    const ref = sideValue() === 'BUY' ? quote.ask : quote.bid;
    return ref ? D(ref) : null;
  }

  /**
   * Recompute a bracket's four fields from the one the user changed (UI-2).
   * @param {ReturnType<typeof bracketSection>} b @param {'ticks' | 'price' | 'money' | 'pct'} from
   */
  function syncBracket(b, from) {
    const e = entry();
    const q = qtyValue();
    if (!e || !q || D(q).isZero()) return;
    const tick = D(s.tick);
    // +1 when the bracket price sits above entry (buy take profit, sell stop loss).
    const dir = (b === tp) === (sideValue() === 'BUY') ? 1 : -1;
    let ticks;
    try {
      if (from === 'ticks') ticks = D(num(b.ticks.input.value) ?? '0');
      else if (from === 'price') ticks = D(num(b.price.input.value) ?? '0').minus(e).mul(dir).div(tick);
      else if (from === 'money') ticks = D(num(b.money.input.value) ?? '0').div(D(q).mul(tick));
      else ticks = D(num(b.pct.input.value) ?? '0').div(100).mul(e).div(tick);
    } catch { return; }
    ticks = ticks.toDecimalPlaces(0, 4);
    if (ticks.lt(1)) ticks = D(1);
    const price = e.plus(ticks.mul(tick).mul(dir));
    if (from !== 'ticks') b.ticks.input.value = ticks.toString();
    if (from !== 'price') b.price.input.value = price.toFixed(D(s.tick).decimalPlaces());
    if (from !== 'money') b.money.input.value = ticks.mul(tick).mul(q).toFixed(2);
    if (from !== 'pct') b.pct.input.value = ticks.mul(tick).div(e).mul(100).toFixed(2);
  }

  function refreshRisk() {
    const on = tp.sw.checked && sl.sw.checked && !sl.trailing?.checked;
    risk.hidden = !on;
    if (!on) return;
    const r = D(num(sl.money.input.value) ?? '0');
    const w = D(num(tp.money.input.value) ?? '0');
    const total = r.plus(w);
    const share = total.isZero() ? 50 : Number(r.div(total).mul(100).toFixed(1));
    risk.replaceChildren(
      el('div', { class: 'cme-risk__bar', 'aria-hidden': 'true' }, el('span', { class: 'cme-risk__risk', style: `--risk: ${share}%` }), el('span', { class: 'cme-risk__reward' })),
      el('div', { class: 'cme-risk__text' }, el('span', {}, `Risk ${formatMoney(r.toFixed(2))}`), el('span', {}, `Reward ${formatMoney(w.toFixed(2))} · 1:${r.isZero() ? '–' : w.div(r).toFixed(1)}`)));
  }

  function refreshFields() {
    const t = type.value;
    limit.setDisabled(!(t === 'LIMIT' || t === 'STOP_LIMIT'));
    stop.setDisabled(!(t === 'STOP' || t === 'STOP_LIMIT'));
    trailField.hidden = t !== 'TRAILING_STOP';
    for (const b of [tp, sl]) {
      b.grid.hidden = !b.sw.checked;
      const trailingSl = b === sl && Boolean(sl.trailing?.checked);
      b.price.setDisabled(trailingSl); b.money.setDisabled(trailingSl); b.pct.setDisabled(trailingSl);
    }
    if (t === 'TRAILING_STOP') { sl.sw.set(false); sl.node.hidden = true; } else sl.node.hidden = false;
    const q = qtyValue();
    const e = entry();
    summary.replaceChildren();
    if (q && e) {
      const notional = e.mul(q);
      const lev = Number(leverage.value || 1);
      summary.append(el('dt', {}, 'Estimated value'), el('dd', {}, formatMoney(notional.toFixed(2))), el('dt', {}, `Margin at ${lev}×`), el('dd', {}, formatMoney(notional.div(lev).toFixed(2))));
    }
    const sideV = sideValue();
    submit.className = `cme-tbtn cme-tbtn--${sideV === 'BUY' ? 'buy' : 'sell'} cme-tbtn--lg cme-tbtn--block`;
    submit.textContent = `${LABELS.side[sideV]} ${q ? formatQty(symbol, q) : ''} ${symbol}`.replace(/\s+/g, ' ');
    submit.disabled = busy || !validate(false);
    refreshRisk();
  }

  /** @param {boolean} show */
  function validate(show) {
    const problems = [];
    const q = qtyValue();
    if (!q || D(q).lte(0)) problems.push('Enter a quantity.');
    const t = type.value;
    if ((t === 'LIMIT' || t === 'STOP_LIMIT') && !num(limit.input.value)) problems.push('Enter a limit price.');
    if ((t === 'STOP' || t === 'STOP_LIMIT') && !num(stop.input.value)) problems.push('Enter a stop price.');
    if (show) message.textContent = problems.join(' ');
    return problems.length === 0;
  }

  function renderBbo() {
    const item = (/** @type {string} */ label, /** @type {string} */ value, cls = '') => el('div', { class: 'cme-bbo__item' }, el('span', { class: 'cme-bbo__label' }, label), el('span', { class: `cme-bbo__value ${cls}`.trim() }, value));
    bbo.replaceChildren(item('Bid', formatPrice(symbol, quote.bid)), item('Ask', formatPrice(symbol, quote.ask)), item('Last', formatPrice(symbol, quote.lp)), item('Change', formatPrice(symbol, quote.ch, true), signClass(quote.ch)));
  }

  async function loadLeverage() {
    try {
      const info = await ctx.broker.leverageInfo({ symbol });
      const steps = [1, 2, 3, 4, 5, 10, 20, 25, 50, 75, 100].filter((x) => x >= info.min && x <= info.max);
      if (!steps.includes(info.current)) steps.push(info.current);
      leverage.replaceChildren(...steps.sort((a, b) => a - b).map((x) => el('option', { value: String(x), selected: x === info.current }, `${x}×`)));
      refreshFields();
    } catch { /* leverage stays empty */ }
  }

  /** @param {string} next */
  function setSymbol(next) {
    symbol = next;
    s = symbolDef(symbol);
    picker.value = symbol;
    quote = {};
    for (const [stp, step, min] of /** @type {const} */ ([[qty, s.lot, s.minQty], [limit, s.tick, s.tick], [stop, s.tick, s.tick], [tp.price, s.tick, null], [sl.price, s.tick, null]])) {
      stp.node.dataset.step = step;
      if (min) stp.node.dataset.min = min;
    }
    qty.node.dataset.max = s.maxQty;
    qty.input.value = s.minQty;
    limit.input.value = '';
    stop.input.value = '';
    const qtyLabel = futures.querySelector(`label[for="${qty.input.id}"]`);
    if (qtyLabel) qtyLabel.textContent = `Quantity (lot ${s.lot})`;
    /** @type {HTMLElement} */ (tabs.firstElementChild).textContent = s.type === 'crypto' ? 'Spot & perps' : 'Shares';
    stopQuotes();
    stopQuotes = watchQuotes(ctx, [symbol], (q) => {
      if (q.s !== 'ok' || q.n !== symbol) return;
      const first = !quote.lp;
      quote = q.v;
      renderBbo();
      if (first && !limit.input.value && type.value !== 'MARKET') limit.input.value = sideValue() === 'BUY' ? (quote.bid ?? '') : (quote.ask ?? '');
      if (first) { syncBracket(tp, 'ticks'); syncBracket(sl, 'ticks'); }
      refreshFields();
    });
    renderBbo();
    loadLeverage();
    init.onSymbol?.(symbol);
  }

  // ------------------------------------------------------------------ events

  form.addEventListener('input', (e) => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    for (const b of [tp, sl]) {
      if (t === b.ticks.input) syncBracket(b, 'ticks');
      else if (t === b.price.input) syncBracket(b, 'price');
      else if (t === b.money.input) syncBracket(b, 'money');
      else if (t === b.pct.input) syncBracket(b, 'pct');
    }
    if ([qty.input, limit.input, stop.input].includes(t)) { syncBracket(tp, 'ticks'); syncBracket(sl, 'ticks'); }
    message.textContent = '';
    refreshFields();
  });
  form.addEventListener('cme:change', () => { syncBracket(tp, 'ticks'); syncBracket(sl, 'ticks'); refreshFields(); });
  type.addEventListener('change', () => {
    if ((type.value === 'LIMIT' || type.value === 'STOP_LIMIT') && !limit.input.value) limit.input.value = (sideValue() === 'BUY' ? quote.bid : quote.ask) ?? '';
    if ((type.value === 'STOP' || type.value === 'STOP_LIMIT') && !stop.input.value && quote.lp) {
      const away = D(s.tick).mul(20).mul(sideValue() === 'BUY' ? 1 : -1);
      stop.input.value = D(quote.lp).plus(away).toFixed(D(s.tick).decimalPlaces());
    }
    syncBracket(tp, 'ticks'); syncBracket(sl, 'ticks');
    refreshFields();
  });
  leverage.addEventListener('change', async () => {
    try {
      await ctx.broker.setLeverage({ symbol, leverage: Number(leverage.value) });
      toast({ title: 'Leverage changed', text: `${symbol} leverage is now ${leverage.value}×`, type: 'success' });
    } catch (error) {
      toast({ title: 'Leverage not changed', text: errorText(error), type: 'error' });
      loadLeverage();
    }
    refreshFields();
  });
  tabs.addEventListener('click', (e) => {
    const tab = /** @type {HTMLElement} */ (e.target).closest('[role="tab"]');
    if (!tab) return;
    const isOptions = tab.id === `${titleId}-to`;
    tabs.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    futures.hidden = isOptions;
    options.hidden = !isOptions;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate(true) || busy) return;
    const t = /** @type {PreOrder['type']} */ (type.value);
    /** @type {PreOrder} */
    const pre = {
      symbol, side: sideValue(), type: t, qty: /** @type {string} */ (qtyValue()),
      limitPrice: t === 'LIMIT' || t === 'STOP_LIMIT' ? num(limit.input.value) : null,
      stopPrice: t === 'STOP' || t === 'STOP_LIMIT' ? num(stop.input.value) : null,
      trailingStopPips: t === 'TRAILING_STOP' ? Number(num(trail.input.value) ?? '0') : (sl.sw.checked && sl.trailing?.checked ? Number(num(sl.ticks.input.value) ?? '0') : null),
      takeProfit: tp.sw.checked ? num(tp.price.input.value) : null,
      stopLoss: sl.sw.checked && !sl.trailing?.checked ? num(sl.price.input.value) : null,
      duration: /** @type {PreOrder['duration']} */ (tif.value),
    };
    busy = true; refreshFields();
    const id = await placeOrder(ctx, pre);
    busy = false; refreshFields();
    if (id) message.textContent = '';
  });

  setSymbol(symbol);
  refreshFields();

  return {
    form,
    /** @param {{ symbol?: string, side?: 'BUY' | 'SELL', type?: PreOrder['type'], price?: string }} o */
    set(o) {
      if (o.symbol && o.symbol !== symbol) setSymbol(o.symbol);
      if (o.side) side.set(o.side);
      if (o.type) type.value = o.type;
      if (o.price) {
        if (o.type === 'STOP') stop.input.value = o.price; else limit.input.value = o.price;
      }
      syncBracket(tp, 'ticks'); syncBracket(sl, 'ticks');
      refreshFields();
    },
    get symbol() { return symbol; },
    destroy() { stopQuotes(); form.remove(); },
  };
}

/** The docked ticket widget. @param {AppContext} ctx @returns {import('../ui/dock.js').WidgetDef} */
export function ticketWidget(ctx) {
  return {
    kind: 'ticket', icon: 'ticket', title: (p) => `Trade ${p.symbol ?? ''}`.trim(),
    create(container, params, api) {
      const t = createTicket(ctx, container, { symbol: params.symbol, fill: true, onSymbol: (sym) => { api.setTitle(`Trade ${sym}`); api.setParams({ symbol: sym }); } });
      return { destroy: () => t.destroy(), state: () => ({ symbol: t.symbol }) };
    },
  };
}

