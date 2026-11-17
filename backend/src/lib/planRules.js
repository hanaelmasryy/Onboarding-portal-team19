// Plan & Task Management - input validation. Owner: Hana Anwar.
//
// Pure functions (no database), so the rules can be unit-tested anywhere.
// See docs/api/plans-tasks-notes.md for the contract these follow.

const PLAN_STATUSES = ['Active', 'Completed', 'Cancelled'];
const TASK_STATUSES = ['Not Started', 'In Progress', 'Done'];
const MAX_START_OFFSET_DAYS = 365; // startDate at most this far from today
const DAY_MS = 24 * 60 * 60 * 1000;

function isPositiveId(value) {
  return Number.isInteger(value) && value > 0 && value <= 2147483647;
}

// Accepts only a real calendar date written as YYYY-MM-DD.
// Returns the same string, or null ("2026-02-30" and "2026-1-5" are rejected).
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? value : null;
}

function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

// Validates the body of POST /api/plans.
// Returns { value } with clean data, or { error } with a message for a 400.
function validateCreatePlan(body, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  const { templateId, customerId, staffOwnerId } = body;
  if (!isPositiveId(templateId)) return { error: 'templateId must be a positive whole number' };
  if (!isPositiveId(customerId)) return { error: 'customerId must be a positive whole number' };
  if (staffOwnerId !== undefined && staffOwnerId !== null && !isPositiveId(staffOwnerId)) {
    return { error: 'staffOwnerId must be a positive whole number' };
  }

  const startDate = parseDate(body.startDate);
  if (!startDate) return { error: 'startDate must be a real date written as YYYY-MM-DD' };
  if (Math.abs(daysBetween(todayUtc(now), startDate)) > MAX_START_OFFSET_DAYS) {
    return { error: `startDate must be within ${MAX_START_OFFSET_DAYS} days of today` };
  }

  let title = null;
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== 'string') return { error: 'title must be text' };
    title = body.title.trim();
    if (!title) return { error: 'title cannot be empty' };
    if (title.length > 150) return { error: 'title must be at most 150 characters' };
  }

  return {
    value: { templateId, customerId, staffOwnerId: staffOwnerId || null, startDate, title },
  };
}

// Query-string ids arrive as text; same rule as route ids.
function parseQueryId(raw) {
  return typeof raw === 'string' && /^[1-9][0-9]{0,9}$/.test(raw) && Number(raw) <= 2147483647
    ? Number(raw)
    : null;
}

// Validates ?status=&customerId=&search=&page=&limit= for GET /api/plans.
function validatePlanListQuery(query = {}) {
  const out = { status: null, customerId: null, search: null, page: 1, limit: 20 };

  if (query.status !== undefined) {
    if (!PLAN_STATUSES.includes(query.status)) {
      return { error: `status must be one of: ${PLAN_STATUSES.join(', ')}` };
    }
    out.status = query.status;
  }
  if (query.customerId !== undefined) {
    out.customerId = parseQueryId(query.customerId);
    if (!out.customerId) return { error: 'customerId must be a positive whole number' };
  }
  if (query.search !== undefined) {
    if (typeof query.search !== 'string') return { error: 'search must be text' };
    const search = query.search.trim();
    if (search.length > 100) return { error: 'search must be at most 100 characters' };
    out.search = search || null;
  }
  if (query.page !== undefined) {
    out.page = parseQueryId(query.page);
    if (!out.page || out.page > 100000) return { error: 'page must be a positive whole number' };
  }
  if (query.limit !== undefined) {
    out.limit = parseQueryId(query.limit);
    if (!out.limit || out.limit > 100) return { error: 'limit must be a whole number from 1 to 100' };
  }
  return { value: out };
}

// Validates ?status=&assigneeId=&overdue= for GET /api/plans/:id/tasks.
function validateTaskListQuery(query = {}) {
  const out = { status: null, assigneeId: null, overdue: false };
  if (query.status !== undefined) {
    if (!TASK_STATUSES.includes(query.status)) {
      return { error: `status must be one of: ${TASK_STATUSES.join(', ')}` };
    }
    out.status = query.status;
  }
  if (query.assigneeId !== undefined) {
    out.assigneeId = parseQueryId(query.assigneeId);
    if (!out.assigneeId) return { error: 'assigneeId must be a positive whole number' };
  }
  if (query.overdue !== undefined) {
    if (query.overdue !== 'true' && query.overdue !== 'false') {
      return { error: "overdue must be 'true' or 'false'" };
    }
    out.overdue = query.overdue === 'true';
  }
  return { value: out };
}

// Escapes % and _ so a search for "50%" matches the text "50%", not everything.
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

module.exports = {
  PLAN_STATUSES,
  TASK_STATUSES,
  parseDate,
  validateCreatePlan,
  validatePlanListQuery,
  validateTaskListQuery,
  escapeLike,
};
