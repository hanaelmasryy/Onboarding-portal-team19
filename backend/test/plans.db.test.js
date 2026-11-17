// Plan endpoint tests against a real database (issues #17, #18).
// Runs only when DATABASE_URL is set (backend/.env, DEV branch).
// Cleans up: deletes the plans and templates it creates and deactivates its users.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

try {
  process.loadEnvFile(`${__dirname}/../.env`);
} catch {
  // no .env file
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-signing';
}
const SKIP = process.env.DATABASE_URL ? false : 'DATABASE_URL not set; database tests skipped';

const request = require('supertest');

let app;
let pool;
let signToken;
const run = crypto.randomBytes(4).toString('hex');
const tokens = {};
const ids = {};
const userEmails = [];
const templateIds = [];
const planIds = [];

const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const isoDay = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const START = isoDay(14);

const TEMPLATE = {
  title: `Plan test template ${run}`,
  tasks: [
    { title: 'Kick-off call', offsetDays: 0, visibility: 'customer', actor: 'staff' },
    { title: 'Upload company documents', offsetDays: 3, visibility: 'customer', actor: 'customer' },
    { title: 'Internal credit check', offsetDays: 5, visibility: 'internal', actor: 'staff' },
  ],
};

async function makeUser(key, role, active = true) {
  const email = `test-plan-${key.toLowerCase()}-${run}@example.test`;
  const { rows } = await pool.db().query(
    `INSERT INTO users (name, email, password_hash, role, active)
     VALUES ($1, $2, 'not-a-real-hash', $3, $4) RETURNING id`,
    [`Test ${key} ${run}`, email, role, active]
  );
  userEmails.push(email);
  ids[key] = rows[0].id;
  tokens[key] = signToken(rows[0].id);
}

async function makeTemplate(body = TEMPLATE) {
  const res = await request(app).post('/api/templates').set(as('Admin')).send(body);
  assert.strictEqual(res.status, 201);
  templateIds.push(res.body.id);
  return res.body;
}

async function createPlan(body) {
  const res = await request(app).post('/api/plans').set(as('Admin')).send(body);
  if (res.status === 201) planIds.push(res.body.plan.id);
  return res;
}

let template;
let plan; // plan for Customer, staff tasks owned by Staff

before(async () => {
  if (SKIP) return;
  app = require('../src/app');
  pool = require('../src/db/pool');
  ({ signToken } = require('../src/lib/tokens'));
  await makeUser('Admin', 'Admin');
  await makeUser('Staff', 'Staff');
  await makeUser('Customer', 'Customer');
  await makeUser('Customer2', 'Customer');
  await makeUser('Inactive', 'Customer', false);

  template = await makeTemplate();
  const res = await createPlan({ templateId: template.id, customerId: ids.Customer, startDate: START, staffOwnerId: ids.Staff });
  assert.strictEqual(res.status, 201);
  plan = res.body;
});

after(async () => {
  if (SKIP) return;
  await pool.db().query('DELETE FROM onboarding_plans WHERE id = ANY($1)', [planIds]);
  await pool.db().query('DELETE FROM templates WHERE id = ANY($1)', [templateIds]);
  await pool.db().query('UPDATE users SET active = false WHERE email = ANY($1)', [userEmails]);
  await pool.db().end();
});

// ---- P1 create ---------------------------------------------------------------
test('Admin creates a plan: tasks copied with due dates and owners', { skip: SKIP }, async () => {
  assert.strictEqual(plan.plan.status, 'Active');
  assert.strictEqual(plan.plan.startDate, START);
  assert.strictEqual(plan.plan.template.version, template.version);
  assert.deepStrictEqual(plan.plan.progress, { done: 0, total: 3 });
  assert.deepStrictEqual(
    plan.tasks.map((t) => [t.position, t.title, t.dueDate, t.assignee.id, t.visibility, t.status]),
    [
      [1, 'Kick-off call', isoDay(14), ids.Staff, 'customer', 'Not Started'],
      [2, 'Upload company documents', isoDay(17), ids.Customer, 'customer', 'Not Started'],
      [3, 'Internal credit check', isoDay(19), ids.Staff, 'internal', 'Not Started'],
    ]
  );
});

