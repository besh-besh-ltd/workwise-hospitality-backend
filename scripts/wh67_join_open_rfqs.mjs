/**
 * WH-67 — restore vendors stranded by the empty-bid_end_date backfill crash.
 *
 * Replays POST /hospitality/vendor/join-open-rfqs server-side for a given
 * vendor, using the application's own model + email helpers, so the result is
 * byte-identical to the vendor having clicked through the post-payment flow:
 * snapshot rows in tbl_rfq_product_vendors, a no-login token per RFQ, the
 * consolidated vendor email, and the per-creator "vendor auto-added" emails.
 *
 * Why a script and not the HTTP endpoint: joinOpenRfqs derives the vendor from
 * req.user.id, so driving it over HTTP would mean minting a JWT for a real
 * external vendor account — impersonation, and it invalidates their session
 * (the JWT check binds to tbl_users.user_agent). Running the same code
 * server-side needs no credential at all.
 *
 *   DRY RUN (default, writes nothing, sends nothing):
 *     DATABASE_NAME=hospitality_main node scripts/wh67_join_open_rfqs.mjs 832 833
 *
 *   APPLY:
 *     DATABASE_NAME=hospitality_main node scripts/wh67_join_open_rfqs.mjs --apply 832 833
 *
 *   APPLY without notifying anyone:
 *     ... --apply --no-email 832 833
 *
 * .env points at hospitality_stage, and dotenv does not override an env var
 * that is already set — but this script does not trust that: it asserts the
 * live database name and refuses to run anywhere else.
 */
import db, { pgp } from '../app/config/dbConn.js';
import hospitalityModel from '../app/models/hospitalityModel.js';
import rfqModel from '../app/models/rfqModel.js';
import {
  sendVendorBulkRfqJoinNotification,
  sendVendorAutoAddedToRfqNotification,
} from '../app/helper/sendEmailFunctions/approvalEmails.js';

const EXPECTED_DB = 'hospitality_main';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SEND_EMAIL = !args.includes('--no-email');
const vendorIds = args.filter((a) => !a.startsWith('--')).map(Number).filter((n) => !Number.isNaN(n));

if (vendorIds.length === 0) {
  console.error('Usage: [--apply] [--no-email] <vendorId> [vendorId...]');
  process.exit(1);
}

async function main() {
  const { current_database: liveDb } = await db.one('SELECT current_database()');
  if (liveDb !== EXPECTED_DB) {
    throw new Error(`Refusing to run: connected to "${liveDb}", expected "${EXPECTED_DB}". Set DATABASE_NAME.`);
  }
  console.log(`db=${liveDb}  mode=${APPLY ? 'APPLY' : 'DRY RUN'}  email=${APPLY && SEND_EMAIL ? 'yes' : 'no'}\n`);

  for (const vendorId of vendorIds) {
    const vendorUser = await db.oneOrNone('SELECT id, name, email FROM tbl_users WHERE id = $1', [vendorId]);
    if (!vendorUser) { console.log(`vendor ${vendorId}: NOT FOUND — skipped\n`); continue; }

    // Same source of truth the endpoint uses to decide what is joinable.
    const matching = await hospitalityModel.getMatchingOpenRfqsForVendor(vendorId);
    console.log(`vendor ${vendorId} <${vendorUser.email}> — ${matching.length} matching open RFQ(s)`);
    if (matching.length === 0) { console.log(''); continue; }

    // Re-validate exactly as joinOpenRfqs does (NULLIF guard included).
    const openRfqs = await db.any(
      `SELECT id, rfq_no, title, is_tender, bid_end_date, created_by
         FROM tbl_rfq
        WHERE id = ANY($1::int[])
          AND status = 1 AND is_published = 1
          AND NULLIF(bid_end_date, '')::timestamp > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')`,
      [matching.map((r) => r.rfq_id ?? r.id)]
    );
    openRfqs.forEach((r) => console.log(`   #${r.rfq_no}  ${String(r.title).slice(0, 62)}`));

    if (!APPLY) { console.log(`   DRY RUN — would join ${openRfqs.length} RFQ(s)\n`); continue; }

    const insertResults = await Promise.all(openRfqs.map((r) => hospitalityModel.addVendorToRfq(vendorId, r.id)));

    const joinedRfqs = [];
    const allVariantIds = new Set();
    openRfqs.forEach((rfq, i) => {
      const inserted = insertResults[i] || [];
      if (inserted.length > 0) {
        joinedRfqs.push({ rfq, inserted });
        inserted.forEach((p) => allVariantIds.add(p.product_variant_id));
      }
    });

    if (joinedRfqs.length === 0) { console.log('   already joined to all — nothing written\n'); continue; }

    const rows = joinedRfqs.reduce((a, j) => a + j.inserted.length, 0);
    const creatorIds = [...new Set(joinedRfqs.map((j) => j.rfq.created_by))];
    const [productNames, creators, ...tokens] = await Promise.all([
      db.any(`SELECT DISTINCT id, COALESCE(name,'') AS name FROM tbl_product_variant WHERE id = ANY($1::int[])`, [[...allVariantIds]]),
      db.any('SELECT id, name, email FROM tbl_users WHERE id = ANY($1::int[])', [creatorIds]),
      ...joinedRfqs.map((j) => rfqModel.insertVendorRfqToken(vendorId, j.rfq.rfq_no).catch(() => null)),
    ]);
    const productNameMap = new Map(productNames.map((p) => [p.id, p.name]));
    const creatorMap = new Map(creators.map((c) => [c.id, c]));
    console.log(`   JOINED ${joinedRfqs.length} RFQ(s), ${rows} snapshot row(s), ${tokens.filter(Boolean).length} token(s)`);

    if (!SEND_EMAIL) { console.log('   emails suppressed (--no-email)\n'); continue; }

    const vendorRfqList = joinedRfqs.map((j, i) => ({
      rfq_id: j.rfq.id, rfq_no: j.rfq.rfq_no, is_tender: j.rfq.is_tender,
      title: j.rfq.title, bid_end_date: j.rfq.bid_end_date,
      token: tokens[i], buyerName: creatorMap.get(j.rfq.created_by)?.name || 'Buyer',
      products: [...new Set(j.inserted.map((p) => productNameMap.get(p.product_variant_id)).filter(Boolean))],
    }));
    await sendVendorBulkRfqJoinNotification({
      vendor_name: vendorUser.name, vendor_email: vendorUser.email, rfqs: vendorRfqList,
    }).catch((e) => console.log(`   vendor email failed: ${e.message}`));

    const creatorRfqMap = new Map();
    for (const { rfq, inserted } of joinedRfqs) {
      const creator = creatorMap.get(rfq.created_by);
      if (!creator) continue;
      if (!creatorRfqMap.has(creator.id)) creatorRfqMap.set(creator.id, { creator, rfqs: [] });
      creatorRfqMap.get(creator.id).rfqs.push({
        rfq_id: rfq.id, rfq_no: rfq.rfq_no, is_tender: rfq.is_tender, title: rfq.title,
        product_names: [...new Set(inserted.map((p) => productNameMap.get(p.product_variant_id)).filter(Boolean))],
      });
    }
    for (const { creator, rfqs } of creatorRfqMap.values()) {
      await sendVendorAutoAddedToRfqNotification({
        creator_email: creator.email, creator_name: creator.name, rfqs,
      }).catch((e) => console.log(`   creator email failed: ${e.message}`));
    }
    console.log(`   emailed vendor + ${creatorRfqMap.size} creator(s)\n`);
  }
}

main()
  .catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pgp.end());
