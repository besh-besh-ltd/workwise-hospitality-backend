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
  // 1. Get Orchid Pune hotel
  const pune = await db.oneOrNone(`SELECT id, name, hospitality_company_id FROM tbl_hospitality_company_hotels WHERE name ILIKE '%pune%'`);
  console.log('Target hotel:', JSON.stringify(pune));

  // 2. Get all roles
  console.log('\n=== ALL ROLES ===');
  const roles = await db.any(`SELECT id, title, description, created_by FROM tbl_roles ORDER BY id`);
  roles.forEach(r => console.log(`  ${r.id} | ${r.title} | ${r.description || ''} | created_by: ${r.created_by}`));

  // 3. Role scopes for Ankush Mehta (creator who got approval step)
  console.log('\n=== Ankush Mehta (S00005) role scopes ===');
  const ankush = await db.oneOrNone(`SELECT id, name FROM tbl_users WHERE employee_code = 'S00005'`);
  if (ankush) {
    console.log('  user_id:', ankush.id, ankush.name);
    const scopes = await db.any(`
      SELECT rs.*, r.title as role_title, h.name as hotel_name, d.title as dept_name
      FROM tbl_user_role_scopes rs
      LEFT JOIN tbl_roles r ON rs.role_id = r.id
      LEFT JOIN tbl_hospitality_company_hotels h ON rs.hotel_id = h.id
      LEFT JOIN tbl_department d ON rs.department_id = d.id
      WHERE rs.user_id = $1 ORDER BY rs.hotel_id
    `, [ankush.id]);
    scopes.forEach(s => console.log(`  role: ${s.role_title}(${s.role_id}) | hotel: ${s.hotel_name}(${s.hotel_id}) | dept: ${s.dept_name}(${s.department_id}) | company: ${s.company_id}`));
  }

  // 4. Role scopes for Shashikant Jadhav
  console.log('\n=== Shashikant Jadhav (SR0001) role scopes ===');
  const shashi = await db.oneOrNone(`SELECT id, name FROM tbl_users WHERE employee_code = 'SR0001'`);
  if (shashi) {
    console.log('  user_id:', shashi.id, shashi.name);
    const scopes = await db.any(`
      SELECT rs.*, r.title as role_title, h.name as hotel_name, d.title as dept_name
      FROM tbl_user_role_scopes rs
      LEFT JOIN tbl_roles r ON rs.role_id = r.id
      LEFT JOIN tbl_hospitality_company_hotels h ON rs.hotel_id = h.id
      LEFT JOIN tbl_department d ON rs.department_id = d.id
      WHERE rs.user_id = $1 ORDER BY rs.hotel_id
    `, [shashi.id]);
    scopes.forEach(s => console.log(`  role: ${s.role_title}(${s.role_id}) | hotel: ${s.hotel_name}(${s.hotel_id}) | dept: ${s.dept_name}(${s.department_id}) | company: ${s.company_id}`));
  }

  // 5. Get ALL approval policies across ALL hotels/companies
  console.log('\n=== ALL APPROVAL POLICIES ===');
  const policies = await db.any(`
    SELECT p.*, h.name as hotel_name, d.title as dept_name, c.name as company_name
    FROM tbl_approval_policies p
    LEFT JOIN tbl_hospitality_company_hotels h ON p.hotel_id = h.id
    LEFT JOIN tbl_department d ON p.department_id = d.id
    LEFT JOIN tbl_hospitality_companies c ON p.hospitality_company_id = c.id
    ORDER BY p.entity_type, p.hotel_id, p.department_id
  `);
  policies.forEach(p => console.log(`  policy ${p.id} | entity: ${p.entity_type} | process: ${p.process_id} | company: ${p.company_name}(${p.hospitality_company_id}) | hotel: ${p.hotel_name}(${p.hotel_id}) | dept: ${p.dept_name}(${p.department_id}) | is_master: ${p.is_master} | active: ${p.is_active}`));

  // 6. Get policy steps with approver details
  console.log('\n=== POLICY STEPS & APPROVERS ===');
  for (const policy of policies) {
    const steps = await db.any(`
      SELECT s.*
      FROM tbl_approval_policy_steps s
      WHERE s.approval_policy_id = $1
      ORDER BY s.step_order
    `, [policy.id]);
    if (steps.length > 0) {
      console.log(`\n  Policy ${policy.id} (${policy.entity_type} | hotel: ${policy.hotel_name} | dept: ${policy.dept_name} | master: ${policy.is_master}):`);
      for (const step of steps) {
        console.log(`    Step ${step.step_order}: type=${step.approval_type} | decision=${step.decision_rule} | source_type=${step.approver_source_type} | source_id=${step.approver_source_id}`);
        // If source is USER, get user details
        if (step.approver_source_type === 'USER') {
          const user = await db.oneOrNone(`SELECT id, name, email, employee_code, designation FROM tbl_users WHERE id = $1`, [step.approver_source_id]);
          if (user) console.log(`      -> USER: ${user.name} (${user.email}, emp: ${user.employee_code}, ${user.designation})`);
        } else if (step.approver_source_type === 'ROLE') {
          const role = await db.oneOrNone(`SELECT id, title FROM tbl_roles WHERE id = $1`, [step.approver_source_id]);
          if (role) console.log(`      -> ROLE: ${role.title} (id: ${role.id})`);
        }
      }
    }
  }

  // 7. Check approval instances for a recent tender involving Ankush Mehta
  console.log('\n=== RECENT APPROVAL INSTANCES with Ankush Mehta as approver ===');
  if (ankush) {
    const instances = await db.any(`
      SELECT column_name FROM information_schema.columns WHERE table_name='tbl_approval_instances' ORDER BY ordinal_position
    `);
    console.log('tbl_approval_instances columns:', instances.map(c => c.column_name).join(', '));

    const instCols = await db.any(`SELECT column_name FROM information_schema.columns WHERE table_name='tbl_approval_instance_steps' ORDER BY ordinal_position`);
    console.log('tbl_approval_instance_steps columns:', instCols.map(c => c.column_name).join(', '));
  }

  // 8. Permissions per role
  console.log('\n=== ROLE PERMISSIONS ===');
  const rpCols = await db.any(`SELECT column_name FROM information_schema.columns WHERE table_name='tbl_role_permissions' ORDER BY ordinal_position`);
  console.log('tbl_role_permissions columns:', rpCols.map(c => c.column_name).join(', '));

  for (const role of roles) {
    const perms = await db.any(`
      SELECT p.resource, p.action
      FROM tbl_role_permissions rp
      JOIN tbl_permissions p ON rp.permission_id = p.id
      WHERE rp.role_id = $1
      ORDER BY p.resource, p.action
    `, [role.id]);
    if (perms.length > 0) {
      console.log(`\n  Role: ${role.title} (id: ${role.id})`);
      perms.forEach(p => console.log(`    ${p.resource}.${p.action}`));
    }
  }

  pgp.end();
})().catch(e => { console.error(e); pgp.end(); });
