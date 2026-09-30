import {
  loadHeader,
  loadFooter,
  decorateIcons,
  decorateSections,
  decorateBlocks,
  decorateTemplateAndTheme,
  waitForFirstImage,
  loadSection,
  loadSections,
  loadCSS,
  loadScript,
  buildBlock,
  readBlockConfig,
  toClassName,
} from './aem.js';

if (window.trustedTypes && window.trustedTypes.createPolicy) {
  const innerTT = window.trustedTypes.createPolicy('tt-inner', {
    createHTML: (s) => s, // avoid stack overflow
  });

  window.trustedTypes.createPolicy('default', {
    createHTML: (input, type, sink) => {
      let processedInput = input;
      if (/srcdoc\s*=/i.test(processedInput)) {
        const doc = new DOMParser().parseFromString(innerTT.createHTML(processedInput), 'text/html');
        doc.querySelectorAll('iframe[srcdoc]').forEach((el) => el.removeAttribute('srcdoc'));
        processedInput = doc.body.innerHTML;
      }
      if (sink.includes('createContextualFragment') || sink.includes('Document write')) {
        const doc = new DOMParser().parseFromString(innerTT.createHTML(processedInput), 'text/html');
        doc.querySelectorAll('script').forEach((el) => el.remove());
        processedInput = doc.body.innerHTML;
      }
      return processedInput;
    },
    createScriptURL: (input) => input,
    createScript: (input) => input,
  });
}

/**
 * load fonts.css and set a session storage flag
 */
async function loadFonts() {
  await loadCSS(`${window.hlx.codeBasePath}/styles/fonts.css`);
  try {
    if (!window.location.hostname.includes('localhost')) sessionStorage.setItem('fonts-loaded', 'true');
  } catch (e) {
    // do nothing
  }
}

/**
 * Turns `/widgets/...` links into widget blocks.
 * @param {Element} main The container element
 */
function buildWidgetAutoBlocks(main) {
  const widgetLinks = [...main.querySelectorAll('a[href*="/widgets/"]')];
  widgetLinks.forEach((link) => {
    if (link.closest('.widget')) return;
    const newLink = link.cloneNode(true);
    const widgetBlock = buildBlock('widget', { elems: [newLink] });
    const p = link.closest('p');
    if (
      p
      && p.querySelectorAll('a').length === 1
      && p.querySelector('a') === link
      && p.textContent.trim() === link.textContent.trim()
    ) {
      p.replaceWith(widgetBlock);
    } else {
      link.replaceWith(widgetBlock);
    }
  });
}

/**
 * Builds all synthetic blocks in a container element.
 * @param {Element} main The container element
 */
function buildAutoBlocks(main) {
  try {
    // auto load `*/fragments/*` references
    const fragments = [...main.querySelectorAll('a[href*="/fragments/"]')].filter((f) => !f.closest('.fragment'));
    if (fragments.length > 0) {
      // eslint-disable-next-line import/no-cycle
      import('../blocks/fragment/fragment.js').then(({ loadFragment }) => {
        fragments.forEach(async (fragment) => {
          try {
            const { pathname } = new URL(fragment.href);
            const frag = await loadFragment(pathname);
            fragment.parentElement.replaceWith(...frag.children);
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Fragment loading failed', error);
          }
        });
      });
    }
    buildWidgetAutoBlocks(main);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Auto Blocking failed', error);
  }
}

/**
 * Decorates formatted links to style them as buttons.
 * @param {HTMLElement} main The main container element
 */
function decorateButtons(main) {
  main.querySelectorAll('p a[href]').forEach((a) => {
    a.title = a.title || a.textContent;
    const p = a.closest('p');
    const text = a.textContent.trim();

    // quick structural checks
    if (a.querySelector('img') || p.textContent.trim() !== text) return;

    // skip URL display links
    try {
      if (new URL(a.href).href === new URL(text, window.location).href) return;
    } catch { /* continue */ }

    // require authored formatting for buttonization
    const strong = a.closest('strong');
    const em = a.closest('em');
    if (!strong && !em) return;

    p.className = 'button-wrapper';
    a.className = 'cme-btn';
    if (strong) { // bold link = primary (one per section), italic = secondary
      a.classList.add('cme-btn--primary');
      const outer = em && strong.contains(em) ? strong : (em || strong);
      outer.replaceWith(a);
    } else {
      a.classList.add('cme-btn--secondary');
      em.replaceWith(a);
    }
  });
}

/**
 * Applies Section Metadata (Style, Id, Layout) to its section and removes the table.
 * Styles map to the design language: subtle, inverse, deep, indigo, deepest, tight, flush.
 * @param {Element} main The container element
 */
