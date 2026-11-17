// Plan events - Owner: Hana Anwar.
//
// One place where Plan & Task Management tells the rest of the system that
// something happened (docs/api/plans-tasks-notes.md, section 5).
//
//   Weeks 2-3: the event is written straight away as an in-app notification
//              row, inside the caller's transaction.
//   Weeks 4-5: the same functions will send the payload to the emulated
//              Amazon SQS queue "plan-events" (Floci) instead, and the
//              notifier will create the notification from the queue.
//
// Payloads carry ids only: never emails, note text or tokens.

// task.assigned: one in-app "assigned" notification per assignee.
// taskId is null when a whole plan is created (one notification per person,
// not one per task). The unique index notifications_once_per_day stops
// duplicates, so repeating the same event on the same day is harmless.
async function taskAssigned(client, { planId, taskId = null, assigneeIds }) {
  const unique = [...new Set(assigneeIds.filter(Boolean))];
  for (const userId of unique) {
    await client.query(
      `INSERT INTO notifications (user_id, plan_id, task_id, type, channel)
       VALUES ($1, $2, $3, 'assigned', 'in_app')
       ON CONFLICT DO NOTHING`,
      [userId, planId, taskId]
    );
  }
}

module.exports = { taskAssigned };
