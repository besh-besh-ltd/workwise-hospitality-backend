import puppeteer from 'puppeteer';
import { logger } from './logger.js';

/**
 * Shared Chromium renderer.
 *
 * Every PO PDF used to launch its own Chromium and, on failure, leak it — the
 * catch in seoController.poPDF returned without calling `browser.close()`.
 * Production showed what that costs: on 2026-08-24 one approver cleared eight
 * POs in eighteen minutes, the first four rendered, and then generation failed
 * for thirteen minutes straight before recovering on its own. Each failure left
 * a Chromium behind, which made the next launch likelier to fail.
 *
 * So: one browser, reused; pages always closed in a `finally`; a browser that
 * has died is replaced rather than handed out again; and a ceiling on how many
 * pages render at once, because concurrency is what exhausted the host in the
 * first place.
 *
 * Failures are re-thrown, never swallowed. The caller (regeneratePODocument)
 * needs them to roll the approval back.
 */

// A page render should take well under a second for these templates — they are
// fully self-contained (no external CSS, fonts or images; the company logo is
// inlined as a data URI before we get here). A render still running after this
// is stuck, not slow, and waiting longer only holds a database connection open.
const DEFAULT_RENDER_TIMEOUT_MS = 20_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 2;

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  // Chromium's GPU and audio stacks are dead weight in a container and each
  // one is another process to leak.
  '--disable-gpu',
  '--mute-audio',
  '--no-zygote',
];

const withTimeout = (promise, ms, label) => {
  if (!ms) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

export function createPdfRenderer({
  launch = (opts) => puppeteer.launch(opts),
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  renderTimeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
  launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
} = {}) {
  let browser = null;
  let launching = null;

  // Plain FIFO semaphore. `maxConcurrent` renders run; the rest queue.
  let active = 0;
  const waiters = [];
  const acquire = () =>
    active < maxConcurrent
      ? ((active += 1), Promise.resolve())
      : new Promise((resolve) => waiters.push(resolve));
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };

  const isUsable = (b) => {
    if (!b) return false;
    try {
      return typeof b.isConnected !== 'function' || b.isConnected();
    } catch {
      return false;
    }
  };

  async function getBrowser() {
    if (isUsable(browser)) return browser;

    // A browser that died gets dropped, not reused. Closing it is best-effort:
    // it is already gone, and throwing here would mask the real error.
    if (browser) {
      const dead = browser;
      browser = null;
      Promise.resolve()
        .then(() => dead.close())
        .catch(() => {});
    }

    // Collapse concurrent launches onto one in-flight attempt.
    if (!launching) {
      launching = withTimeout(
        launch({ args: LAUNCH_ARGS, headless: true }),
        launchTimeoutMs,
        'Chromium launch'
      )
        .then((b) => {
          browser = b;
          logger.info('[pdf-renderer] Chromium launched');
          return b;
        })
        .finally(() => {
          // Cleared whether or not the launch worked, so the next render
          // retries instead of reusing a rejected promise forever.
          launching = null;
        });
    }

    return launching;
  }

  async function renderToFile(html, outputPath) {
    await acquire();
    try {
      const b = await getBrowser();
      const page = await b.newPage();
      try {
        await withTimeout(
          // `domcontentloaded` rather than `networkidle0`: these templates
          // reference nothing external, so waiting for network silence bought
          // nothing and risked a 30s hang inside a database transaction.
          page.setContent(html, { waitUntil: 'domcontentloaded' }),
          renderTimeoutMs,
          'PDF setContent'
        );
        await withTimeout(
          page.pdf({
            path: outputPath,
            format: 'A4',
            printBackground: true,
            margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
          }),
          renderTimeoutMs,
          'PDF render'
        );
        return outputPath;
      } finally {
        // The leak that turned one failed PO into thirteen minutes of them.
        await page.close().catch(() => {});
      }
    } finally {
      release();
    }
  }

  async function close() {
    const b = browser;
    browser = null;
    if (b) await b.close().catch(() => {});
  }

  return {
    renderToFile,
    close,
    // Test seam: lets a suite reach the live browser to simulate Chromium dying.
    _currentBrowser: () => getBrowser(),
  };
}

/** Process-wide renderer. One Chromium for the whole app. */
export const pdfRenderer = createPdfRenderer();

// Chromium outlives the Node process unless we take it down with us.
for (const signal of ['SIGINT', 'SIGTERM', 'beforeExit']) {
  process.once(signal, () => { pdfRenderer.close().catch(() => {}); });
}
