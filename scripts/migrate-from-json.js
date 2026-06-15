// One-time migration: load data from the old data.json file store into the
// libsql database (local data.db, or a remote Turso DB if DATABASE_URL /
// DATABASE_AUTH_TOKEN are set). Run with:
//   node scripts/migrate-from-json.js [path/to/data.json]
//
// Safe to run only against an empty database — explicit ids are inserted so
// existing JWTs (which embed the user id) keep working after migration.

const fs = require('fs');
const path = require('path');
const db = require('../server/db');

async function main() {
  const jsonPath = process.argv[2] || path.join(__dirname, '..', 'data.json');
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  await db.init();

  const existing = await db.client.execute('SELECT COUNT(*) AS c FROM users');
  if (existing.rows[0].c > 0) {
    console.error('Target database already has users — aborting to avoid duplicates/conflicts.');
    process.exit(1);
  }

  for (const u of data.users) {
    await db.client.execute({
      sql: `INSERT INTO users (id, username, password_hash, avatar_color, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [u.id, u.username, u.password_hash, u.avatar_color, u.created_at],
    });
  }

  for (const t of data.tasks) {
    await db.client.execute({
      sql: `INSERT INTO tasks (id, user_id, name, points, category, sort_order, is_default)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [t.id, t.user_id, t.name, t.points, t.category, t.sort_order, t.is_default],
    });
  }

  for (const l of data.logs) {
    await db.client.execute({
      sql: `INSERT INTO logs (id, user_id, task_id, logged_date, points_earned, is_bonus, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [l.id, l.user_id, l.task_id, l.logged_date, l.points_earned, l.is_bonus, l.created_at],
    });
  }

  console.log(`Migrated ${data.users.length} user(s), ${data.tasks.length} task(s), ${data.logs.length} log(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
