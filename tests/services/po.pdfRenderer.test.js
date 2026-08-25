// PDF rendering must survive a burst of back-to-back documents.
//
// CONFIRMED DEFECT, reproduced from production (hospitality_main, 2026-08-24).
// Vishal Kamat approved eight POs in eighteen minutes:
//
//   10:33:51  PO 506   rendered
//   10:35:25  PO 511   rendered
//   10:36:17  PO 508   rendered
//   10:36:55  PO 513   rendered (after one retry)
//   10:38:08  PO 510   FAILED — approver retried twice, still failed
//   10:40:54  PO 509   rendered
//   10:46:43  PO 507   FAILED — approver retried three times, still failed
//   10:49:24  PO 501   FAILED — approver retried three times, still failed
//
// Generation worked, then collapsed for thirteen minutes, then recovered.
// Across production, 16 of 437 approved POs carry a document written before
// their own final approval — every one of them the *last* approval on the
// instance, the earlier steps having rendered fine seconds after acting.
//
// Two causes, both in seoController.poPDF:
//   1. every PDF launched its own Chromium (`puppeteer.launch` per call), so a
//      burst of approvals ran a burst of browsers;
//   2. `browser.close()` sat on the happy path only — the catch returned
//      without closing — so each failure leaked a Chromium and made the next
//      launch likelier to fail. A failure avalanche that clears itself only
//      when memory frees up.
//
// The rule these tests pin: one browser is reused across renders, a render
// failure never leaks a browser or a page, and a dead browser is replaced
// rather than reused.

import { describe, it, expect, beforeEach } from "@jest/globals";
import { createPdfRenderer } from "../../app/util/pdfRenderer.js";

// ─────────────────────────────────────────────────────────────────────────
//  A fake Chromium. Counts launches, pages opened and pages/browsers closed,
//  so the tests can assert on lifecycle rather than on mock call counts.
// ─────────────────────────────────────────────────────────────────────────
function makeFakeChromium({ failPdfOnCall = () => false, failLaunchOnCall = () => false } = {}) {
  const state = { launches: 0, browsersOpen: 0, browsersClosed: 0, pagesOpen: 0, pagesClosed: 0, renders: 0 };

  const launch = async () => {
    state.launches += 1;
    if (failLaunchOnCall(state.launches)) throw new Error("Failed to launch the browser process");
    state.browsersOpen += 1;
    let connected = true;

    return {
      isConnected: () => connected,
      newPage: async () => {
        state.pagesOpen += 1;
        let pageClosed = false;
        return {
          setContent: async () => {},
          pdf: async () => {
            state.renders += 1;
            if (failPdfOnCall(state.renders)) throw new Error("Protocol error: Target closed");
          },
          close: async () => { pageClosed = true; state.pagesClosed += 1; },
          isClosed: () => pageClosed,
        };
      },
      close: async () => { connected = false; state.browsersClosed += 1; state.browsersOpen -= 1; },
      // Lets a test simulate Chromium dying underneath us.
      _kill: () => { connected = false; },
    };
  };

  return { launch, state };
}

const render = (renderer, n = 1) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      renderer.renderToFile("<html><body>PO</body></html>", `/tmp/po-${i}.pdf`)
    )
  );

let chromium;
let renderer;

beforeEach(() => {
  chromium = makeFakeChromium();
  renderer = createPdfRenderer({ launch: chromium.launch });
});

describe("PDF renderer browser lifecycle", () => {
  it("reuses one browser across a burst of renders", async () => {
    // The production burst: eight documents back to back. Before the fix this
    // was eight Chromium launches.
    for (let i = 0; i < 8; i++) await render(renderer);

    expect(chromium.state.renders).toBe(8);
    expect(chromium.state.launches).toBe(1);
  });

  it("closes every page it opens, so a burst leaks nothing", async () => {
    for (let i = 0; i < 8; i++) await render(renderer);

    expect(chromium.state.pagesOpen).toBe(8);
    expect(chromium.state.pagesClosed).toBe(8);
  });

  it("closes the page when rendering throws", async () => {
    // PO 510's case: the render fails. The page must still be released —
    // leaking it is what turned one failure into thirteen minutes of them.
    chromium = makeFakeChromium({ failPdfOnCall: (n) => n === 1 });
    renderer = createPdfRenderer({ launch: chromium.launch });

    await expect(render(renderer)).rejects.toThrow(/Target closed/);

    expect(chromium.state.pagesOpen).toBe(1);
    expect(chromium.state.pagesClosed).toBe(1);
  });

  it("keeps rendering after a failure instead of avalanching", async () => {
    // Only the first render fails. The approver's retry must succeed.
    chromium = makeFakeChromium({ failPdfOnCall: (n) => n === 1 });
    renderer = createPdfRenderer({ launch: chromium.launch });

    await expect(render(renderer)).rejects.toThrow();
    await expect(render(renderer)).resolves.toBeDefined();

    expect(chromium.state.pagesClosed).toBe(2);
  });

  it("replaces a browser that has died rather than reusing it", async () => {
    await render(renderer);
    const browser = await renderer._currentBrowser();
    browser._kill();

    await render(renderer);

    expect(chromium.state.launches).toBe(2);
  });

  it("surfaces a launch failure to the caller", async () => {
    // A failed launch must reach regeneratePODocument so the approval can be
    // rolled back — never be swallowed into a silent no-op.
    chromium = makeFakeChromium({ failLaunchOnCall: () => true });
    renderer = createPdfRenderer({ launch: chromium.launch });

    await expect(render(renderer)).rejects.toThrow(/Failed to launch/);
  });

  it("recovers on the next render after a failed launch", async () => {
    chromium = makeFakeChromium({ failLaunchOnCall: (n) => n === 1 });
    renderer = createPdfRenderer({ launch: chromium.launch });

    await expect(render(renderer)).rejects.toThrow(/Failed to launch/);
    await expect(render(renderer)).resolves.toBeDefined();
  });

  it("caps how many pages render at once", async () => {
    // Concurrency is what exhausted the host. Eight simultaneous approvals
    // must not mean eight simultaneous renders.
    let peak = 0;
    let live = 0;
    const slowChromium = makeFakeChromium();
    const baseLaunch = slowChromium.launch;
    const launch = async () => {
      const browser = await baseLaunch();
      const baseNewPage = browser.newPage;
      browser.newPage = async () => {
        const page = await baseNewPage();
        const basePdf = page.pdf;
        page.pdf = async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          await basePdf();
          live -= 1;
        };
        return page;
      };
      return browser;
    };

    const limited = createPdfRenderer({ launch, maxConcurrent: 2 });
    await render(limited, 8);

    expect(peak).toBeLessThanOrEqual(2);
  });
});
