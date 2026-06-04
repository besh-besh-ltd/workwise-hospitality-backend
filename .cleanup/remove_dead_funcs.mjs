#!/usr/bin/env node
// One-shot script: remove the listed dead function blocks from userModel.js.
// Each function definition starts at column 2 with `name: async (...) => {` and
// ends at the closing `},` at column 2 (indent depth 2). We use that
// brace-matching invariant to extract exact ranges, drop the listed names, and
// write a new file.
//
// Run from backend/ directory: node .cleanup/remove_dead_funcs.mjs

import fs from 'fs';

const TARGET = '/Users/apple/Documents/Workwise/hospitality/backend/app/models/userModel.js';

// Dead functions verified by grep to have ZERO callers outside userModel.js
// (and where the only ref is via a validator we've already removed).
const DEAD = new Set([
  'user_register_temp', 'agent_register', 'agent_user_update', 'agent_user_status_update',
  'company_user_update', 'company_register', 'company_update', 'company_signature_update',
  'enquiry_submit', 'contact_submit',
  'agent_user_email_exist', 'agent_user_mobile_exist', 'agent_user_id_exist',
  'get_course_list', 'get_blog_detail', 'get_blog_count', 'get_blog_list',
  'get_student_list_by_agent', 'get_student_list_by_agent_count',
  'assigned_councellors_by_student_id', 'assigned_agent_by_student_id',
  'get_course_count', 'get_finance_course_list', 'get_finance_course_list_details',
  'get_finance_course_list_count', 'get_document', 'delete_document',
  'get_scholarship_course_list', 'get_other_course_list',
  'submit_application_passport_details', 'get_app_id', 'processEducation', 'processWorkExp',
  'processEnglishTest', 'get_course_search_list', 'get_university_list', 'get_university_count',
  'get_university_search_list', 'user_mobile_temp_exists', 'agent_user_mobile_exists',
  'get_banner_content', 'get_page_section_content', 'get_cms_contents',
  'update_user_temp_otp', 'update_user_temp_otp_resend', 'update_user_temp_verfication',
  'user_detail_exists', 'update_otp_status_temp', 'qualification_list', 'area_interest_list',
  'get_country_list', 'get_disciplines', 'get_state_list', 'get_intake_list',
  'get_application_id', 'university_id_exists', 'get_university_course_list',
  'get_academic_info', 'get_englist_test', 'get_passport_info', 'get_personal_info',
  'get_status_info', 'get_work_exp_info', 'get_university_detail', 'user_id_temp_exists',
  'fcm_exists_exists', 'document_id_exists', 'get_term_condition', 'user_temp_to_users',
  'update_user_document', 'add_user_document', 'application_status_save',
  'clear_forgot_otp_user_temp', 'user_detail_existss', 'get_all_user', 'user_otp_exists',
  'get_all_user_address', 'delete_address', 'occasion_id_exists', 'get_university_by_courseid',
  'get_highest_grades', 'get_english_tests_names', 'upload_application_documents',
  'get_all_documents', 'getDocumentDetails', 'get_all_applications',
  'update_application_transaction', 'update_application_final_status', 'get_application_by_id',
  'get_active_payment_gateway', 'get_applications_transactions', 'get_document_application_id',
  'get_documents_details', 'update_pay_status', 'create_transaction', 'update_stripe_transaction',
  'del_payment', 'get_course_by_id', 'get_university_by_id',
  'address_id_exists', 'update_user_address',
  'user_email_temp_exist', 'user_mobile_exists',
]);

const src = fs.readFileSync(TARGET, 'utf8');
const lines = src.split('\n');

// Find every top-level function header at indent depth 2 (two spaces).
// Header pattern: `^  <name>: ` followed by `async` or `(`.
const HEADER = /^  ([a-zA-Z_][a-zA-Z0-9_]*):\s*(async\b|\()/;
const headers = []; // { name, startLine }
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(HEADER);
  if (m) headers.push({ name: m[1], startLine: i });
}

// Function block ends at the closing `^  },` line (or the closing brace of
// the model object). Pair each header with the next header's start as a guard.
const ranges = [];
for (let h = 0; h < headers.length; h++) {
  const start = headers[h].startLine;
  const nextStart = h + 1 < headers.length ? headers[h + 1].startLine : lines.length;
  // Walk back from nextStart to find the last `^  },` line. Most often that's
  // nextStart - 1, but blank lines may follow.
  let end = nextStart - 1;
  while (end > start && lines[end].trim() === '') end--;
  ranges.push({ name: headers[h].name, start, end });
}

// Build the keep set.
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