test('default title and default staff owner (the Admin)', { skip: SKIP }, async () => {
  const res = await createPlan({ templateId: template.id, customerId: ids.Customer2, startDate: START });
  assert.strictEqual(res.status, 201);
  assert.ok(res.body.plan.title.startsWith(TEMPLATE.title));
  const staffTasks = res.body.tasks.filter((t) => t.actor === 'staff');
  assert.ok(staffTasks.every((t) => t.assignee.id === ids.Admin));
});

test('each assignee gets one in-app "assigned" notification', { skip: SKIP }, async () => {
  const { rows } = await pool.db().query(
    `SELECT user_id FROM notifications WHERE plan_id = $1 AND type = 'assigned' AND channel = 'in_app' ORDER BY user_id`,
    [plan.plan.id]
  );
  assert.deepStrictEqual(rows.map((r) => r.user_id).sort(), [ids.Staff, ids.Customer].sort());
});

test('only Admin can create plans (401 / 403)', { skip: SKIP }, async () => {
  const body = { templateId: template.id, customerId: ids.Customer, startDate: START };
  assert.strictEqual((await request(app).post('/api/plans').send(body)).status, 401);
  assert.strictEqual((await request(app).post('/api/plans').set(as('Staff')).send(body)).status, 403);
  assert.strictEqual((await request(app).post('/api/plans').set(as('Customer')).send(body)).status, 403);
});

test('bad input -> 400 and nothing is saved', { skip: SKIP }, async () => {
  const before = await pool.db().query('SELECT COUNT(*)::int AS n FROM onboarding_plans');
  const base = { templateId: template.id, customerId: ids.Customer, startDate: START };
  const cases = [
    { ...base, startDate: '2026-02-30' },
    { ...base, customerId: ids.Staff }, // not a customer
    { ...base, customerId: ids.Inactive }, // deactivated customer
    { ...base, staffOwnerId: ids.Customer }, // owner must be staff side
    { ...base, templateId: 'abc' },
  ];
  for (const body of cases) {
    const res = await createPlan(body);
    assert.strictEqual(res.status, 400, JSON.stringify(body));
  }
  const after = await pool.db().query('SELECT COUNT(*)::int AS n FROM onboarding_plans');
  assert.strictEqual(after.rows[0].n, before.rows[0].n);
});

test('unknown template -> 404; archived template -> 409', { skip: SKIP }, async () => {
  const base = { customerId: ids.Customer, startDate: START };
  assert.strictEqual((await createPlan({ ...base, templateId: 2147483000 })).status, 404);
  const old = await makeTemplate({ ...TEMPLATE, title: `Archived ${run}` });
  await request(app).patch(`/api/templates/${old.id}/archive`).set(as('Admin'));
  const res = await createPlan({ ...base, templateId: old.id });
  assert.strictEqual(res.status, 409);
});

test('running plans keep their copy when the template is edited', { skip: SKIP }, async () => {
  const tpl = await makeTemplate({ ...TEMPLATE, title: `Snapshot ${run}` });
  const created = await createPlan({ templateId: tpl.id, customerId: ids.Customer, startDate: START });
  await request(app)
    .put(`/api/templates/${tpl.id}`)
    .set(as('Admin'))
    .send({ ...TEMPLATE, tasks: [{ title: 'Changed', offsetDays: 30, visibility: 'customer', actor: 'staff' }] });

  const res = await request(app).get(`/api/plans/${created.body.plan.id}`).set(as('Staff'));
  assert.strictEqual(res.body.plan.template.version, 1);
  assert.deepStrictEqual(res.body.tasks.map((t) => t.title), TEMPLATE.tasks.map((t) => t.title));
});

