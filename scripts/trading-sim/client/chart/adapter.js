/**
 * The chart adapter contract (DECISIONS D6). The chart widget talks only to this interface, so the
 * uPlot chart can be replaced by the licensed TradingView library (see tradingview/README.md)
 * without touching the toolbar, the legend, the trading lines or the save/load code.
 *
 * Coordinates are bar times in milliseconds and prices as numbers. The adapter draws; it never
 * places or changes orders itself. It reports what the user did (dragged a line, pressed ×) and
 * the widget decides what that means.
 */

/** @typedef {import('./indicators/index.js').Bar} Bar */

/** @typedef {'candles' | 'bars' | 'hollow' | 'heikin-ashi' | 'line' | 'area'} ChartType */
/** @typedef {'cursor' | 'hline' | 'vline' | 'trend' | 'ray' | 'rect' | 'fib'} DrawingTool */

/**
 * A horizontal trading line: a working order, a position, or a position's stop loss / take profit.
 * @typedef {object} ChartLine
 * @property {string} id
 * @property {number} price
 * @property {'order' | 'position' | 'stop-loss' | 'take-profit' | 'alert'} kind
 * @property {'buy' | 'sell'} side
 * @property {string} label        the coloured part, e.g. "Buy LMT 0.5"
 * @property {string} [text]       the plain part, e.g. a position's P&L
 * @property {boolean} [draggable]  the widget modifies the order on drop
 * @property {boolean} [cancellable] shows a × that reports 'lineCancel'
 * @property {'gain' | 'loss'} [tone] colours a position's P&L text
 */

/**
 * An execution mark (P-10).
 * @typedef {{ id: string, time: number, side: 'buy' | 'sell', text: string }} ChartMark
 */

/**
 * A drawing in data coordinates, so it survives zoom, new bars and a reload.
 * @typedef {object} Drawing
 * @property {string} id
 * @property {Exclude<DrawingTool, 'cursor'>} type
 * @property {Array<{ time: number, price: number }>} points
 * @property {boolean} [locked]
 */

/**
 * @typedef {object} IndicatorInstance
 * @property {string} key  unique within the chart
 * @property {string} id   the indicator's registry id
 * @property {Record<string, number>} params
 */

/**
 * What the chart saves (TradingView keeps the same things in its chart layout JSON).
 * @typedef {object} ChartState
 * @property {ChartType} type
 * @property {boolean} log
 * @property {boolean} percent
 * @property {boolean} autoScale
 * @property {Array<{ id: string, params: Record<string, number> }>} indicators
 * @property {Drawing[]} drawings
 * @property {{ volume: boolean, grid: boolean, lastPrice: boolean, executions: boolean }} show
 * @property {string} timezone  intraday time labels: 'UTC' (the spec's default, P-1), 'local' or an IANA name
 */

/**
 * @typedef {object} CrosshairInfo
 * @property {Bar | null} bar
 * @property {number} index
 * @property {number | null} price  the price under the pointer
 * @property {Array<{ key: string, name: string, value: number | null, color: string }>} indicators
 */

/**
 * @typedef {object} IndicatorInfo
 * @property {string} key @property {string} id @property {string} title
 * @property {'price' | 'oscillator' | 'profile'} pane @property {string} color
 * @property {Record<string, number>} params
 */

/**
 * @typedef {object} ChartEvents
 * @property {CrosshairInfo} crosshair
 * @property {{ id: string, price: number }} lineDrag      a trading line was dropped at a new price
 * @property {{ id: string }} lineCancel                   × on a trading line
 * @property {{ id: string }} lineClick                    a click on a line's label
 * @property {{ price: number, time: number, x: number, y: number }} contextMenu
 * @property {void} needHistory                            the user scrolled to the oldest bar
 * @property {Drawing[]} drawingsChange                    a drawing was added, moved or removed
 * @property {DrawingTool} toolChange                      the active tool changed (one-shot tools return to cursor)
 * @property {ChartState['indicators']} indicatorsChange   an indicator was removed from its pane's legend
 * @property {boolean} autoScaleChange                    the price scale left or returned to auto (axis drag, double-click)
 */

/**
 * @typedef {object} ChartAdapter
 * @property {(bars: Bar[], opts?: { resolution: string, symbol: string, intraday: boolean }) => void} setData  replaces everything; shows the newest bars
 * @property {(bars: Bar[]) => void} prependData  older bars from history paging; the view does not move
 * @property {(bar: Bar) => void} updateBar   a live bar: replaces the newest or appends
 * @property {(state: Partial<ChartState>) => void} configure  type, scale mode, indicators, drawings, visibility
 * @property {() => ChartState} getState
 * @property {(lines: ChartLine[]) => void} setLines
 * @property {(marks: ChartMark[]) => void} setMarks
 * @property {(tool: DrawingTool) => void} setTool
 * @property {() => boolean} deleteSelected   removes the selected drawing
 * @property {() => void} resetView
 * @property {() => Bar[]} getBars
 * @property {() => IndicatorInfo[]} listIndicators
 * @property {() => { from: number, to: number }} visibleTimeRange
 * @property {() => Promise<Blob | null>} screenshot
 * @property {() => void} setTheme  re-reads the colour tokens
 * @property {() => void} resize
 * @property {<K extends keyof ChartEvents>(event: K, cb: (value: ChartEvents[K]) => void) => () => void} on
 * @property {() => void} destroy
 */

/**
 * @typedef {object} ChartOptions
 * @property {HTMLElement} container
 * @property {(price: number) => string} formatPrice
 * @property {(price: number) => number} roundPrice  snaps a dragged price to the tick
 * @property {number} tick  the price step for keyboard moves of a trading line
 * @property {Partial<ChartState>} [state]
 */

/** @type {ChartState} */
export const DEFAULT_STATE = Object.freeze({
  type: 'candles', log: false, percent: false, autoScale: true, indicators: [], drawings: [],
  show: { volume: true, grid: true, lastPrice: true, executions: true }, timezone: 'UTC',
});

export const TIME_ZONES = [
  { id: 'UTC', label: 'UTC' }, { id: 'America/New_York', label: 'New York (stock exchanges)' },
  { id: 'America/Chicago', label: 'Chicago (CME)' }, { id: 'local', label: 'This computer' },
];

export const CHART_TYPES = /** @type {Array<{ id: ChartType, label: string }>} */ ([
  { id: 'candles', label: 'Candles' }, { id: 'hollow', label: 'Hollow candles' }, { id: 'heikin-ashi', label: 'Heikin Ashi' },
  { id: 'bars', label: 'Bars' }, { id: 'line', label: 'Line' }, { id: 'area', label: 'Area' },
]);

export const DRAWING_TOOLS = /** @type {Array<{ id: DrawingTool, label: string, icon: string }>} */ ([
  { id: 'cursor', label: 'Cursor', icon: 'cursor' },
  { id: 'trend', label: 'Trend line', icon: 'trend-line' },
  { id: 'ray', label: 'Ray', icon: 'ray' },
  { id: 'hline', label: 'Horizontal line', icon: 'horizontal-line' },
  { id: 'vline', label: 'Vertical line', icon: 'vertical-line' },
  { id: 'rect', label: 'Rectangle', icon: 'rectangle' },
  { id: 'fib', label: 'Fibonacci retracement', icon: 'fib' },
]);

/**
 * Create the chart. Today this is always uPlot; the licensed library would be another branch.
 * @param {ChartOptions} options
 * @returns {Promise<ChartAdapter>}
 */
export async function createChart(options) {
  const { createUplotChart } = await import('./uplot/adapter.js');
  return createUplotChart(options);
}
