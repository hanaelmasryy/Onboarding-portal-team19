// Unit tests for plan input validation (issues #17, #18).
// No database needed.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseDate,
  validateCreatePlan,
  validatePlanListQuery,
  validateTaskListQuery,
  escapeLike,
} = require('../src/lib/planRules');

const NOW = new Date('2026-11-17T12:00:00Z');
const good = (over = {}) => ({ templateId: 4, customerId: 31, startDate: '2026-12-01', ...over });

test('parseDate accepts only real YYYY-MM-DD dates', () => {
  assert.strictEqual(parseDate('2026-12-01'), '2026-12-01');
  assert.strictEqual(parseDate('2028-02-29'), '2028-02-29'); // leap year
  for (const bad of ['2026-02-30', '2026-13-01', '2026-1-5', '01-12-2026', '2026-12-01T00:00:00Z', '', null, 20261201]) {
    assert.strictEqual(parseDate(bad), null, String(bad));
  }
});

test('valid plan body is accepted and cleaned', () => {
  const r = validateCreatePlan(good({ title: '  Acme onboarding  ', staffOwnerId: 5 }), NOW);
  assert.deepStrictEqual(r.value, {
    templateId: 4,
    customerId: 31,
    staffOwnerId: 5,
    startDate: '2026-12-01',
    title: 'Acme onboarding',
  });
});

test('title and staffOwnerId are optional', () => {
  const r = validateCreatePlan(good(), NOW);
  assert.strictEqual(r.value.title, null);
  assert.strictEqual(r.value.staffOwnerId, null);
});

test('ids must be positive whole numbers (not strings)', () => {
  for (const templateId of [undefined, 0, -1, 1.5, '4', null]) {
    assert.ok(validateCreatePlan(good({ templateId }), NOW).error, `templateId ${templateId}`);
  }
  assert.ok(validateCreatePlan(good({ customerId: '31' }), NOW).error);
  assert.ok(validateCreatePlan(good({ staffOwnerId: 'me' }), NOW).error);
});

test('startDate must be real and within 365 days of today', () => {
  assert.ok(validateCreatePlan(good({ startDate: '2026-02-30' }), NOW).error);
  assert.ok(validateCreatePlan(good({ startDate: undefined }), NOW).error);
  assert.ok(validateCreatePlan(good({ startDate: '2027-11-18' }), NOW).error); // 366 days ahead
  assert.ok(validateCreatePlan(good({ startDate: '2025-11-16' }), NOW).error); // 366 days back
  assert.ok(validateCreatePlan(good({ startDate: '2027-11-17' }), NOW).value); // exactly 365
  assert.ok(validateCreatePlan(good({ startDate: '2026-11-01' }), NOW).value); // backdated is fine
});

test('title rules: text, not empty, at most 150 characters', () => {
  assert.ok(validateCreatePlan(good({ title: 123 }), NOW).error);
  assert.ok(validateCreatePlan(good({ title: '   ' }), NOW).error);
  assert.ok(validateCreatePlan(good({ title: 'x'.repeat(151) }), NOW).error);
  assert.ok(validateCreatePlan(good({ title: 'x'.repeat(150) }), NOW).value);
});

test('body must be a JSON object', () => {
  for (const body of [null, [], 'text', 5]) {
    assert.ok(validateCreatePlan(body, NOW).error);
  }
});

test('plan list query: defaults and validation', () => {
  assert.deepStrictEqual(validatePlanListQuery({}).value, {
    status: null, customerId: null, search: null, page: 1, limit: 20,
  });
  const r = validatePlanListQuery({ status: 'Active', customerId: '31', search: ' acme ', page: '2', limit: '50' });
  assert.deepStrictEqual(r.value, { status: 'Active', customerId: 31, search: 'acme', page: 2, limit: 50 });

  assert.ok(validatePlanListQuery({ status: 'active' }).error); // case matters, same as the database
  assert.ok(validatePlanListQuery({ customerId: 'abc' }).error);
  assert.ok(validatePlanListQuery({ page: '0' }).error);
  assert.ok(validatePlanListQuery({ limit: '101' }).error);
  assert.ok(validatePlanListQuery({ search: 'x'.repeat(101) }).error);
  assert.ok(validatePlanListQuery({ search: ['a', 'b'] }).error); // ?search=a&search=b
});

test('task list query: status, assigneeId and overdue', () => {
  assert.deepStrictEqual(validateTaskListQuery({}).value, { status: null, assigneeId: null, overdue: false });
  assert.deepStrictEqual(
    validateTaskListQuery({ status: 'In Progress', assigneeId: '5', overdue: 'true' }).value,
    { status: 'In Progress', assigneeId: 5, overdue: true }
  );
  assert.ok(validateTaskListQuery({ status: 'Finished' }).error);
  assert.ok(validateTaskListQuery({ assigneeId: '-1' }).error);
  assert.ok(validateTaskListQuery({ overdue: 'yes' }).error);
});

test('escapeLike makes % and _ match literally', () => {
  assert.strictEqual(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
  assert.strictEqual(escapeLike('acme'), 'acme');
});
