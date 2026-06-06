#!/usr/bin/env node
// Phase H.1 — also strip the userModel.js communication-settings model
// functions. These backed the /communication-settings routes (already removed
// in this batch) and reference the deprecated tbl_communication_settings*
// tables (per CLAUDE.md §12).

import fs from 'fs';

const TARGET = '/Users/apple/Documents/Workwise/hospitality/backend/app/models/userModel.js';

const DEAD = new Set([
  'setCommunicationSettings',
  'communicationSettingsListCTRL',
  'getCommunicationSettings',
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

console.log(`Removed ${removed.length} model functions from userModel.js:`);
for (const r of removed) console.log(`  ${r.name.padEnd(35)} ${r.lines} lines`);
const totalLines = removed.reduce((s, r) => s + r.lines, 0);
console.log(`\nTotal lines removed: ${totalLines}`);
console.log(`File: ${lines.length} → ${out.split('\n').length} lines`);
