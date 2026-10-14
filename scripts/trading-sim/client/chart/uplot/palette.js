/**
 * The chart's colours and fonts, read from the design language tokens on the chart's own element,
 * so the canvas follows the light and dark terminal themes (terminal-trading.md, "chart tokens").
 */

/**
 * @typedef {object} Palette
 * @property {string} up @property {string} down @property {string} volUp @property {string} volDown
 * @property {string} onUp @property {string} onDown @property {string} tagDown
 * @property {string} grid @property {string} axis @property {string} text @property {string} textStrong
 * @property {string} panel @property {string} rule @property {string} buy @property {string} sell
 * @property {string} action @property {string} lastPrice @property {string} selection
 * @property {string[]} studies  indicator lines, in assignment order
 * @property {string} font  axis and label font
 * @property {string} fontBold
 */

/** @param {Element} el @returns {Palette} */
export function readPalette(el) {
  const css = getComputedStyle(el);
  const v = (/** @type {string} */ name, /** @type {string} */ fallback) => css.getPropertyValue(name).trim() || fallback;
  const family = v('--font-mono', '"Roboto Mono", monospace');
  const size = v('--type-terminal-body-size', '11px');
  return {
    up: v('--color-terminal-candle-up', '#187E02'),
    down: v('--color-terminal-candle-down', '#FF003D'),
    volUp: v('--color-terminal-volume-up', 'rgba(24,126,2,0.45)'),
    volDown: v('--color-terminal-volume-down', 'rgba(255,0,61,0.45)'),
    onUp: v('--color-terminal-on-candle-up', '#FFFFFF'),
    onDown: v('--color-terminal-on-candle-down', '#FFFFFF'),
    tagDown: v('--color-terminal-tag-down', '#DF0035'),
    grid: v('--color-terminal-chart-grid', '#F0F3F5'),
    axis: v('--color-terminal-chart-axis', '#5A6874'),
    text: v('--color-terminal-text', '#25323C'),
    textStrong: v('--color-terminal-text-strong', '#16202A'),
    panel: v('--color-terminal-panel', '#FFFFFF'),
    rule: v('--color-terminal-rule', '#E2E2E2'),
    buy: v('--color-terminal-buy', '#006EB6'),
    sell: v('--color-terminal-sell', '#E0215A'),
    action: v('--color-terminal-action', '#006EB6'),
    lastPrice: v('--color-terminal-last-price', '#D2E8F8'),
    selection: v('--color-terminal-link', '#006EB6'),
    studies: [1, 2, 3, 4].map((i) => v(`--color-terminal-study-${i}`, ['#0077D9', '#B5428E', '#B86000', '#00855F'][i - 1])),
    font: `${size} ${family}`,
    fontBold: `600 ${size} ${family}`,
  };
}
