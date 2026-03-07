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
  // 1. Find ALL policy steps that use non-approver roles
  // Non-approver roles: Tender Creator(2), Purchase Input Provider(3), RFQ Observer(17), Report Download(18)
  // Approver roles: Tender Approver(4), Proxy Approver(5), Technical Evaluator(6), Technical Approver(7),
  //                 Commercial Negotiator N1-N4(8-11), Commercial Approver(12), Final Awarding P1-P3(13-15),
  //                 ARC Approver(16), Company CEO(1)

  console.log('=== ALL POLICY STEPS using non-approver roles in approval chains ===');
  const badSteps = await db.any(`
    SELECT s.id as step_id, s.approval_policy_id, s.step_order, s.decision_rule,
           s.approver_source_type, s.approver_source_id,
           r.title as role_title,
           p.entity_type, p.hotel_id, p.department_id, p.is_master,
           h.name as hotel_name, d.title as dept_name
    FROM tbl_approval_policy_steps s
    JOIN tbl_approval_policies p ON s.approval_policy_id = p.id
    LEFT JOIN tbl_roles r ON s.approver_source_type = 'ROLE' AND s.approver_source_id = r.id
    LEFT JOIN tbl_hospitality_company_hotels h ON p.hotel_id = h.id
    LEFT JOIN tbl_department d ON p.department_id = d.id
    WHERE s.approver_source_type = 'ROLE' AND s.approver_source_id IN (2, 3, 17, 18)
    ORDER BY p.entity_type, p.hotel_id, s.step_order
  `);
  console.log('Found', badSteps.length, 'steps with non-approver roles:');
  badSteps.forEach(s => console.log(`  step_id=${s.step_id} | policy=${s.approval_policy_id} | ${s.entity_type} | hotel: ${s.hotel_name} | step ${s.step_order} | role: ${s.role_title}(${s.approver_source_id}) | dept: ${s.dept_name || 'ALL'} | master: ${s.is_master}`));

  // 2. Check TENDER policy 8 steps specifically
  console.log('\n=== TENDER policy 8 steps ===');
  const tenderSteps = await db.any(`
    SELECT s.*, r.title as role_title
    FROM tbl_approval_policy_steps s
    LEFT JOIN tbl_roles r ON s.approver_source_type = 'ROLE' AND s.approver_source_id = r.id
    WHERE s.approval_policy_id = 8
    ORDER BY s.step_order
  `);
  tenderSteps.forEach(s => console.log(`  step_id=${s.id} | step ${s.step_order} | type=${s.approval_type} | decision=${s.decision_rule} | source: ${s.approver_source_type}=${s.role_title || s.approver_source_id}`));

  // 3. Show what the fix would look like
  console.log('\n=== PROPOSED FIX: Delete these steps (Tender Creator in approval chains) ===');
  const stepsToDelete = badSteps.filter(s => s.approver_source_id === 2); // Tender Creator
  stepsToDelete.forEach(s => console.log(`  DELETE step_id=${s.step_id} from policy ${s.approval_policy_id} (${s.entity_type} | ${s.hotel_name})`));

  // 4. Steps that would need renumbering after deletion
  console.log('\n=== Steps needing renumber after deletion ===');
  for (const s of stepsToDelete) {
    const remainingSteps = await db.any(`
      SELECT id, step_order, approver_source_type, approver_source_id
      FROM tbl_approval_policy_steps
      WHERE approval_policy_id = $1 AND id != $2
      ORDER BY step_order
    `, [s.approval_policy_id, s.step_id]);
    remainingSteps.forEach((rs, idx) => {
      if (rs.step_order !== idx + 1) {
        console.log(`  policy ${s.approval_policy_id}: step_id=${rs.id} renumber from ${rs.step_order} to ${idx + 1}`);
      }
    });
  }

  // 5. Check if there are active approval instances using these bad steps
  console.log('\n=== Active approval instances affected ===');
  const activeInstances = await db.any(`
    SELECT ai.id as instance_id, ai.entity_type, ai.entity_id, ai.status,
           ais.id as instance_step_id, ais.step_order, ais.status as step_status,
           asa.approver_user_id, asa.status as approver_status,
           u.name as approver_name, u.employee_code
    FROM tbl_approval_instances ai
    JOIN tbl_approval_instance_steps ais ON ai.id = ais.approval_instance_id
    LEFT JOIN tbl_approval_step_approvers asa ON ais.id = asa.approval_instance_step_id
    LEFT JOIN tbl_users u ON asa.approver_user_id = u.id
    WHERE ai.status = 'PENDING'
    ORDER BY ai.id, ais.step_order
  `);
  console.log('Total active pending approvals:', activeInstances.length, 'step-approver pairs');

  // Group by instance
  const instanceMap = {};
  activeInstances.forEach(ai => {
    if (!instanceMap[ai.instance_id]) instanceMap[ai.instance_id] = [];
    instanceMap[ai.instance_id].push(ai);
  });
  for (const [instId, rows] of Object.entries(instanceMap)) {
    const first = rows[0];
    console.log(`\n  Instance ${instId} (${first.entity_type} entity=${first.entity_id} status=${first.status}):`);
    rows.forEach(r => console.log(`    step ${r.step_order} (${r.step_status}): ${r.approver_name}(${r.employee_code}) = ${r.approver_status}`));
  }

  pgp.end();
})().catch(e => { console.error(e); pgp.end(); });
