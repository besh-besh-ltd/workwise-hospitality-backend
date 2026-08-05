#!/usr/bin/env node
/**
 * Fails the build when an HTTP response is emitted from INSIDE a pg-promise
 * `db.tx()` / `db.task()` callback.
 *
 *   node scripts/check-response-in-tx.mjs           # verify, human-readable
 *   node scripts/check-response-in-tx.mjs --list    # list every tx/task site
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A BUILD GATE
 *
 * Responding inside the transaction callback puts the bytes on the socket
 * BEFORE pg-promise issues `COMMIT`:
 *
 *     return db.tx(async (t) => {
 *       const arc = await arcModel.createDraft(data, t);
 *       return ok(res, { arc }, 'ARC draft created');   // <-- WRONG
 *     });
 *
 * Two failure modes, both observed in production:
 *
 *   1. Read-after-write races. The client gets its 200 and immediately re-reads
 *      the record; that read is served by a DIFFERENT pooled connection and
 *      sees the pre-commit snapshot, so it 404s on a row the same request just
 *      reported creating. This also produced intermittent `arc-core-2` CI
 *      failures with a rotating victim (arc.publishApproval, arc.publish.
 *      validation, ...) because the test harness has its own pg-promise pool.
 *   2. Unreportable commit failures. If `COMMIT` then fails, the headers are
 *      already flushed, so the error handler's 500 can never reach the client.
 *      The request reports success for work that rolled back.
 *
 * The fix is always the same shape — return data, respond after it resolves:
 *
 *     const result = await db.tx(async (t) => { ...; return data; });
 *     return ok(res, result, 'message');
 *
 * Validation guards that need `t` to read the rows they check should return a
 * marker from `app/helper/deferredResponse.js` (deferBad / deferJson) and let
 * the caller emit it post-commit.
 *
 * ---------------------------------------------------------------------------
 * HOW IT DECIDES SCOPE (this is the part a naive grep gets wrong)
 *
 * A plain `grep` for `ok(res` near `db.tx` flags every response that merely
 * FOLLOWS a transaction, which is the correct pattern. So this script masks the
 * source first — comments, string literals, template literals and regex
 * literals are blanked out (preserving offsets and newlines so reported line
 * numbers stay true) — and then matches parentheses to find the exact byte
 * range of each `.tx(...)` / `.task(...)` argument list. Only response writes
 * inside that range count.
 *
 * The result is cross-checked against an acorn AST walk over the same tree; the
 * two agree exactly on the current codebase. This file stays dependency-free on
 * purpose: the CI job that runs it (`shards`) installs nothing, which is what
 * keeps it a ~10s fail-fast gate rather than a full `npm ci`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIR = join(ROOT, "app");
const LIST_ALL = process.argv.includes("--list");

/**
 * Narrow, reviewable exceptions. Each entry must name the exact function and
 * say why responding mid-transaction is correct there — e.g. a streamed body
 * that genuinely has to be written while the cursor is open.
 *
 * This is deliberately NOT a file-level or rule-level off switch. If you are
 * adding an entry because a fix looked hard, fix it instead: the deferred-
 * response markers in app/helper/deferredResponse.js cover the awkward case
 * (early-return validation guards that need the transaction handle).
 *
 * @type {{ file: string, fn: string, reason: string }[]}
 */
const ALLOWLIST = [];

// ---------------------------------------------------------------------------
// Source masking
// ---------------------------------------------------------------------------

/**
 * Blank out comments, strings, template literals and regex literals, keeping
 * every other byte (and every newline) at its original offset.
 */
