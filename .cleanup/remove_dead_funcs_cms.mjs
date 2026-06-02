#!/usr/bin/env node
// Same brace-walking approach as remove_dead_funcs.mjs, applied to cmsModel.js.
// Targets the 10 study-abroad functions duplicated from userModel.js — verified
// zero `cmsModel.<name>` callers anywhere in app/.
//
// IMPORTANT: cmsModel.js still has live CMS functions (camelCase like
// getBlogDetail, blogListing, etc.) that are wired to /api/v1/cms/* routes.
// We do NOT touch those. This script removes only the snake_case
// study-abroad-style duplicates.

import fs from 'fs';

const TARGET = '/Users/apple/Documents/Workwise/hospitality/backend/app/models/cmsModel.js';

const DEAD = new Set([
  'agent_register', 'agent_user_update', 'agent_user_status_update',
  'get_blog_detail', 'get_blog_count', 'get_blog_list',
  'get_student_list_by_agent', 'get_student_list_by_agent_count',
  'assigned_councellors_by_student_id', 'assigned_agent_by_student_id',
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