const DARK_SURFACES = ['inverse', 'deep', 'indigo', 'deepest'];
const SECTION_STYLES = ['subtle', 'tight', 'flush', ...DARK_SURFACES];

function decorateSectionMetadata(main) {
  main.querySelectorAll(':scope > .section').forEach((section) => {
    section.classList.add('cme-section');
    const meta = section.querySelector(':scope > div > .section-metadata');
    if (!meta) return;
    const config = readBlockConfig(meta);
    const styles = [].concat(config.style || []).join(',').split(',')
      .map((s) => toClassName(s.trim()))
      .filter(Boolean);
    styles.forEach((style) => {
      if (!SECTION_STYLES.includes(style)) return;
      section.classList.add(`cme-section--${style}`);
      if (DARK_SURFACES.includes(style)) section.classList.add('cme-inverse');
    });
    if (config.id) section.id = toClassName(config.id);
    if (config.layout) section.dataset.layout = String(config.layout).trim();
    meta.parentElement.remove();
  });
}

/**
 * Wraps each section in .cme-container. With Layout "a-b" (e.g. 9-3, 4-8, 6-6) the leading
 * default content stays full width, the last block goes in the second column and everything
 * else in the first. Runs after decorateBlocks so block loading is unaffected.
 * @param {Element} main The container element
 */
function decorateSectionLayout(main) {
  main.querySelectorAll(':scope > .section').forEach((section) => {
    const wrappers = [...section.children];
    const container = document.createElement('div');
    container.className = 'cme-container';
    const layout = (section.dataset.layout || '').match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    const blockWrappers = wrappers.filter((w) => !w.classList.contains('default-content-wrapper'));
    if (layout && blockWrappers.length >= 2) {
      const firstBlock = wrappers.indexOf(blockWrappers[0]);
      const head = wrappers.slice(0, firstBlock);
      const rest = wrappers.slice(firstBlock);
      const last = blockWrappers[blockWrappers.length - 1];
      const row = document.createElement('div');
      row.className = 'cme-row';
      const [, a, b] = layout;
      const bp = [a, b].includes('9') ? 'lg' : 'md'; // 9-3 sidebars collapse below 993px
      const col1 = document.createElement('div');
      col1.className = `cme-col-${bp}-${a}`;
      const col2 = document.createElement('div');
      col2.className = `cme-col-${bp}-${b}`;
      rest.forEach((w) => (w === last ? col2 : col1).append(w));
      row.append(col1, col2);
      container.append(...head, row);
    } else {
      container.append(...wrappers);
    }
    section.append(container);
  });
}

// eslint-disable-next-line import/prefer-default-export
export function decorateMain(main) {
  decorateIcons(main);
  buildAutoBlocks(main);
  decorateSections(main);
  decorateSectionMetadata(main);
  decorateBlocks(main);
  decorateButtons(main);
  decorateSectionLayout(main);
}

/**
 * Loads everything needed to get to LCP.
 * @param {Element} doc The container element
 */
async function loadEager(doc) {
  document.documentElement.lang = 'en';
  decorateTemplateAndTheme();
  const main = doc.querySelector('main');
  if (main) {
    decorateMain(main);
    document.body.classList.add('appear');
    await loadSection(main.querySelector('.section'), waitForFirstImage);
  }

  try {
    /* if desktop (proxy for fast connection) or fonts already loaded, load fonts.css */
    if (window.innerWidth >= 900 || sessionStorage.getItem('fonts-loaded')) {
      loadFonts();
    }
  } catch (e) {
    // do nothing
  }
}

/**
 * Loads everything that doesn't need to be delayed.
 * @param {Element} doc The container element
 */
async function loadLazy(doc) {
  loadHeader(doc.querySelector('body > header'));

  const main = doc.querySelector('main');
  await loadSections(main);

  const { hash } = window.location;
  const element = hash ? doc.getElementById(hash.substring(1)) : false;
  if (hash && element) element.scrollIntoView();

  loadFooter(doc.querySelector('body > footer'));

  loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);
  // design-language behaviours (accordion, tabs, dropdown, mobile menu); event-delegated
  loadScript(`${window.hlx.codeBasePath}/scripts/cme.js`);
  loadFonts();
}

/**
 * Loads everything that happens a lot later,
 * without impacting the user experience.
 */
function loadDelayed() {
  import('./consent-check.js');
  // load anything that can be postponed to the latest here
}

async function loadPage() {
  await loadEager(document);
  await loadLazy(document);
  loadDelayed();
}

loadPage();
