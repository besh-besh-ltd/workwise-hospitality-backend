#!/usr/bin/env node
// Pass 2: remove the second-tier dead functions from userModel.js that we
// confirmed via `grep userModel.<name>` after the first pass cleaned the file.
// All have ZERO live callers in app/.

import fs from 'fs';

const TARGET = '/Users/apple/Documents/Workwise/hospitality/backend/app/models/userModel.js';

const DEAD = new Set([
  'clear_forgot_otp_user',
  'add_student', 'add_student_document',
  'get_user_by_id', 'get_appl_status', 'getMenus', 'get_ap_details',
  'addApplicationStatus', 'get_document_types', 'get_user_info',
  'update_session', 'update_otp_status', 'user_preference_update',
  'user_detail_update_profile_status', 'user_detail',
  'checkVendorApproveDetail',
]);

const src = fs.readFileSync(TARGET, 'utf8');
const lines = src.split('\n');

const HEADER = /^  ([a-zA-Z_][a-zA-Z0-9_]*):\s*(async\b|\()/;
const headers = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(HEADER);
  if (m) headers.push({ name: m[1], startLine: i });
}

const ranges = [];
for (let h = 0; h < headers.length; h++) {
  const start = headers[h].startLine;
  const nextStart = h + 1 < headers.length ? headers[h + 1].startLine : lines.length;
  let end = nextStart - 1;
  while (end > start && lines[end].trim() === '') end--;
  ranges.push({ name: headers[h].name, start, end });
}

const removed = [];
const keepLines = new Set();
for (let i = 0; i < lines.length; i++) keepLines.add(i);
for (const r of ranges) {
  if (DEAD.has(r.name)) {
    for (let i = r.start; i <= r.end; i++) keepLines.delete(i);
    removed.push({ name: r.name, lines: r.end - r.start + 1 });
  }
}

const out = lines.filter((_, i) => keepLines.has(i)).join('\n');
fs.writeFileSync(TARGET, out, 'utf8');

console.log(`Removed ${removed.length} dead functions:`);
for (const r of removed) console.log(`  ${r.name.padEnd(40)} ${r.lines} lines`);
const totalLines = removed.reduce((s, r) => s + r.lines, 0);
console.log(`\nTotal lines removed: ${totalLines}`);
console.log(`File: ${lines.length} → ${out.split('\n').length} lines`);
