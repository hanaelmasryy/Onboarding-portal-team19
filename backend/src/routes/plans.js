// Plan & Task Management - Owner: Hana Anwar
// Contract: docs/api/plans-tasks-notes.md
//
// Week 2 (issues #17, #18):
//   POST /api/plans               Admin                   create a plan from a template      201
//   GET  /api/plans               Admin, Staff, Customer  list plans (customers: own only)   200
//   GET  /api/plans/:id           Admin, Staff, Customer  one plan with its tasks            200
//   GET  /api/plans/:id/tasks     Admin, Staff, Customer  tasks of a plan, with filters      200
//
// Week 3 adds: PATCH /api/plans/:id, PATCH /api/tasks/:id,
//              PATCH /api/tasks/:id/assignment, GET/POST /api/plans/:id/notes
//
// Errors: 400 bad input, 401 not logged in, 403 wrong role,
//         404 unknown id or not yours, 409 template archived.
//
// Security rules followed here:
//   - Customers only ever get their own plans (customer_id = caller in SQL);
//     anything else is 404, so plan ids cannot be probed.
//   - Customers never get internal tasks: visibility = 'customer' is part of
//     the SQL query, not a filter applied afterwards.
//   - Internal notes are never returned by these endpoints.
//   - Parameterized SQL only.

const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { parseId } = require('../lib/templateRules');
const {
  validateCreatePlan,
  validatePlanListQuery,
  validateTaskListQuery,
  escapeLike,
} = require('../lib/planRules');
const planEvents = require('../lib/planEvents');

const router = express.Router();

const MAX_TASKS_PER_PLAN = 100;

// Customers are limited to their own plans; staff side sees everything.
// Returns the customer id to filter on, or null for Admin/Staff.
function customerScope(user) {
  return user.role === 'Customer' ? user.id : null;
}

