# Routine Tracker

A mobile-first daily routine tracker for kids. Users get their own account, a
daily checklist of tasks worth points, a streak counter, and weekly/monthly
stats. Nothing is stored in the browser except the login token.

## Tech stack

- **Backend:** Node.js + Express, data persisted via `@libsql/client`
  (SQLite-compatible) — a local file for development, or a remote
  [Turso](https://turso.tech) database for persistent production storage
- **Auth:** JWT (7-day expiry) + bcrypt password hashing (12 salt rounds)
- **Frontend:** plain HTML/CSS/JS single-page app, Chart.js from cdnjs

## Prerequisites

- Node.js 18 or newer

## Setup

```bash
npm install
cp .env.example .env
```

Then open `.env` and set `JWT_SECRET` to a long random string. You can
generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The server refuses to start until a real secret is set.

## Run

```bash
node server/index.js
```

The app is served at <http://localhost:3000>. Change the port by setting
`PORT` in `.env`.

## Database

By default (no `DATABASE_URL` set), the server stores everything in a local
libSQL file `data.db`, created automatically in the project root on first
start. This is fine for local development, but **on hosts with an ephemeral
filesystem (e.g. Render's free tier), a local file is wiped on every restart
or redeploy** — for persistent data, point the app at a free
[Turso](https://turso.tech) database instead:

1. Install the Turso CLI and sign in: `turso auth login`
2. Create a database: `turso db create routine-tracker`
3. Get the connection URL: `turso db show routine-tracker --url`
4. Create an auth token: `turso db tokens create routine-tracker`
5. Set `DATABASE_URL` and `DATABASE_AUTH_TOKEN` in `.env` (or your host's
   environment variables) to the values from steps 3 and 4.

If you have existing data in the old `data.json` file format, migrate it into
whichever target is configured with:

```bash
node scripts/migrate-from-json.js
```

## Running on a public server

1. Copy the project to the server, run `npm install`, and create `.env` with a
   strong `JWT_SECRET` (and `DATABASE_URL`/`DATABASE_AUTH_TOKEN` if using
   Turso).
2. Keep the process alive with a process manager, e.g.
   `pm2 start server/index.js --name routine-tracker` (or a systemd unit).
3. Point a reverse proxy at port 3000 and terminate TLS there. Example nginx
   server block:

   ```nginx
   server {
       listen 443 ssl;
       server_name tracker.example.com;
       # ssl_certificate / ssl_certificate_key ...

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

   Always serve the app over HTTPS in production — the JWT is sent on every
   request.
4. If running in local-file mode, back up `data.db` (a simple copy is enough)
   to keep user data safe. With Turso, data is already stored off-server —
   `turso db shell <name> .dump` can produce a backup if needed.

## API overview

All routes are JSON. Everything except register/login requires
`Authorization: Bearer <token>`.

| Method | Route                  | Purpose                                   |
| ------ | ---------------------- | ----------------------------------------- |
| POST   | /api/register          | Create account (seeds default task list)  |
| POST   | /api/login             | Returns JWT                               |
| GET    | /api/me                | Current user info                         |
| PUT    | /api/me/password       | Change password                           |
| PUT    | /api/me/avatar         | Change avatar color                       |
| DELETE | /api/me                | Delete account (password confirmation)    |
| GET    | /api/tasks             | List tasks                                |
| POST   | /api/tasks             | Add a custom task                         |
| DELETE | /api/tasks/:id         | Delete a task                             |
| PUT    | /api/tasks/:id/move    | Reorder a task (`{"direction":"up"}`)     |
| GET    | /api/log/today         | Today's completed task IDs + points       |
| POST   | /api/log               | Mark a task complete today                |
| DELETE | /api/log/:taskId       | Unmark a task for today                   |
| GET    | /api/stats/week        | Points per day, current week (Mon–Sun)    |
| GET    | /api/stats/month       | Points per week, current month (4 weeks)  |
| GET    | /api/stats/summary     | Totals, streaks, best day, completion %   |

Notes:

- Completing **all** tasks in a day automatically awards a +25 "full day
  bonus" server-side (and removes it again if a task is unchecked).
- "Today" is the **server's** local date in `YYYY-MM-DD`.
- Streak = consecutive days with at least one logged task; it resets after a
  full day with zero logs.
- `/api/login` and `/api/register` are rate-limited to 10 requests per minute
  per IP.