function maskLiterals(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };

  // Last non-space character of already-masked output — decides regex vs divide.
  const prevSignificant = (from) => {
    for (let k = from - 1; k >= 0; k--) {
      const ch = out[k];
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") continue;
      return ch;
    }
    return null;
  };

  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== ch) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n") break; // unterminated — stop at the newline
        j++;
      }
      blank(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      // Mask the whole template, substitutions included. Nested templates inside
      // `${...}` are tracked so the terminator is found correctly.
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (src[j] === "}" && depth > 0) { depth--; j++; continue; }
        if (src[j] === "`") {
          if (depth === 0) break;
          // A nested template inside a substitution: skip it wholesale.
          let k = j + 1;
          while (k < n && src[k] !== "`") { if (src[k] === "\\") k++; k++; }
          j = k + 1;
          continue;
        }
        j++;
      }
      blank(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (ch === "/") {
      // Regex literal only where a value cannot precede it.
      const p = prevSignificant(i);
      const divideFollows = p !== null && (/[A-Za-z0-9_$)\]]/.test(p));
      if (!divideFollows) {
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n) {
          const c = src[j];
          if (c === "\\") { j += 2; continue; }
          if (c === "\n") break; // regex literals cannot span lines
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) { ok = true; break; }
          j++;
        }
        if (ok) {
          let k = j + 1;
          while (k < n && /[a-z]/.test(src[k])) k++; // flags
          blank(i, k);
          i = k;
          continue;
        }
      }
    }
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** `.tx(` / `.task(` / `.txIf(` / `.taskIf(` — the receiver is captured for the report. */
const TX_CALL = /(\b[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*(tx|task|txIf|taskIf)\s*\(/g;

/** Anything that writes to the response object. */
const RESPONSE_PATTERNS = [
  {
    name: "res.<writer>()",
    re: /\b(?:res|response)\s*\.\s*(?:status|json|send|sendStatus|end|download|redirect|render|sendFile|jsonp)\s*\(/g,
  },
  {
    // Any helper handed the response object — ok(res, ...), bad(res, ...),
    // fail(res, ...), or a project-specific wrapper. Passing `res` out of a
    // transaction callback is the thing being forbidden, whatever it is called.
    name: "helper(res, ...)",
    re: /\b([A-Za-z_$][\w$]*)\s*\(\s*(?:res|response)\s*[,)]/g,
  },
];

/** Byte offset just past the `)` matching the `(` at `open` (masked source). */
function matchParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return masked.length - 1;
}

function lineOf(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Nearest preceding `function name(` / `const name = ` / `name(req, res)` — for the report only. */
function enclosingName(src, offset) {
  const head = src.slice(0, offset);
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    /([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(\s*req\b/g,
  ];
  let best = { idx: -1, name: "<top-level>" };
  for (const re of patterns) {
    let m;
    while ((m = re.exec(head)) !== null) {
      if (m.index > best.idx) best = { idx: m.index, name: m[1] };
    }
  }
  return best.name;
}

function jsFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => join(e.parentPath ?? e.path, e.name))
    .filter((p) => !p.includes(`${sep}node_modules${sep}`))
    .sort();
}

const files = jsFiles(SCAN_DIR);
if (files.length === 0) {
  console.error(`FAIL: no .js files found under ${SCAN_DIR}.`);
  console.error("      Either the app moved or this script's glob is wrong — both are bugs.");
  process.exit(1);
}

const findings = [];
const sites = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (!/\.(?:tx|task|txIf|taskIf)\s*\(/.test(src)) continue;

  const masked = maskLiterals(src);
  const rel = relative(ROOT, file).split(sep).join("/");
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);

  TX_CALL.lastIndex = 0;
  let m;
  while ((m = TX_CALL.exec(masked)) !== null) {
    const openParen = masked.indexOf("(", m.index + m[0].length - 1);
    const closeParen = matchParen(masked, openParen);
    const call = `${m[1]}.${m[2]}`;
    const txLine = lineOf(lineStarts, m.index);
    const fn = enclosingName(src, m.index);
    const body = masked.slice(openParen, closeParen + 1);

    const hits = [];
    for (const { name, re } of RESPONSE_PATTERNS) {
      re.lastIndex = 0;
      let h;
      while ((h = re.exec(body)) !== null) {
        // `db.tx(...)` itself matches "helper(res, ...)" only if res is an arg;
        // skip the tx call's own opening paren defensively.
        const abs = openParen + h.index;
        const line = lineOf(lineStarts, abs);
        const snippet = src.slice(abs, Math.min(abs + 90, src.length)).split("\n")[0].trim();
        hits.push({ name, line, snippet });
      }
    }
    // Dedupe: a chained res.status(x).json(y) matches once per link.
    const byLine = new Map();
    for (const h of hits) if (!byLine.has(h.line)) byLine.set(h.line, h);
    const unique = [...byLine.values()].sort((a, b) => a.line - b.line);

    sites.push({ file: rel, line: txLine, call, fn, count: unique.length });

    if (unique.length === 0) continue;
    const waiver = ALLOWLIST.find((a) => a.file === rel && a.fn === fn);
    if (waiver) {
      console.log(`ALLOWED  ${rel}:${txLine}  ${call}() in ${fn}() — ${waiver.reason}`);
      continue;
    }
    findings.push({ file: rel, line: txLine, call, fn, hits: unique });
  }
}

if (LIST_ALL) {
  console.log(`All ${sites.length} tx/task callbacks under app/:\n`);
  for (const s of sites) {
    const flag = s.count > 0 ? `  <-- ${s.count} response site(s)` : "";
    console.log(`  ${s.file}:${s.line}  ${s.call}() in ${s.fn}()${flag}`);
  }
  console.log("");
}

if (findings.length > 0) {
  const total = findings.reduce((a, f) => a + f.hits.length, 0);
  console.error(
    `FAIL: ${total} HTTP response(s) emitted inside ${findings.length} transaction callback(s).\n`
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.call}(...) in ${f.fn}()`);
    for (const h of f.hits) console.error(`      L${h.line}  ${h.name}  ${h.snippet}`);
    console.error("");
  }
  console.error("  The response is written to the socket BEFORE pg-promise issues COMMIT, so a");
  console.error("  client that re-reads the record can miss its own write, and a failing COMMIT");
  console.error("  can no longer be reported (headers are already sent).\n");
  console.error("  Return the data from the transaction and respond after it resolves:");
  console.error("      const result = await db.tx(async (t) => { ...; return data; });");
  console.error("      return ok(res, result, 'message');\n");
  console.error("  For validation guards that need `t`, return a marker instead of writing to");
  console.error("  `res` — see deferBad / deferJson in app/helper/deferredResponse.js.");
  process.exit(1);
}

console.log(
  `OK: ${sites.length} tx/task callbacks across ${files.length} files — none writes to the response.`
);