// ---- mapping database rows to the JSON in the contract ---------------------
function toPlan(row, staffView) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    startDate: row.start_date,
    customer: { id: row.customer_id, name: row.customer_name },
    template: { id: row.template_id, title: row.template_title, version: row.template_version },
    cancelReason: staffView ? row.cancel_reason : null,
    progress: { done: row.done_count, total: row.task_count },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTask(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    title: row.title,
    position: row.position,
    visibility: row.visibility,
    actor: row.actor,
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null,
    dueDate: row.due_date,
    status: row.status,
    overdue: row.overdue,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

// ---- queries ----------------------------------------------------------------
// $1 = customer scope (null for staff side). Task counts include only the
// tasks this caller is allowed to see.
const PLAN_COLUMNS = `
  p.id, p.title, p.status, to_char(p.start_date, 'YYYY-MM-DD') AS start_date,
  p.cancel_reason, p.template_id, p.template_version, t.title AS template_title,
  p.customer_id, c.name AS customer_name, p.created_at, p.updated_at,
  COUNT(k.id)::int AS task_count,
  COUNT(k.id) FILTER (WHERE k.status = 'Done')::int AS done_count`;

const PLAN_FROM = `
  FROM onboarding_plans p
  JOIN templates t ON t.id = p.template_id
  JOIN users c     ON c.id = p.customer_id
  LEFT JOIN tasks k ON k.plan_id = p.id AND ($1::int IS NULL OR k.visibility = 'customer')`;

async function loadPlan(db, planId, scope) {
  const { rows } = await db.query(
    `SELECT ${PLAN_COLUMNS} ${PLAN_FROM}
      WHERE p.id = $2 AND ($1::int IS NULL OR p.customer_id = $1)
      GROUP BY p.id, t.title, c.name`,
    [scope, planId]
  );
  return rows[0] || null;
}

async function loadTasks(db, planId, scope, filters = {}) {
  const { status = null, assigneeId = null, overdue = false } = filters;
  const { rows } = await db.query(
    `SELECT k.id, k.plan_id, k.title, k.position, k.visibility, k.actor,
            k.assignee_id, u.name AS assignee_name,
            to_char(k.due_date, 'YYYY-MM-DD') AS due_date, k.status,
            (k.status <> 'Done' AND k.due_date < CURRENT_DATE) AS overdue,
            k.completed_at, k.updated_at
       FROM tasks k
       LEFT JOIN users u ON u.id = k.assignee_id
      WHERE k.plan_id = $1
        AND ($2::int IS NULL OR k.visibility = 'customer')
        AND ($3::text IS NULL OR k.status = $3)
        AND ($4::int IS NULL OR k.assignee_id = $4)
        AND (NOT $5::boolean OR (k.status <> 'Done' AND k.due_date < CURRENT_DATE))
      ORDER BY k.position`,
    [planId, scope, status, scope ? null : assigneeId, overdue]
  );
  return rows.map(toTask);
}

// Runs fn inside one database transaction: all of it is saved, or none of it.
async function inTransaction(fn) {
  const client = await pool.db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- P1: create a plan from a template (issue #17) --------------------------
router.post('/plans', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const input = validateCreatePlan(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const { templateId, customerId, startDate } = input.value;
    const staffOwnerId = input.value.staffOwnerId || req.user.id;

    const outcome = await inTransaction(async (client) => {
      // FOR SHARE: the template cannot be edited or archived until we commit,
      // so the plan copies one consistent version.
      const tpl = await client.query(
        'SELECT id, title, status, version FROM templates WHERE id = $1 FOR SHARE',
        [templateId]
      );
      const template = tpl.rows[0];
      if (!template) return { status: 404, error: 'Template not found' };
      if (template.status !== 'active') return { status: 409, error: 'Template is archived' };

      const count = await client.query(
        'SELECT COUNT(*)::int AS n FROM template_tasks WHERE template_id = $1',
        [templateId]
      );
      if (count.rows[0].n === 0) return { status: 400, error: 'Template has no tasks' };
      if (count.rows[0].n > MAX_TASKS_PER_PLAN) {
        return { status: 400, error: `A plan can have at most ${MAX_TASKS_PER_PLAN} tasks` };
      }

      const cust = await client.query(
        "SELECT id, name FROM users WHERE id = $1 AND role = 'Customer' AND active",
        [customerId]
      );
      const customer = cust.rows[0];
      if (!customer) return { status: 400, error: 'customerId must be an active customer' };

      const owner = await client.query(
        "SELECT id FROM users WHERE id = $1 AND role IN ('Admin', 'Staff') AND active",
        [staffOwnerId]
      );
      if (!owner.rows[0]) return { status: 400, error: 'staffOwnerId must be an active Admin or Staff user' };

      const title = input.value.title || `${template.title} – ${customer.name}`.slice(0, 150);

      const plan = await client.query(
        `INSERT INTO onboarding_plans (template_id, template_version, customer_id, title, start_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [template.id, template.version, customer.id, title, startDate, req.user.id]
      );
      const planId = plan.rows[0].id;

      // Copy the template's tasks. Due date = start date + offset days;
      // customer tasks go to the customer, staff tasks to the staff owner.
      await client.query(
        `INSERT INTO tasks (plan_id, template_task_id, title, position, visibility, actor, assignee_id, due_date)
         SELECT $1, tt.id, tt.title, tt.position, tt.visibility, tt.actor,
                CASE WHEN tt.actor = 'customer' THEN $2::int ELSE $3::int END,
                $4::date + tt.offset_days
           FROM template_tasks tt
          WHERE tt.template_id = $5
          ORDER BY tt.position`,
        [planId, customer.id, staffOwnerId, startDate, template.id]
      );

      const assignees = await client.query(
        'SELECT DISTINCT assignee_id FROM tasks WHERE plan_id = $1',
        [planId]
      );
      await planEvents.taskAssigned(client, {
        planId,
        assigneeIds: assignees.rows.map((r) => r.assignee_id),
      });

      return {
        status: 201,
        planId,
        plan: await loadPlan(client, planId, null),
        tasks: await loadTasks(client, planId, null),
      };
    });

    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });

    await recordAudit({ actorId: req.user.id, action: 'plan_create', entity: 'plan', entityId: outcome.planId, result: 'allowed', ip: req.ip });
    return res.status(201).json({ plan: toPlan(outcome.plan, true), tasks: outcome.tasks });
  } catch (err) {
    return next(err);
  }
});

// ---- P2: list plans (issue #18) ----------------------------------------------
router.get('/plans', requireAuth, requireRole('Admin', 'Staff', 'Customer'), async (req, res, next) => {
  try {
    const input = validatePlanListQuery(req.query);
    if (input.error) return res.status(400).json({ error: input.error });
    const { status, search, page, limit } = input.value;
    const scope = customerScope(req.user);
    // A customer's own id always wins over any customerId they send.
    const customerId = scope ? null : input.value.customerId;

    const { rows } = await pool.db().query(
      `SELECT ${PLAN_COLUMNS}, COUNT(*) OVER () AS full_count
         ${PLAN_FROM}
        WHERE ($1::int IS NULL OR p.customer_id = $1)
          AND ($2::text IS NULL OR p.status = $2)
          AND ($3::int IS NULL OR p.customer_id = $3)
          AND ($4::text IS NULL OR p.title ILIKE '%' || $4 || '%' ESCAPE '\\')
        GROUP BY p.id, t.title, c.name
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $5 OFFSET $6`,
      [scope, status, customerId, search ? escapeLike(search) : null, limit, (page - 1) * limit]
    );

    return res.json({
      items: rows.map((r) => toPlan(r, !scope)),
      page,
      limit,
      total: rows[0] ? Number(rows[0].full_count) : 0,
    });
  } catch (err) {
    return next(err);
  }
});

// ---- P3: one plan with its tasks (issue #18) ----------------------------------
router.get('/plans/:id', requireAuth, requireRole('Admin', 'Staff', 'Customer'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const scope = customerScope(req.user);
    const plan = id && (await loadPlan(pool.db(), id, scope));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const tasks = await loadTasks(pool.db(), id, scope);
    return res.json({ plan: toPlan(plan, !scope), tasks });
  } catch (err) {
    return next(err);
  }
});

// ---- T1: tasks of a plan, with filters (issue #18) ----------------------------
router.get('/plans/:id/tasks', requireAuth, requireRole('Admin', 'Staff', 'Customer'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const scope = customerScope(req.user);
    const plan = id && (await loadPlan(pool.db(), id, scope));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const input = validateTaskListQuery(req.query);
    if (input.error) return res.status(400).json({ error: input.error });

    return res.json({ items: await loadTasks(pool.db(), id, scope, input.value) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
