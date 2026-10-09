// Local mail sink for the Vendor Networks E2E backend. Loaded IN-PROCESS by
// scripts/vendor_networks/e2e_server.sh (`node --import`), before the app.
//
// The app builds its SMTP transport from a hard-coded host (app/config/app.config.js
// transportConfig: smtp-relay.brevo.com:587), so swapping the credentials alone still
// dials out. This preload replaces nodemailer.createTransport on the shared export
// (nodemailer is CommonJS: every `import nodemailer from "nodemailer"` gets this same
// object) so EVERY transport the app creates, whatever config it passes, is a
// jsonTransport that serialises the message and writes it to a file. Zero network.
//
//   files: $E2E_MAIL_DIR (default /tmp/vn-e2e-mail)/<epoch-ms>-<n>.json
//          { to, from, subject, ... } as nodemailer's jsonTransport renders it

import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

const DIR = process.env.E2E_MAIL_DIR || "/tmp/vn-e2e-mail";
fs.mkdirSync(DIR, { recursive: true });

const realCreateTransport = nodemailer.createTransport.bind(nodemailer);
let seq = 0;

nodemailer.createTransport = function createFileTransport() {
  const transport = realCreateTransport({ jsonTransport: true });
  const send = transport.sendMail.bind(transport);
  transport.sendMail = (mail, cb) => {
    const done = send(mail).then((info) => {
      const file = path.join(DIR, `${Date.now()}-${++seq}.json`);
      fs.writeFileSync(file, info.message);
      return { ...info, response: `250 written to ${file}` };
    });
    if (typeof cb === "function") {
      done.then((info) => cb(null, info), (err) => cb(err));
      return undefined;
    }
    return done;
  };
  transport.verify = (cb) => {
    if (typeof cb === "function") return cb(null, true);
    return Promise.resolve(true);
  };
  return transport;
};

console.log(`[e2e-mail-sink] nodemailer -> ${DIR} (no SMTP)`);
