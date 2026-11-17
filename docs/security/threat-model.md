# Threat model (draft, Week 3)

Customer Onboarding Checklist Portal · Team 19 · Owner: Hana Fady (issue #9)
Status: **draft**. The final version and the security review are issue #12 (Week 5).

This document takes the 11 threats from proposal section 6.4 and records, for each one,
what is **already implemented** in the code, how it is **tested**, and what is still
**open**. File paths are relative to `backend/` unless stated otherwise.

Status key: ✅ implemented and tested · 🟡 partly done · ⏳ planned (owner and week given)

## 1. System and trust boundaries

```
Browser (HTML/CSS/JS on Vercel)
   │  HTTPS, Bearer token in the Authorization header
   ▼
Express API (one Vercel Function)  ── trust boundary: every request is checked here
   │  requireAuth → requireRole → ownership check in the route
   ├── app_rw        → Neon Postgres (all application tables; audit_log insert-only)
   ├── dashboard_ro  → Neon Postgres (read-only, no emails, no password hashes, no notes)
   └── notifier      → Neon Postgres (reads plans/tasks, can only add notifications)
Vercel Cron ──(CRON_SECRET)──► /api/jobs/notifications
```

Assets to protect: customer plans and tasks, staff-only internal notes and internal tasks,
user accounts and password hashes, the JWT secret and database passwords, and the audit log.

Actors: Admin, Staff, Customer (all logged in), and an attacker who is either outside
(no account) or a logged-in Customer trying to reach more than their own data.

## 2. Threats and controls

| # | Threat (proposal 6.4) | Controls in place | Evidence (code / tests) | Status |
|---|---|---|---|---|
| 1 | Password theft or brute-force login | bcryptjs hashes (cost 12). Same `401 Invalid email or password` for a wrong email, wrong password or deactivated account. A dummy hash is checked for unknown emails, so timing does not reveal valid emails. 5 failures in 15 min from one email + IP → `429` with `Retry-After` for 15 min; the counter is in Neon (`login_attempts`), not in memory. Accounts are created only by an Admin (minimum password length 12); there is no self-registration. | `src/routes/auth.js`, `src/routes/users.js`, `src/lib/userRules.js`; `test/login.db.test.js`, `test/security.db.test.js` (lockout, same response for unknown email) | ✅ |
| 2 | User opens another customer's plan ID (IDOR) | Role checked by `requireRole` on every route. Plan routes check ownership and return `404` (not `403`) for plans that are not yours, so IDs cannot be probed. Malformed IDs are also `404`. | `src/middleware/auth.js`; plan routes (Hana Anwar, PR #31); `test/security.db.test.js` (403 on every template/user route for the wrong role) | 🟡 templates/users done; plan ownership tests in PR #31 and Week 3 (#22, Hana Anwar) |
| 3 | Internal notes leak through JSON | Internal tasks are filtered for customers in plan queries (PR #31). Responses are built from a whitelist (`toTemplate`, `toUser`), never `SELECT *`. `dashboard_ro` and `notifier` have no access to `internal_notes`. | `db/roles.sql`, `db/check.sql`; PR #31 | 🟡 notes endpoints are Week 3 (#21, Hana Anwar) |
| 4 | SQL injection / malicious input | Every query uses parameters (`$1`, `$2`); no SQL is built from user text. Input is validated before use (`templateRules.js`, `userRules.js`): types, lengths, allowed values, 1–100 tasks. Search text is escaped so `%` and `_` are literal. JSON body limit 100 kb; bad JSON → `400`. Only known fields are read from the body, so a client cannot set `password_hash`, `id` or `active` on create. | `src/lib/search.js`, `src/lib/*Rules.js`; `test/templates.db.test.js` (`' OR 1=1 --` search), `test/userRules.test.js` (mass assignment), `test/security.db.test.js` (no SQL in errors) | ✅ |
| 5 | Exposed database, JWT or email API secret | Secrets only in Vercel environment variables and the git-ignored `backend/.env`; `.env.example` has placeholders only. The API refuses to start signing tokens if `JWT_SECRET` is missing or shorter than 32 characters. **Rotate on exposure** was used for real: on 17 Nov the role passwords were rotated on Neon dev and main after they appeared in a chat/screenshot, and the SQL editor history was cleared. | `.gitignore`, `src/lib/tokens.js`; `test/middleware.test.js` (weak secret fails closed) | ✅ (Secrets Manager in the Floci phase, Jana) |
| 6 | Misconfigured CORS or deployment settings | CORS allowlist from `CORS_ORIGINS` only; `X-Powered-By` off; no stack traces in error responses; HTTPS from Vercel. `trust proxy` is set to 1 hop so `req.ip` is the real client behind Vercel. | `src/app.js`; `test/app.test.js`, `test/security.db.test.js` | 🟡 check the deployed settings with Postman (Week 4–5, Jana) |
| 7 | Forged, stolen or expired token (including theft through XSS) | HS256 only (an `alg: none` or HS512 token is rejected), fixed issuer and audience, 1-hour lifetime, user id in `sub` only. Role and `active` are read from the database on every request, so a role change or deactivation applies to the next request. Tokens are accepted only in the `Authorization: Bearer` header (not in the URL or a cookie, so no CSRF). The frontend keeps the token in `sessionStorage` and writes text with `textContent`, not `innerHTML`. | `src/lib/tokens.js`, `src/middleware/auth.js`, `frontend/js/api.js`; `test/middleware.test.js`, `test/security.db.test.js` (expired, tampered, wrong secret/issuer/audience, `alg: none`, no subject, unknown user, deactivated user on every route) | ✅ (screens: keep `textContent` rule in #10) |
| 8 | Over-privileged database access | Three roles with least privilege; `audit_log` is insert-only for `app_rw`; `dashboard_ro` cannot see emails or password hashes; `notifier` can only add notifications. Separate dev and main branches with different passwords. `check.sql` proves 26 allow/deny rules. Since Week 3 the login audit entries store the user id, not the typed email, so emails don't reach `dashboard_ro` through the audit log. | `db/roles.sql`, `db/check.sql` (26/26 PASS on dev and main), `src/routes/auth.js`; `test/security.db.test.js` (no emails in audit rows) | ✅ (AWS IAM version in the Floci phase, Hana Fady) |
| 9 | Unauthorized call to the daily job or email flooding | Planned: `CRON_SECRET` check, unique key on notifications, notifier role can only insert, email cap. | — | ⏳ Week 3–4 (Jana) |
| 10 | Customer changes a task they may not change (or reopens a Done task) | Template rule enforced at creation: a customer cannot be the actor of an internal task (checked in code and by a database constraint). Status-change rules are Week 3. | `src/lib/templateRules.js`, `db/schema.sql` | ⏳ Week 3 (#19, Hana Anwar) |
| 11 | Misuse goes unnoticed or is denied later | Insert-only `audit_log` with actor, action, record, result, IP and time. Logged so far: login, login_failed, login_inactive, login_locked, access_denied (every 403), template create/update/archive/reorder/duplicate, user create/role change/deactivate/reactivate/update (including refused self-lockout attempts). Passwords, tokens and note text are never logged. | `src/lib/audit.js`; audit checks in `test/login.db.test.js`, `test/templates.db.test.js`, `test/users.db.test.js`, `test/security.db.test.js` | 🟡 Admin read API `GET /api/audit` (Jana); plan events (Hana Anwar) |

## 3. Extra threats found while building

| # | Threat | Control | Status |
|---|---|---|---|
| E1 | An Admin locks everyone out (demotes or deactivates the last Admin, or themselves) | `PATCH /api/users/:id` refuses with `409`: no changing your own role, no deactivating yourself, always at least one active Admin (checked inside a transaction with row locks). The refusal is audited. | ✅ `src/routes/users.js`, `test/users.db.test.js` |
| E2 | Privilege escalation through the users API (Staff makes themselves Admin) | Whole `/api/users` API is Admin-only; role is read from the database, not the token. | ✅ `test/security.db.test.js` |
| E3 | Account enumeration through the Admin API | Only an Admin can list users or learn that an email exists (`409` on create). | ✅ accepted |
| E4 | Two Admins edit or reorder the same template at once | Edit and reorder lock the template row (`FOR UPDATE`) and bump the version in one transaction. | ✅ `src/routes/templates.js` |

## 4. Known limits (residual risk) to discuss in the review (#12)

1. **Lockout is per email + IP.** One attacker IP cannot lock a real user out from other IPs (good against denial of service), but an attacker spreading guesses across many IPs is only slowed by bcrypt, not blocked. A per-account limit across all IPs, or a CAPTCHA, would be the next step; out of scope for this course.
2. **Tokens cannot be revoked one by one.** A stolen token works until it expires (max 1 hour) unless the user is deactivated. Changing `JWT_SECRET` logs everyone out.
3. **`sessionStorage` is readable by script.** If an XSS bug were introduced, the token could be stolen. The `textContent` rule and no inline scripts reduce this; a Content-Security-Policy header is a possible Week 5 addition.
4. **No MFA, password reset or SSO** (listed as beyond the MVP in the proposal). A forgotten password needs an Admin.
5. **Admin accounts are powerful.** There is no second approval for role changes; this is covered by the audit log instead.
6. **Old audit rows from Week 2 may contain emails** in `entity_id` for failed logins (written before the Week 3 fix). On dev they are test data. The audit log is insert-only, so they stay; check main before go-live.

## 5. Next steps

- Hana Anwar: ownership and internal-note tests (threats 2, 3, 10).
- Jana: `CRON_SECRET`, notification limits, audit-log read API, deployed CORS check (threats 6, 9, 11).
- Hana Fady (Weeks 4–5): AWS IAM policies in Floci mirroring the three database roles (threat 8); full review and regression run against the deployed API (#12).
