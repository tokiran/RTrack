# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Mobile-first daily routine tracker for kids. Express backend with JWT auth, data persisted via `@libsql/client` (SQLite-compatible — a local file for development, or a remote Turso database for persistent production storage); plain HTML/CSS/vanilla-JS single-page frontend (no build step, no framework). Chart.js is loaded from cdnjs.

## Commands

- `npm install` — bcrypt and @libsql/client are native/binary deps.
- `node server/index.js` — start the server (default port 3000, `PORT` in `.env` overrides). Requires `JWT_SECRET` in `.env` (copy `.env.example`); the server exits at startup if it's missing or still the placeholder.
- No test suite, linter, or build step exists. Verify changes by starting the server and exercising `/api/*` with curl (see README for the route table).
- Database connection: with `DATABASE_URL`/`DATABASE_AUTH_TOKEN` unset, the server uses a local libSQL file `data.db` in the project root (created automatically, idempotent schema via `db.init()`). Delete `data.db` (plus `-wal`/`-shm`/`-journal` if present) to reset all local data. Set both env vars to point at a Turso database instead — see `.env.example`.
- `node scripts/migrate-from-json.js [path/to/data.json]` — one-time migration from the old JSON file store into whatever libSQL target is configured (local file or Turso). Aborts if the target already has users, to avoid duplicates.

## Architecture

- `server/index.js` — all API routes, validation, stats/streak calculations, and date helpers. Everything date-related uses the **server's local date** as `YYYY-MM-DD` strings (`todayStr()`/`addDays()`); never use UTC or Date math directly on log dates. Every route is wrapped in `asyncHandler` (forwards rejected promises to Express's error middleware); `app.listen()` only happens after `db.init()` resolves.
- `server/db.js` — the libSQL data layer: creates a `@libsql/client` connection (`DATABASE_URL`/`DATABASE_AUTH_TOKEN` for Turso, else a local `data.db` file), exposes `init()` (idempotent `CREATE TABLE IF NOT EXISTS` for `users`/`tasks`/`logs`) and async query/mutation functions per table. **All exported functions return Promises — every call site must `await`.** Multi-statement writes (delete-task cascade, task reorder, default-task seeding, account deletion) use `client.batch(..., 'write')` for atomicity. IDs come from SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` (never reused, even after deletes).
- `server/auth.js` — JWT sign/verify; reads `JWT_SECRET` at require time, so `dotenv` must load first (index.js line 1).
- `server/middleware.js` — `requireAuth` sets `req.userId` from the Bearer token; every data query must filter by `user_id` (ownership is enforced per-query, not globally).
- `public/` — served statically. `app.js` is a screen-based SPA: `showScreen(name)` toggles `#screen-*` sections and triggers per-screen load functions; `api()` wraps fetch, attaches the token from localStorage, and force-logs-out on any 401.

## Key invariants

- **Full-day bonus:** completing all tasks awards a +25 log row with `task_id NULL, is_bonus 1`. `updateBonus()` must be called after anything that changes today's completion state — logging, unlogging, adding a task, deleting a task — because it both awards and revokes the bonus.
- **Logs outlive tasks:** deleting a task sets `logs.task_id` to NULL (history keeps earned points). A NULL `task_id` therefore means "bonus row" only when `is_bonus = 1`.
- Duplicate same-day completion is blocked both by an explicit check (returns 409) and the `UNIQUE(user_id, task_id, logged_date)` constraint.
- Streak = consecutive days with ≥1 log; an unlogged *today* doesn't break the current streak (counting starts from yesterday if today is empty).
- Task points are restricted to 5/10/15/20/50 and categories to the fixed list in `server/index.js` (`ALLOWED_POINTS`/`CATEGORIES`); the frontend mirrors these.
- Frontend renders user-supplied strings only through `escapeHtml()`; keep that when touching `renderTaskList` or anything that uses `innerHTML`.
- API responses to mutating log/task calls return the fresh `today` payload; the frontend relies on this to avoid refetching.
