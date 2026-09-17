// Group ARC — schema contract.
//
// A group rate contract covers several hotels of one company. tbl_arc.hotel_id
// stays the LEAD hotel; the coverage, per-hotel quantities, per-hotel
// invitations, per-hotel awards and the per-hotel release ledger live in
// group-only child tables. This suite pins the shape later tasks rely on, so a
// migration that drifts from it fails here rather than as a missing column deep
// inside a controller test.

import { db } from "../../setup/db.js";

const columnsOf = (table) =>
  db.any(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );

describe("Group ARC schema", () => {
  test("tbl_arc.is_group exists, is NOT NULL and defaults to false", async () => {
    const col = (await columnsOf("tbl_arc")).find((c) => c.column_name === "is_group");
    expect(col).toBeDefined();
    expect(col.is_nullable).toBe("NO");
    expect(col.column_default).toBe("false");
  });

  test.each([
    ["tbl_arc_hotel_mappings", ["arc_id", "hotel_id", "created_by", "created_at"]],
    ["tbl_arc_item_hotel_qty", ["arc_item_id", "hotel_id", "indicative_qty"]],
    ["tbl_arc_invitation_hotel", ["arc_invitation_id", "hotel_id"]],
    ["tbl_arc_comm_evaluation_award_hotel", ["arc_comm_evaluation_award_id", "hotel_id", "allocated_qty"]],
    [
      "tbl_arc_contract_line_hotel",
      [
        "arc_contract_line_id", "hotel_id", "committed_qty", "consumed_qty",
        "unit_rate_override", "charges_override", "fulfilling_vendor_id", "is_suspended",
      ],
    ],
  ])("%s carries the columns the group flow reads", async (table, expected) => {
    const names = (await columnsOf(table)).map((c) => c.column_name);
    for (const name of expected) expect(names).toContain(name);
  });

  test.each([
    "uq_arc_hotel_mapping",
    "uq_arc_item_hotel_qty",
    "uq_arc_invitation_hotel",
    "uq_arc_award_hotel",
    "uq_arc_contract_line_hotel",
  ])("unique constraint %s prevents a hotel appearing twice", async (name) => {
    const rows = await db.any(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    expect(rows).toHaveLength(1);
  });

  test("deleting an ARC removes its hotel coverage", async () => {
    const hotel = await db.one(`SELECT id, hospitality_company_id FROM tbl_hospitality_company_hotels WHERE id = 10101`);
    const user = 80011;
    const arc = await db.one(
      `INSERT INTO tbl_arc (arc_number, title, category_id, hospitality_company_id, hotel_id,
                            department_id, created_by, is_group)
       VALUES ('ARC-SCHEMA-TEST-0001', 'schema cascade', 215, $1, $2, 10201, $3, true)
       RETURNING id`,
      [hotel.hospitality_company_id, hotel.id, user]
    );
    await db.none(
      `INSERT INTO tbl_arc_hotel_mappings (arc_id, hotel_id, created_by) VALUES ($1, 10101, $2), ($1, 10102, $2)`,
      [arc.id, user]
    );
    await db.none(`DELETE FROM tbl_arc WHERE id = $1`, [arc.id]);
    const left = await db.any(`SELECT 1 FROM tbl_arc_hotel_mappings WHERE arc_id = $1`, [arc.id]);
    expect(left).toHaveLength(0);
  });
});
