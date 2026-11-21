// Dashboard & Monitoring - Owner: Jana Hossam
// Endpoints for the dashboard, notifications, audit log and the daily job
// go here (proposal section 5.1).
//   GET /api/dashboard/summary   Admin, Staff   counts of plans, tasks and overdue tasks
//   GET /api/dashboard/plans     Admin, Staff   progress of each plan (?status=&page=&limit=)
//   GET /api/audit               Admin          security log (?action=&result=&from=&to=&page=&limit=)

const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const PLAN_STATUSES = ['Active', 'Completed', 'Cancelled'];

// Reads page and limit from the URL. Returns { page, limit } or { error } for a 400.
function readPaging(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(page) || page < 1) return { error: 'page must be a whole number of 1 or more' };
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be a whole number from 1 to 100' };
  return { page, limit };
}

const AUDIT_RESULTS = ['allowed', 'denied'];

// Reads a date from the URL. Returns { value } (null if not given) or { error }.
function readDate(raw, name) {
  if (raw === undefined) return { value: null };
  const date = new Date(raw);
  if (typeof raw !== 'string' || Number.isNaN(date.getTime())) {
    return { error: `${name} must be a date, for example 2026-11-01` };
  }
  return { value: date.toISOString() };
}

router.get('/dashboard/summary', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    const db = pool.dashboardDb();   // read-only role
     const plans = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM onboarding_plans GROUP BY status`
    );
     const tasks = await db.query(
      `SELECT t.status, COUNT(*)::int AS count
         FROM tasks t JOIN onboarding_plans p ON p.id = t.plan_id
        WHERE p.status = 'Active'
        GROUP BY t.status`
    );

    const overdue = await db.query(
      `SELECT COUNT(*)::int AS count
         FROM tasks t JOIN onboarding_plans p ON p.id = t.plan_id
        WHERE p.status = 'Active' AND t.status <> 'Done' AND t.due_date < CURRENT_DATE`
    );

        const planCounts = { active: 0, completed: 0, cancelled: 0 };
    for (const row of plans.rows) {
      planCounts[row.status.toLowerCase()] = row.count;
    }

        const taskKeys = { 'Not Started': 'notStarted', 'In Progress': 'inProgress', Done: 'done' };
    const taskCounts = { notStarted: 0, inProgress: 0, done: 0 };
    for (const row of tasks.rows) {
      taskCounts[taskKeys[row.status]] = row.count;
    }
    return res.json({
      plans: planCounts,
      tasks: taskCounts,
      overdueTasks: overdue.rows[0].count,
    });

  } catch (err) {
    return next(err);
  }
});
router.get('/dashboard/plans', requireAuth, requireRole('Admin', 'Staff'), async (req, res, next) => {
  try {
    // 1. check the URL options
    const status = req.query.status;
    if (status !== undefined && !PLAN_STATUSES.includes(status)) {
      return res.status(400).json({ error: "status must be 'Active', 'Completed' or 'Cancelled'" });
    }
    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ error: paging.error });
    const offset = (paging.page - 1) * paging.limit;

    // 2. run the query (read-only role)
    const { rows } = await pool.dashboardDb().query(
      `SELECT p.id, p.title, p.status, to_char(p.start_date, 'YYYY-MM-DD') AS start_date, u.name AS customer_name,
              COUNT(t.id)::int                                            AS total_tasks,
              COUNT(t.id) FILTER (WHERE t.status = 'Done')::int           AS done_tasks,
              COUNT(t.id) FILTER (WHERE t.status <> 'Done'
                                    AND t.due_date < CURRENT_DATE)::int   AS overdue_tasks,
              MIN(t.due_date) FILTER (WHERE t.status <> 'Done')           AS next_due_date
         FROM onboarding_plans p
         JOIN users u      ON u.id = p.customer_id
         LEFT JOIN tasks t ON t.plan_id = p.id
        WHERE ($1::text IS NULL OR p.status = $1)
        GROUP BY p.id, u.name
        ORDER BY overdue_tasks DESC, p.id
        LIMIT $2 OFFSET $3`,
      [status ?? null, paging.limit, offset]
    );

    // 3. TODO: turn each row into camelCase JSON, and work out progress
    
          // 3. turn each row into camelCase JSON, and work out progress
    const plans = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      startDate: r.start_date,
      customerName: r.customer_name,
      totalTasks: r.total_tasks,
      doneTasks: r.done_tasks,
      overdueTasks: r.overdue_tasks,
      progress: r.total_tasks ? Math.round((r.done_tasks / r.total_tasks) * 100) : 0,
      nextDueDate: r.next_due_date,
    }));
    

    return res.json({ page: paging.page, limit: paging.limit, plans });
  } catch (err) {
    return next(err);
  }
});


// GET /api/audit   Admin only   security log, newest first (issue #37)
router.get('/audit', requireAuth, requireRole('Admin'), async (req, res, next) => {
  try {
    const { action, result } = req.query;
    if (action !== undefined && (typeof action !== 'string' || !/^[a-z_]{1,60}$/.test(action))) {
      return res.status(400).json({ error: 'action must be lowercase letters and _ only (max 60)' });
    }
    if (result !== undefined && !AUDIT_RESULTS.includes(result)) {
      return res.status(400).json({ error: "result must be 'allowed' or 'denied'" });
    }
    const from = readDate(req.query.from, 'from');
    if (from.error) return res.status(400).json({ error: from.error });
    const to = readDate(req.query.to, 'to');
    if (to.error) return res.status(400).json({ error: to.error });
    const paging = readPaging(req.query);
    if (paging.error) return res.status(400).json({ error: paging.error });

    const { rows } = await pool.dashboardDb().query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.result, a.ip_address,
              a.created_at, a.actor_id, u.name AS actor_name
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::text        IS NULL OR a.action = $1)
          AND ($2::text        IS NULL OR a.result = $2)
          AND ($3::timestamptz IS NULL OR a.created_at >= $3)
          AND ($4::timestamptz IS NULL OR a.created_at <  $4)
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $5 OFFSET $6`,
      [action ?? null, result ?? null, from.value, to.value, paging.limit, (paging.page - 1) * paging.limit]
    );

    const entries = rows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      entity: r.entity,
      // old Week 2 rows may hold an email here (threat model, known limit 6): never show it
      entityId: r.entity_id && r.entity_id.includes('@') ? null : r.entity_id,
      result: r.result,
      ipAddress: r.ip_address,
      actorId: r.actor_id,
      actorName: r.actor_name,
      createdAt: r.created_at,
    }));

    return res.json({ page: paging.page, limit: paging.limit, entries });
  } catch (err) {
    return next(err);
  }
});
module.exports = router;