// ---- P2 list -------------------------------------------------------------------
test('Staff list all plans with filters and pagination', { skip: SKIP }, async () => {
  const res = await request(app).get(`/api/plans?customerId=${ids.Customer}&search=${encodeURIComponent(run)}`).set(as('Staff'));
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.items.some((p) => p.id === plan.plan.id));
  assert.ok(res.body.items.every((p) => p.customer.id === ids.Customer));

  const page = await request(app).get('/api/plans?limit=1').set(as('Staff'));
  assert.strictEqual(page.body.items.length, 1);
  assert.ok(page.body.total >= 2);

  assert.strictEqual((await request(app).get('/api/plans?status=done').set(as('Staff'))).status, 400);
});

test('Customer lists only their own plans, even with a customerId filter', { skip: SKIP }, async () => {
  const res = await request(app).get(`/api/plans?customerId=${ids.Customer2}`).set(as('Customer'));
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.items.length >= 1);
  assert.ok(res.body.items.every((p) => p.customer.id === ids.Customer));
  const mine = res.body.items.find((p) => p.id === plan.plan.id);
  assert.deepStrictEqual(mine.progress, { done: 0, total: 2 }); // internal task not counted
});

// ---- P3 / T1 view --------------------------------------------------------------
test('Customer sees their plan without internal tasks', { skip: SKIP }, async () => {
  const res = await request(app).get(`/api/plans/${plan.plan.id}`).set(as('Customer'));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.tasks.map((t) => t.title), ['Kick-off call', 'Upload company documents']);
  assert.ok(!JSON.stringify(res.body).includes('Internal credit check'));
  assert.strictEqual(res.body.plan.cancelReason, null);
});

test("another customer's plan -> 404 (not 403)", { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).get(`/api/plans/${plan.plan.id}`).set(as('Customer2'))).status, 404);
  assert.strictEqual((await request(app).get(`/api/plans/${plan.plan.id}/tasks`).set(as('Customer2'))).status, 404);
});

test('Staff see every task; unknown or malformed id -> 404', { skip: SKIP }, async () => {
  const res = await request(app).get(`/api/plans/${plan.plan.id}`).set(as('Staff'));
  assert.strictEqual(res.body.tasks.length, 3);
  assert.strictEqual((await request(app).get('/api/plans/abc').set(as('Staff'))).status, 404);
  assert.strictEqual((await request(app).get('/api/plans/2147483000').set(as('Staff'))).status, 404);
});

test('task filters: assignee, status, overdue', { skip: SKIP }, async () => {
  const mine = await request(app).get(`/api/plans/${plan.plan.id}/tasks?assigneeId=${ids.Staff}`).set(as('Staff'));
  assert.deepStrictEqual(mine.body.items.map((t) => t.position), [1, 3]);

  const done = await request(app).get(`/api/plans/${plan.plan.id}/tasks?status=Done`).set(as('Staff'));
  assert.strictEqual(done.body.items.length, 0);

  // A plan that started 10 days ago has overdue tasks.
  const late = await createPlan({ templateId: template.id, customerId: ids.Customer, startDate: isoDay(-10) });
  const overdue = await request(app).get(`/api/plans/${late.body.plan.id}/tasks?overdue=true`).set(as('Staff'));
  assert.strictEqual(overdue.body.items.length, 3);
  assert.ok(overdue.body.items.every((t) => t.overdue));

  // Customers: assigneeId is ignored and internal tasks stay hidden.
  const cust = await request(app).get(`/api/plans/${plan.plan.id}/tasks?assigneeId=${ids.Staff}`).set(as('Customer'));
  assert.deepStrictEqual(cust.body.items.map((t) => t.visibility), ['customer', 'customer']);
});

test('plan creation is written to the audit log', { skip: SKIP }, async () => {
  const { rows } = await pool.db().query(
    `SELECT action, actor_id FROM audit_log WHERE entity = 'plan' AND entity_id = $1`,
    [String(plan.plan.id)]
  );
  assert.deepStrictEqual(rows, [{ action: 'plan_create', actor_id: ids.Admin }]);
});
