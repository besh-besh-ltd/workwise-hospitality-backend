// S3 is the flakiest hop in document generation, and it got exactly one attempt.
//
// Every other step of writing a PO document is local: read a template, render
// on a browser we already own, write a file. The upload is the one network
// call, and a single transient failure there used to be indistinguishable from
// a permanent one — the caller stored a container-local path and moved on.
//
// Now that a failed upload rolls the approver's approval back, one flaky
// packet must not cost someone their approval. Retry the transient shapes,
// fail fast on the ones retrying cannot fix.

import { describe, it, expect, beforeEach } from "@jest/globals";
import { withUploadRetry } from "../../app/services/poDocumentService.js";

let attempts;
const sleep = async () => {}; // no real waiting in tests

const failingTimes = (n, result = { ok: true, url: "https://s3/po.pdf" }) => async () => {
  attempts += 1;
  if (attempts <= n) return { ok: false, error: "NetworkingError: socket hang up" };
  return result;
};

beforeEach(() => { attempts = 0; });

describe("PO document S3 upload retry", () => {
  it("returns the first successful upload without retrying", async () => {
    const upload = withUploadRetry(failingTimes(0), { sleep });

    const result = await upload("/tmp/po.pdf", "po-1.pdf");

    expect(result.ok).toBe(true);
    expect(attempts).toBe(1);
  });

  it("recovers from a transient failure", async () => {
    const upload = withUploadRetry(failingTimes(1), { sleep });

    const result = await upload("/tmp/po.pdf", "po-1.pdf");

    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it("gives up after the configured number of attempts", async () => {
    const upload = withUploadRetry(failingTimes(99), { sleep, attempts: 3 });

    const result = await upload("/tmp/po.pdf", "po-1.pdf");

    expect(result.ok).toBe(false);
    expect(attempts).toBe(3);
  });

  it("reports the last failure so the approver sees why", async () => {
    const upload = withUploadRetry(failingTimes(99), { sleep, attempts: 2 });

    const result = await upload("/tmp/po.pdf", "po-1.pdf");

    expect(result.error).toMatch(/socket hang up/);
  });

  it("does not retry a missing file", async () => {
    // Nothing to upload is not a network blip — retrying only delays the error.
    const upload = withUploadRetry(
      async () => { attempts += 1; return { ok: false, error: "File not found: /tmp/po.pdf" }; },
      { sleep, attempts: 3 }
    );

    const result = await upload("/tmp/po.pdf", "po-1.pdf");

    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it("retries when the uploader throws rather than returning a result", async () => {
    const upload = withUploadRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("ETIMEDOUT");
        return { ok: true, url: "https://s3/po.pdf" };
      },
      { sleep }
    );

    const result = await upload("/tmp/po.pdf", "po-1.pdf");

    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it("backs off between attempts", async () => {
    const waits = [];
    const upload = withUploadRetry(failingTimes(2), { sleep: async (ms) => waits.push(ms) });

    await upload("/tmp/po.pdf", "po-1.pdf");

    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });
});
