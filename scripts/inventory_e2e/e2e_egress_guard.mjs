/* eslint-disable no-console */
// Egress guard for the inventory E2E backend. Loaded IN-PROCESS by
// scripts/inventory_e2e/e2e_server.sh (`node --import`) BEFORE the mail and AWS
// sinks and the app, so every TCP/TLS connection the process opens passes here.
//
// Belt and braces on top of the env overrides and the sinks: it patches
// net.Socket.prototype.connect (pg, http/https agents, tls, gRPC and nodemailer
// all end up there) so that
//   - a connection to a loopback host (localhost, *.localhost, 127.0.0.0/8, ::1)
//     or a unix socket goes ahead, and the first one to each host:port is logged;
//   - ANY other destination is refused before a packet leaves (the socket is
//     destroyed with an error) and logged as BLOCKED.
// A misconfiguration therefore fails loudly instead of reaching the stage RDS,
// Brevo or S3. The log is the proof the runbook asks for:
//
//   $E2E_EGRESS_LOG (default /tmp/inv-e2e/egress.log), one line per event:
//     <iso time> ALLOW 127.0.0.1:5432
//     <iso time> BLOCKED smtp-relay.brevo.com:587
//
// Scope: this process only. Chromium (puppeteer, PO/label PDFs) is a child
// process: the templates are self-contained and puppeteer starts it with
// background networking disabled, but it is not covered by this guard.

import fs from "fs";
import net from "net";
import path from "path";

const LOG = process.env.E2E_EGRESS_LOG || "/tmp/inv-e2e/egress.log";
fs.mkdirSync(path.dirname(LOG), { recursive: true });

const seen = new Set();
const write = (verdict, dest) => {
  const line = `${new Date().toISOString()} ${verdict} ${dest}`;
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch {
    /* logging must never break a connection */
  }
  if (verdict === "BLOCKED") console.error(`[e2e-egress-guard] ${line}`);
};

const isLoopback = (host) => {
  const h = String(host || "localhost").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
};

// Socket#connect is called as (options[, cb]), (port[, host][, cb]), (path[, cb]),
// or internally with one pre-normalised array [options, cb].
const destination = (args) => {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (first.path) return { unix: true, label: `unix:${first.path}` };
    return { host: first.host, label: `${first.host || "localhost"}:${first.port}` };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return { unix: true, label: `unix:${first}` };
  const host = typeof args[1] === "string" ? args[1] : undefined;
  return { host, label: `${host || "localhost"}:${first}` };
};

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const dest = destination(args);
  if (dest.unix || isLoopback(dest.host)) {
    if (!seen.has(dest.label)) {
      seen.add(dest.label);
      write("ALLOW", dest.label);
    }
    return realConnect.apply(this, args);
  }
  write("BLOCKED", dest.label);
  process.nextTick(() => this.destroy(new Error(`E2E egress guard: refused a connection to ${dest.label}`)));
  return this;
};

write("START", `pid ${process.pid}`);
console.log(`[e2e-egress-guard] only loopback connections allowed; log ${LOG}`);
