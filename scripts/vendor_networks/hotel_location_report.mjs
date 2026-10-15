/**
 * Vendor Networks: hotels whose state/city text did not resolve to location ids (spec §3).
 *
 * Coverage rules key on tbl_hospitality_company_hotels.state_id / city_id. A hotel without
 * a city_id is matched only by STATE and HOTEL rules; without a state_id, by HOTEL rules
 * only. This read-only report lists them so the text can be corrected (the next hotel save
 * re-resolves the ids) or HOTEL rules used instead.
 *
 *   DATABASE_NAME=hospitality_main node scripts/vendor_networks/hotel_location_report.mjs
 *
 * Reasons: NO_STATE_TEXT | STATE_UNMATCHED (unknown or ambiguous state name)
 *          NO_CITY_TEXT  | CITY_UNMATCHED  (unknown or ambiguous city within the state)
 */
import { pathToFileURL } from 'url';
import db from '../../app/config/dbConn.js';
import { findUnmatchedHotels } from '../../app/helper/hotelLocation.js';

export { findUnmatchedHotels };

/** Printable report lines for the unmatched hotel rows. */
export function formatReport(rows) {
  const lines = [`${rows.length} hotel(s) without full location ids`];
  for (const r of rows) {
    lines.push(
      `${r.id}\t${r.reason}\tstate=${JSON.stringify(r.state)}\tcity=${JSON.stringify(r.city)}\t` +
        `state_id=${r.state_id ?? '-'}\tcity_id=${r.city_id ?? '-'}\t${r.name}`
    );
  }
  return lines.join('\n');
}

async function main() {
  const { current_database: liveDb } = await db.one('SELECT current_database()');
  console.log(`db=${liveDb}`);
  console.log(formatReport(await findUnmatchedHotels(db)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.$pool.end());
}
