# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Mobile-first daily routine tracker for kids. Express + better-sqlite3 backend with JWT auth; plain HTML/CSS/vanilla-JS single-page frontend (no build step, no framework). Chart.js is loaded from cdnjs.

## Commands

- `npm install` — better-sqlite3 and bcrypt are native modules; better-sqlite3 must be ^12 to compile on recent Node (v11 fails against Node 26's V8).
- `node server/index.js` — start the server (default port 3000, `PORT` in `.env` overrides). Requires `JWT_SECRET` in `.env` (copy `.env.example`); the server exits at startup if it's missing or still the placeholder.
- No test suite, linter, or build step exists. Verify changes by starting the server and exercising `/api/*` with curl (see README for the route table).
- `data.sqlite` is created automatically in the project root on first start; delete it (plus `-wal`/`-shm`) to reset all data.

## Architecture

- `server/index.js` — all API routes, validation, stats/streak calculations, and date helpers. Everything date-related uses the **server's local date** as `YYYY-MM-DD` strings (`todayStr()`/`addDays()`); never use UTC or Date math directly on log dates.
- `server/db.js` — schema (created idempotently at require time) and the default task list seeded per new user.
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
