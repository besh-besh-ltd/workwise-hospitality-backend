import { db, closeDb } from "../setup/db.js";

const perms = (roleTitle) => db.map(
  `SELECT p.resource::text || '.' || p.action::text AS k
     FROM tbl_role_permissions rp JOIN tbl_permissions p ON p.id = rp.permission_id
     JOIN tbl_roles r ON r.id = rp.role_id
    WHERE r.title = $1 AND r.created_by IS NULL AND p.resource::text = 'pr' ORDER BY 1`, [roleTitle], r => r.k);

// Release this file's test-side pool (see the other PR suites' afterAll).
afterAll(() => closeDb());

describe("PR schema", () => {
  it("seeds pr.* permissions and the four system roles", async () => {
    expect(await perms("PR Requester")).toEqual(["pr.create", "pr.read"]);
    expect(await perms("PR Technical Reviewer")).toEqual(["pr.evaluate", "pr.read"]);
    expect(await perms("PR Approver")).toEqual(["pr.approve", "pr.read"]);
    expect(await perms("PR Buyer")).toEqual(["pr.convert", "pr.read"]);
    const admin = await perms("Company Administrator");
    expect(admin).toEqual(["pr.approve", "pr.convert", "pr.create", "pr.evaluate", "pr.read"]);
  });

  it("creates every PR table", async () => {
    const names = await db.map(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'
      AND table_name = ANY($1)`, [[
      "tbl_purchase_requisition","tbl_purchase_requisition_line","tbl_pr_line_clause","tbl_pr_attachment",
      "tbl_pr_review_category_map","tbl_pr_review","tbl_pr_review_line","tbl_pr_line_rfq",
      "tbl_pr_catalog_request","tbl_pr_comment","tbl_pr_event"]], r => r.table_name);
    expect(names.sort()).toHaveLength(11);
  });

  it("adds a nullable min_amount to policy steps", async () => {
    const c = await db.one(`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name='tbl_approval_policy_steps' AND column_name='min_amount'`);
    expect(c).toEqual({ data_type: "numeric", is_nullable: "YES" });
  });

  describe("line CHECKs", () => {
    // Real catalog ids, resolved once, so the CHECK under test is the only possible failure.
    let categoryId, variantId;
    beforeAll(async () => {
      categoryId = (await db.one(`SELECT id FROM tbl_category WHERE is_deleted=0 ORDER BY id LIMIT 1`)).id;
      variantId = (await db.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`)).id;
    });

    const insertLine = (patch) => db.tx(async t => {
      const pr = await t.one(`INSERT INTO tbl_purchase_requisition
        (pr_number,title,pr_type,hospitality_company_id,hotel_id,department_id,urgency,required_by_date,justification,status,raised_by)
        VALUES ('PR-T-CHK','t','goods',10001,10101,10201,'normal',CURRENT_DATE+7,'j','draft',80011) RETURNING id`);
      const row = { line_kind: "catalog", product_variant_id: variantId, free_text_name: null,
                    quantity: 1, estimated_unit_price: 1, ...patch };
      await t.none(`INSERT INTO tbl_purchase_requisition_line
        (pr_id,line_no,line_kind,product_variant_id,free_text_name,category_id,quantity,uom,estimated_unit_price)
        VALUES ($1,1,$2,$3,$4,$5,$6,'nos',$7)`,
        [pr.id, row.line_kind, row.product_variant_id, row.free_text_name, categoryId, row.quantity, row.estimated_unit_price]);
      throw new Error("ROLLBACK_SENTINEL");
    });

    it("control: a valid catalog line passes every CHECK (only the sentinel fails)", async () => {
      await expect(insertLine({})).rejects.toThrow(/ROLLBACK_SENTINEL/);
    });

    it("control: a valid free-text line passes every CHECK", async () => {
      await expect(insertLine({ line_kind: "free_text", product_variant_id: null, free_text_name: "Cable" }))
        .rejects.toThrow(/ROLLBACK_SENTINEL/);
    });

    const cases = [
      ["catalog line without variant", { line_kind: "catalog", product_variant_id: null, free_text_name: null }],
      ["free-text line without name", { line_kind: "free_text", product_variant_id: null, free_text_name: null }],
      ["zero quantity", { quantity: 0 }],
      ["zero price", { estimated_unit_price: 0 }],
    ];
    it.each(cases)("rejects %s", async (_n, patch) => {
      await expect(insertLine(patch)).rejects.toThrow(/violates check constraint/);
    });
  });

  describe("indexes and resolved_by FK (20261014110000)", () => {
    // Every FK column that a parent delete or a per-PR / per-line read scans.
    // tbl_pr_review_line's PK leads with review_id, so pr_line_id needs its own;
    // uq_pr_catreq_open_per_line is partial (status = 'open'), so it does not
    // serve the line's whole request history or the ON DELETE CASCADE scan.
    it.each([
      ["idx_pr_attachment_pr", "tbl_pr_attachment", "(pr_id)"],
      ["idx_pr_attachment_line", "tbl_pr_attachment", "(pr_line_id)"],
      ["idx_pr_line_clause_line", "tbl_pr_line_clause", "(pr_line_id)"],
      ["idx_pr_line_rfq_product", "tbl_pr_line_rfq", "(rfq_product_id)"],
      ["idx_pr_review_line_line", "tbl_pr_review_line", "(pr_line_id)"],
      ["idx_pr_catreq_line", "tbl_pr_catalog_request", "(pr_line_id)"],
    ])("%s exists on %s %s, non-partial", async (name, table, cols) => {
      const row = await db.oneOrNone(
        `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
      expect(row).not.toBeNull();
      expect(row.tablename).toBe(table);
      expect(row.indexdef).toContain(`USING btree ${cols}`);
      expect(row.indexdef).not.toMatch(/WHERE/i);
    });

    it("tbl_pr_catalog_request.resolved_by references tbl_users(id) ON DELETE SET NULL", async () => {
      const fk = await db.oneOrNone(
        `SELECT c.confrelid::regclass::text AS parent, c.confdeltype, a.attname
           FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
          WHERE c.conname = 'fk_pr_catreq_resolved_by' AND c.conrelid = 'public.tbl_pr_catalog_request'::regclass
            AND c.contype = 'f'`);
      expect(fk).toEqual({ parent: "tbl_users", confdeltype: "n", attname: "resolved_by" });
    });
  });

  describe("clause_type (20261014100000)", () => {
    // A clause on a real line, rolled back; `type` undefined = the column default.
    const insertClause = (type) => db.tx(async t => {
      const variantId = (await t.one(`SELECT id FROM tbl_product_variant ORDER BY id LIMIT 1`)).id;
      const categoryId = (await t.one(`SELECT id FROM tbl_category WHERE is_deleted=0 ORDER BY id LIMIT 1`)).id;
      const pr = await t.one(`INSERT INTO tbl_purchase_requisition
        (pr_number,title,pr_type,hospitality_company_id,hotel_id,department_id,urgency,required_by_date,justification,status,raised_by)
        VALUES ('PR-T-CLS','t','goods',10001,10101,10201,'normal',CURRENT_DATE+7,'j','draft',80011) RETURNING id`);
      const line = await t.one(`INSERT INTO tbl_purchase_requisition_line
        (pr_id,line_no,line_kind,product_variant_id,category_id,quantity,uom,estimated_unit_price)
        VALUES ($1,1,'catalog',$2,$3,1,'nos',1) RETURNING id`, [pr.id, variantId, categoryId]);
      const row = type === undefined
        ? await t.one(`INSERT INTO tbl_pr_line_clause (pr_line_id, clause_text, added_by) VALUES ($1, 'IP65', 80011)
                       RETURNING clause_type`, [line.id])
        : await t.one(`INSERT INTO tbl_pr_line_clause (pr_line_id, clause_text, clause_type, added_by) VALUES ($1, 'IP65', $2, 80011)
                       RETURNING clause_type`, [line.id, type]);
      throw Object.assign(new Error("ROLLBACK_SENTINEL"), { row });
    });

    it("defaults to 'clause' — the RFQ add-clause default, never the unused 'mandatory'", async () => {
      await expect(insertClause(undefined)).rejects.toMatchObject({ message: "ROLLBACK_SENTINEL", row: { clause_type: "clause" } });
    });

    it.each(["clause", "sampling"])("accepts '%s'", async (type) => {
      await expect(insertClause(type)).rejects.toMatchObject({ message: "ROLLBACK_SENTINEL", row: { clause_type: type } });
    });

    it.each(["mandatory", "Clause", ""])("rejects '%s'", async (type) => {
      await expect(insertClause(type)).rejects.toThrow(/violates check constraint "chk_pr_line_clause_type"/);
    });
  });
});
