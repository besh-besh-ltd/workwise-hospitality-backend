// Local stand-in for every AWS endpoint the backend calls during the Vendor
// Networks E2E run. Loaded IN-PROCESS by scripts/vendor_networks/e2e_server.sh
// (`node --import`), which also points AWS_ENDPOINT_URL at it, so no AWS request
// leaves the machine and nothing is written to the shared stage bucket.
//
// Why it is needed at all: PO approval is strict about the PO document (render,
// upload, store the URL; any failure fails the approval). Without a reachable
// "S3" the buyer can never get a PO to the vendor.
//
//   PUT  /<key>  stores the body under $E2E_AWS_SINK_DIR/<host>/<key>, answers 200 + ETag
//   GET  /<key>  serves a stored object (404 if absent)
//   anything else (EventBridge Scheduler, Lambda ...)  answers 200 with an empty JSON body
//
// Port: E2E_AWS_SINK_PORT (default 9555). Listens on loopback only (::1 and 127.0.0.1).

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const PORT = Number(process.env.E2E_AWS_SINK_PORT || 9555);
const ROOT = process.env.E2E_AWS_SINK_DIR || "/tmp/vn-e2e-aws-sink";

function objectPath(req) {
  const host = String(req.headers.host || "unknown").replace(/:\d+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = decodeURIComponent(new URL(req.url, "http://sink").pathname).replace(/^\/+/, "");
  const file = path.resolve(ROOT, host, key);
  if (!file.startsWith(path.resolve(ROOT) + path.sep)) return null;
  return file;
}

function handle(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const file = objectPath(req);
    if (req.method === "PUT" && file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      res.writeHead(200, { ETag: `"${crypto.createHash("md5").update(body).digest("hex")}"` });
      return res.end();
    }
    if ((req.method === "GET" || req.method === "HEAD") && file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      return res.end(req.method === "GET" ? fs.readFileSync(file) : undefined);
    }
    if (req.method === "GET" && file && !String(req.headers["content-type"] || "").includes("json")) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
}

// Loopback only, on both families: the SDK addresses S3 virtual-host style and
// <bucket>.localhost resolves to ::1, while plain localhost may resolve to 127.0.0.1.
// One family failing (IPv6 disabled, say) is logged and tolerated; the process exits
// only if neither loopback address can be bound.
const HOSTS = ["::1", "127.0.0.1"];
const failures = [];
const listeners = HOSTS.map((host) => {
  const listener = http.createServer(handle);
  listener.on("error", (err) => {
    console.error(`[e2e-aws-sink] cannot listen on [${host}]:${PORT}: ${err.message}`);
    failures.push(host);
    if (failures.length === HOSTS.length) {
      console.error("[e2e-aws-sink] no loopback address could be bound; refusing to start without the AWS stand-in");
      process.exit(1);
    }
  });
  listener.listen({ port: PORT, host }, () => {
    console.log(`[e2e-aws-sink] AWS stand-in on [${host}]:${PORT}, objects under ${ROOT}`);
  });
  listener.unref();
  return listener;
});
export default listeners;
