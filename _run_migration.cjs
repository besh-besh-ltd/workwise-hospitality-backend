const pgp = require('pg-promise')();
const db = pgp({
  host: 'hospitality-db.c1wyigeggze3.ap-south-1.rds.amazonaws.com',
  port: 5432,
  database: 'hospitality_main',
  user: 'postgres',
  password: 'Workwise-1234',
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    console.log('=== Running migration: 001_add_approve_permissions ===\n');

    await db.tx(async t => {
      // 1. Insert MISSING approve permissions (tender.approve, arc.approve)
      console.log('1. Inserting missing approve permissions...');
      await t.none(`INSERT INTO tbl_permissions (resource, action) VALUES ('tender', 'approve')`);
      await t.none(`INSERT INTO tbl_permissions (resource, action) VALUES ('arc', 'approve')`);

      const allApprovePerms = await t.any(`SELECT id, resource, action FROM tbl_permissions WHERE action = 'approve' ORDER BY id`);
      console.log(`   All approve permissions now (${allApprovePerms.length}):`);
      allApprovePerms.forEach(p => console.log(`     [${p.id}] ${p.resource}.${p.action}`));

      // 2. Assign missing approve permissions to roles
      console.log('\n2. Assigning missing approve permissions to roles...');

      // CEO (1) → add tender, arc
      const ceoResult = await t.result(`
        INSERT INTO tbl_role_permissions (role_id, permission_id)
        SELECT 1, p.id FROM tbl_permissions p WHERE p.resource IN ('tender', 'arc') AND p.action = 'approve'
      `);
      console.log(`   CEO (1): +${ceoResult.rowCount} (tender, arc)`);

      // Tender Approver (4) → add tender
      const ta4Result = await t.result(`
        INSERT INTO tbl_role_permissions (role_id, permission_id)
        SELECT 4, p.id FROM tbl_permissions p WHERE p.resource = 'tender' AND p.action = 'approve'
      `);
      console.log(`   Tender Approver (4): +${ta4Result.rowCount} (tender)`);

      // Proxy Approver (5) → add tender
      const pa5Result = await t.result(`
        INSERT INTO tbl_role_permissions (role_id, permission_id)
        SELECT 5, p.id FROM tbl_permissions p WHERE p.resource = 'tender' AND p.action = 'approve'
      `);
      console.log(`   Proxy Approver (5): +${pa5Result.rowCount} (tender)`);

      // N1 (8) → add negotiation, quote-compare
      const n1Result = await t.result(`
        INSERT INTO tbl_role_permissions (role_id, permission_id)
        SELECT 8, p.id FROM tbl_permissions p WHERE p.resource IN ('negotiation', 'quote-compare') AND p.action = 'approve'
      `);
      console.log(`   N1 (8): +${n1Result.rowCount} (negotiation, quote-compare)`);

      // Commercial Approver (12) → add quote-compare
      const ca12Result = await t.result(`
        INSERT INTO tbl_role_permissions (role_id, permission_id)
        SELECT 12, p.id FROM tbl_permissions p WHERE p.resource = 'quote-compare' AND p.action = 'approve'
      `);
      console.log(`   Commercial Approver (12): +${ca12Result.rowCount} (quote-compare)`);

      // ARC Approver (16) → add arc
      const arc16Result = await t.result(`
        INSERT INTO tbl_role_permissions (role_id, permission_id)
        SELECT 16, p.id FROM tbl_permissions p WHERE p.resource = 'arc' AND p.action = 'approve'
      `);
      console.log(`   ARC Approver (16): +${arc16Result.rowCount} (arc)`);

      // Verify: all roles with approve perms
      console.log('\n   --- Verification: all role approve permissions ---');
      const allRoleApproves = await t.any(`
        SELECT r.id as role_id, r.title, p.resource, p.action
        FROM tbl_role_permissions rp
        JOIN tbl_roles r ON rp.role_id = r.id
        JOIN tbl_permissions p ON rp.permission_id = p.id
        WHERE p.action = 'approve'
        ORDER BY r.id, p.resource
      `);
      allRoleApproves.forEach(r => console.log(`     Role ${r.role_id} (${r.title}): ${r.resource}.${r.action}`));

      // 3. Clone N1 → N2 user role scopes
      console.log('\n3. Cloning N1 (role 8) user scopes to N2 (role 9)...');
      const n1Scopes = await t.any(`SELECT * FROM tbl_user_role_scopes WHERE role_id = 8`);
      console.log(`   Found ${n1Scopes.length} N1 scope entries`);

      let cloneCount = 0;
      for (const s of n1Scopes) {
        // Check if this exact scope already exists for N2
        const exists = await t.oneOrNone(`
          SELECT 1 FROM tbl_user_role_scopes
          WHERE user_id = $1 AND role_id = 9 AND company_id = $2
            AND (($3::int IS NULL AND hotel_id IS NULL) OR hotel_id = $3)
            AND (($4::int IS NULL AND department_id IS NULL) OR department_id = $4)
        `, [s.user_id, s.company_id, s.hotel_id, s.department_id]);

        if (!exists) {
          await t.none(`
            INSERT INTO tbl_user_role_scopes (user_id, role_id, company_id, hotel_id, department_id)
            VALUES ($1, 9, $2, $3, $4)
          `, [s.user_id, s.company_id, s.hotel_id, s.department_id]);
          cloneCount++;
        }
      }
      console.log(`   Cloned ${cloneCount} new N2 scope entries`);

      const n2Count = await t.one(`SELECT count(*) FROM tbl_user_role_scopes WHERE role_id = 9`);
      console.log(`   Total N2 scope entries: ${n2Count.count}`);

      // 4. Fix instance 10
      console.log('\n4. Fixing instance 10...');
      const inst10 = await t.oneOrNone(`SELECT id, status, current_step FROM tbl_approval_instances WHERE id = 10`);
      if (!inst10) {
        console.log('   Instance 10 not found — skipping');
      } else {
        console.log(`   Current state: status=${inst10.status}, current_step=${inst10.current_step}`);

        const steps10 = await t.any(`
          SELECT s.id, s.step_order, s.status,
            (SELECT array_agg(sa.approver_user_id) FROM tbl_approval_step_approvers sa WHERE sa.approval_instance_step_id = s.id) as approvers
          FROM tbl_approval_instance_steps s
          WHERE s.approval_instance_id = 10
          ORDER BY s.step_order
        `);
        console.log(`   Steps before fix:`);
        steps10.forEach(s => console.log(`     step_order=${s.step_order}, status=${s.status}, approvers=${JSON.stringify(s.approvers)}`));

        if (steps10.length > 1 && steps10[0].step_order === 1) {
          const step1Id = steps10[0].id;

          const delApprovers = await t.result(`DELETE FROM tbl_approval_step_approvers WHERE approval_instance_step_id = $1`, [step1Id]);
          console.log(`   Deleted ${delApprovers.rowCount} step 1 approvers`);

          const delActions = await t.result(`DELETE FROM tbl_approval_actions WHERE approval_instance_id = 10 AND approval_instance_step_id = $1`, [step1Id]);
          console.log(`   Deleted ${delActions.rowCount} step 1 actions`);

          await t.none(`DELETE FROM tbl_approval_instance_steps WHERE id = $1`, [step1Id]);
          console.log('   Deleted step 1');

          await t.none(`UPDATE tbl_approval_instance_steps SET step_order = step_order - 1 WHERE approval_instance_id = 10`);
          console.log('   Renumbered remaining steps');

          await t.none(`UPDATE tbl_approval_instances SET current_step = 1 WHERE id = 10`);
          console.log('   Updated current_step to 1');
        } else {
          console.log('   Instance 10 does not need step-1 removal (only 1 step or already fixed)');
        }

        // Final state
        const finalSteps = await t.any(`
          SELECT s.id, s.step_order, s.status,
            (SELECT array_agg(sa.approver_user_id) FROM tbl_approval_step_approvers sa WHERE sa.approval_instance_step_id = s.id) as approvers
          FROM tbl_approval_instance_steps s
          WHERE s.approval_instance_id = 10
          ORDER BY s.step_order
        `);
        const finalInst = await t.one(`SELECT current_step, status FROM tbl_approval_instances WHERE id = 10`);
        console.log(`   Final instance state: status=${finalInst.status}, current_step=${finalInst.current_step}`);
        console.log(`   Final steps:`);
        finalSteps.forEach(s => console.log(`     step_order=${s.step_order}, status=${s.status}, approvers=${JSON.stringify(s.approvers)}`));
      }
    });

    console.log('\n=== Migration completed successfully ===');
  } catch (err) {
    console.error('\nMigration FAILED (transaction rolled back):', err.message);
    console.error(err.stack);
  } finally {
    pgp.end();
  }
})();
