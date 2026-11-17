// Admin user-account endpoint tests against a real database (issue #6).
// Runs only when DATABASE_URL is set (backend/.env, DEV branch).
// Every user it creates has an email ending in @example.test and is
// deactivated at the end (users are never deleted).

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
const PASSWORD = `Pw-${crypto.randomBytes(8).toString('hex')}`;
const ids = {};
const tokens = {};
const emails = [];

const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
const email = (label) => `test-usr-${label}-${run}@example.test`;

async function insertUser(label, role) {
  const { rows } = await pool.db().query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'not-a-real-hash', $3) RETURNING id`,
    [`Test ${label}`, email(label), role]
  );
  emails.push(email(label));
  ids[label] = rows[0].id;
  tokens[label] = signToken(rows[0].id);
}

async function createUser(label, role = 'Customer') {
  const res = await request(app).post('/api/users').set(as('admin')).send({
    name: `Created ${label}`,
    email: email(label),
    password: PASSWORD,
    role,
  });
  if (res.status === 201) emails.push(email(label));
  return res;
}

before(async () => {
  if (SKIP) return;
  app = require('../src/app');
  pool = require('../src/db/pool');
  ({ signToken } = require('../src/lib/tokens'));
  await insertUser('admin', 'Admin');
  await insertUser('staff', 'Staff');
  await insertUser('customer', 'Customer');
});

after(async () => {
  if (SKIP) return;
  await pool.db().query('DELETE FROM login_attempts WHERE email = ANY($1)', [emails]);
  await pool.db().query('UPDATE users SET active = false WHERE email = ANY($1)', [emails]);
  await pool.db().end();
});

test('Admin creates a user -> 201; password is hashed and never returned', { skip: SKIP }, async () => {
  const res = await createUser('new', 'Staff');
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.email, email('new'));
  assert.strictEqual(res.body.role, 'Staff');
  assert.strictEqual(res.body.active, true);
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes('password'));

  const { rows } = await pool.db().query('SELECT password_hash FROM users WHERE id = $1', [res.body.id]);
  assert.ok(rows[0].password_hash.startsWith('$2'));
  assert.notStrictEqual(rows[0].password_hash, PASSWORD);
});

test('the new user can log in with the password the Admin set', { skip: SKIP }, async () => {
  await createUser('login', 'Customer');
  const res = await request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', '203.0.113.60')
    .send({ email: email('login'), password: PASSWORD });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.user.role, 'Customer');
});

test('same email twice (any letter case) -> 409', { skip: SKIP }, async () => {
  await createUser('dup');
  const res = await request(app).post('/api/users').set(as('admin')).send({
    name: 'Dup', email: email('dup').toUpperCase(), password: PASSWORD, role: 'Customer',
  });
  assert.strictEqual(res.status, 409);
});

test('bad input -> 400; client cannot set password_hash or active', { skip: SKIP }, async () => {
  const short = await request(app).post('/api/users').set(as('admin')).send({
    name: 'X', email: email('short'), password: 'short', role: 'Staff',
  });
  assert.strictEqual(short.status, 400);

  const sneaky = await request(app).post('/api/users').set(as('admin')).send({
    name: 'Sneaky', email: email('sneaky'), password: PASSWORD, role: 'Staff',
    password_hash: 'x', active: false,
  });
  assert.strictEqual(sneaky.status, 201);
  emails.push(email('sneaky'));
  assert.strictEqual(sneaky.body.active, true);
});

test('only Admin can use /api/users: 401 without token, 403 for Staff and Customer', { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).get('/api/users')).status, 401);
  for (const who of ['staff', 'customer']) {
    assert.strictEqual((await request(app).get('/api/users').set(as(who))).status, 403);
    assert.strictEqual((await request(app).get(`/api/users/${ids.admin}`).set(as(who))).status, 403);
    assert.strictEqual((await request(app).patch(`/api/users/${ids.staff}`).set(as(who)).send({ role: 'Admin' })).status, 403);
    const create = await request(app).post('/api/users').set(as(who)).send({
      name: 'Nope', email: email(`nope-${who}`), password: PASSWORD, role: 'Admin',
    });
    assert.strictEqual(create.status, 403);
  }
});

test('list filters by role, active and search; never includes password_hash', { skip: SKIP }, async () => {
  const res = await request(app).get(`/api/users?role=Staff&search=${run}`).set(as('admin'));
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.length >= 1);
  assert.ok(res.body.every((u) => u.role === 'Staff' && u.active === true));
  assert.ok(res.body.some((u) => u.id === ids.staff));
  assert.ok(!JSON.stringify(res.body).includes('password'));

  assert.strictEqual((await request(app).get('/api/users?role=Boss').set(as('admin'))).status, 400);
  assert.strictEqual((await request(app).get('/api/users?active=maybe').set(as('admin'))).status, 400);
});

test('search treats % and _ as normal characters', { skip: SKIP }, async () => {
  const res = await request(app).get('/api/users?search=%25').set(as('admin'));
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.every((u) => u.name.includes('%') || u.email.includes('%')));
});

test('unknown or malformed user id -> 404', { skip: SKIP }, async () => {
  assert.strictEqual((await request(app).get('/api/users/999999999').set(as('admin'))).status, 404);
  assert.strictEqual((await request(app).get('/api/users/abc').set(as('admin'))).status, 404);
  assert.strictEqual((await request(app).patch('/api/users/999999999').set(as('admin')).send({ name: 'x' })).status, 404);
});

test('role change applies to the next request with the same token', { skip: SKIP }, async () => {
  const { body: u } = await createUser('promote', 'Staff');
  const token = signToken(u.id);
  assert.strictEqual((await request(app).get('/api/users').set('Authorization', `Bearer ${token}`)).status, 403);

  const res = await request(app).patch(`/api/users/${u.id}`).set(as('admin')).send({ role: 'Admin' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.role, 'Admin');
  assert.strictEqual((await request(app).get('/api/users').set('Authorization', `Bearer ${token}`)).status, 200);

  // Put it back so it doesn't count as an extra Admin.
  await request(app).patch(`/api/users/${u.id}`).set(as('admin')).send({ role: 'Staff' });
});

test('deactivation: existing token rejected (401) and login refused; reactivation restores access', { skip: SKIP }, async () => {
  const { body: u } = await createUser('deact', 'Staff');
  const token = signToken(u.id);
  const auth = { Authorization: `Bearer ${token}` };
  assert.strictEqual((await request(app).get('/api/templates').set(auth)).status, 200);

  const off = await request(app).patch(`/api/users/${u.id}`).set(as('admin')).send({ active: false });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.active, false);
  assert.strictEqual((await request(app).get('/api/templates').set(auth)).status, 401);
  const login = await request(app).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.61')
    .send({ email: email('deact'), password: PASSWORD });
  assert.strictEqual(login.status, 401);

  const on = await request(app).patch(`/api/users/${u.id}`).set(as('admin')).send({ active: true });
  assert.strictEqual(on.status, 200);
  assert.strictEqual((await request(app).get('/api/templates').set(auth)).status, 200);
});

test('Admin cannot change own role or deactivate themselves -> 409', { skip: SKIP }, async () => {
  const role = await request(app).patch(`/api/users/${ids.admin}`).set(as('admin')).send({ role: 'Staff' });
  assert.strictEqual(role.status, 409);
  const off = await request(app).patch(`/api/users/${ids.admin}`).set(as('admin')).send({ active: false });
  assert.strictEqual(off.status, 409);
  // Changing their own name is fine.
  const name = await request(app).patch(`/api/users/${ids.admin}`).set(as('admin')).send({ name: 'Test admin' });
  assert.strictEqual(name.status, 200);
});

test('role changes and deactivations are written to the audit log', { skip: SKIP }, async () => {
  const { body: u } = await createUser('audited', 'Customer');
  await request(app).patch(`/api/users/${u.id}`).set(as('admin')).send({ role: 'Staff' });
  await request(app).patch(`/api/users/${u.id}`).set(as('admin')).send({ active: false });
  const { rows } = await pool.db().query(
    `SELECT action, actor_id FROM audit_log WHERE entity = 'user' AND entity_id = $1 ORDER BY id`,
    [String(u.id)]
  );
  assert.deepStrictEqual(rows.map((r) => r.action), ['user_create', 'user_role_change', 'user_deactivate']);
  assert.ok(rows.every((r) => r.actor_id === ids.admin));
});

test('there is no delete endpoint for users', { skip: SKIP }, async () => {
  const res = await request(app).delete(`/api/users/${ids.customer}`).set(as('admin'));
  assert.strictEqual(res.status, 404);
});
