const path = require('path');
const { createClient } = require('@libsql/client');

// DATABASE_URL points at a remote Turso database (libsql://...) in
// production. Falls back to a local libSQL file for development, which
// behaves like a normal SQLite file on disk.
const client = createClient({
  url: process.env.DATABASE_URL || `file:${path.join(__dirname, '..', 'data.db')}`,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

async function init() {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      avatar_color  TEXT NOT NULL DEFAULT '#3B82F6',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      points     INTEGER NOT NULL,
      category   TEXT NOT NULL DEFAULT 'Custom',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL,
      task_id       INTEGER,
      logged_date   TEXT NOT NULL,
      points_earned INTEGER NOT NULL,
      is_bonus      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, task_id, logged_date)
    );

    CREATE INDEX IF NOT EXISTS idx_logs_user_date ON logs(user_id, logged_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
  `);
}

// Foreign-key cascades (ON DELETE CASCADE / SET NULL) aren't relied on here —
// PRAGMA foreign_keys behavior isn't guaranteed across local vs. remote Turso
// connections, so cascades are done explicitly below instead.

// Converts "123" / 123 to a finite integer, or null if not a valid id.
function toId(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- users ----------

async function getUserById(id) {
  const uid = toId(id);
  if (uid === null) return undefined;
  const r = await client.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [uid] });
  return r.rows[0];
}

async function getUserByUsername(username) {
  const r = await client.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
  return r.rows[0];
}

async function insertUser(username, passwordHash, avatarColor) {
  const r = await client.execute({
    sql: 'INSERT INTO users (username, password_hash, avatar_color) VALUES (?, ?, ?)',
    args: [username, passwordHash, avatarColor],
  });
  return getUserById(Number(r.lastInsertRowid));
}

async function updateUserPassword(id, hash) {
  await client.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [hash, Number(id)] });
}

async function updateUserAvatarColor(id, color) {
  await client.execute({ sql: 'UPDATE users SET avatar_color = ? WHERE id = ?', args: [color, Number(id)] });
}

async function deleteUser(id) {
  const uid = Number(id);
  await client.batch(
    [
      { sql: 'DELETE FROM logs WHERE user_id = ?', args: [uid] },
      { sql: 'DELETE FROM tasks WHERE user_id = ?', args: [uid] },
      { sql: 'DELETE FROM users WHERE id = ?', args: [uid] },
    ],
    'write'
  );
}

// ---------- tasks ----------

function taskView(row) {
  return {
    id: row.id,
    name: row.name,
    points: row.points,
    category: row.category,
    sort_order: row.sort_order,
    is_default: row.is_default,
  };
}

async function getTasks(userId) {
  const r = await client.execute({
    sql: 'SELECT id, name, points, category, sort_order, is_default FROM tasks WHERE user_id = ? ORDER BY sort_order, id',
    args: [Number(userId)],
  });
  return r.rows.map(taskView);
}

async function getTaskById(id) {
  const tid = toId(id);
  if (tid === null) return undefined;
  const r = await client.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [tid] });
  return r.rows[0];
}

async function getTaskForUser(id, userId) {
  const tid = toId(id);
  if (tid === null) return undefined;
  const r = await client.execute({
    sql: 'SELECT * FROM tasks WHERE id = ? AND user_id = ?',
    args: [tid, Number(userId)],
  });
  return r.rows[0];
}

async function getMaxSortOrder(userId) {
  const r = await client.execute({
    sql: 'SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE user_id = ?',
    args: [Number(userId)],
  });
  return r.rows[0].m;
}

async function insertTask(userId, name, points, category, sortOrder) {
  const r = await client.execute({
    sql: 'INSERT INTO tasks (user_id, name, points, category, sort_order) VALUES (?, ?, ?, ?, ?)',
    args: [Number(userId), name, points, category, sortOrder],
  });
  return taskView(await getTaskById(Number(r.lastInsertRowid)));
}

// Deleting a task sets task_id to NULL on its logs (history keeps earned
// points) instead of cascading the delete.
async function deleteTask(id, userId) {
  const tid = toId(id);
  if (tid === null) return false;
  const uid = Number(userId);
  const existing = await client.execute({
    sql: 'SELECT id FROM tasks WHERE id = ? AND user_id = ?',
    args: [tid, uid],
  });
  if (existing.rows.length === 0) return false;
  await client.batch(
    [
      { sql: 'UPDATE logs SET task_id = NULL WHERE task_id = ?', args: [tid] },
      { sql: 'DELETE FROM tasks WHERE id = ? AND user_id = ?', args: [tid, uid] },
    ],
    'write'
  );
  return true;
}

// Applies a batch of {id, sort_order} updates in one transaction (used for reordering).
async function reorderTasks(updates) {
  await client.batch(
    updates.map(({ id, sort_order }) => ({
      sql: 'UPDATE tasks SET sort_order = ? WHERE id = ?',
      args: [sort_order, id],
    })),
    'write'
  );
}

// ---------- logs ----------

async function getLogsForDate(userId, date) {
  const r = await client.execute({
    sql: 'SELECT task_id, points_earned, is_bonus FROM logs WHERE user_id = ? AND logged_date = ?',
    args: [Number(userId), date],
  });
  return r.rows;
}

async function getLogForTaskDate(userId, taskId, date) {
  const tid = toId(taskId);
  if (tid === null) return undefined;
  const r = await client.execute({
    sql: 'SELECT id FROM logs WHERE user_id = ? AND task_id = ? AND logged_date = ?',
    args: [Number(userId), tid, date],
  });
  return r.rows[0];
}

async function getBonusLog(userId, date) {
  const r = await client.execute({
    sql: 'SELECT id FROM logs WHERE user_id = ? AND logged_date = ? AND is_bonus = 1',
    args: [Number(userId), date],
  });
  return r.rows[0];
}

async function insertLog(userId, taskId, date, points, isBonus) {
  await client.execute({
    sql: `INSERT INTO logs (user_id, task_id, logged_date, points_earned, is_bonus)
          VALUES (?, ?, ?, ?, ?)`,
    args: [Number(userId), taskId === null ? null : Number(taskId), date, points, isBonus],
  });
}

async function deleteLogById(id) {
  await client.execute({ sql: 'DELETE FROM logs WHERE id = ?', args: [Number(id)] });
}

async function deleteLogForTaskDate(userId, taskId, date) {
  const tid = toId(taskId);
  if (tid === null) return false;
  const r = await client.execute({
    sql: 'DELETE FROM logs WHERE user_id = ? AND task_id = ? AND logged_date = ? AND is_bonus = 0',
    args: [Number(userId), tid, date],
  });
  return r.rowsAffected > 0;
}

async function getDistinctLogDates(userId) {
  const r = await client.execute({
    sql: 'SELECT DISTINCT logged_date AS d FROM logs WHERE user_id = ? ORDER BY d',
    args: [Number(userId)],
  });
  return r.rows.map((row) => row.d);
}

async function totalPoints(userId) {
  const r = await client.execute({
    sql: 'SELECT COALESCE(SUM(points_earned), 0) AS t FROM logs WHERE user_id = ?',
    args: [Number(userId)],
  });
  return r.rows[0].t;
}

async function sumPointsByDateRange(userId, from, to) {
  const r = await client.execute({
    sql: `SELECT logged_date AS d, SUM(points_earned) AS pts FROM logs
          WHERE user_id = ? AND logged_date BETWEEN ? AND ? GROUP BY logged_date`,
    args: [Number(userId), from, to],
  });
  const map = {};
  for (const row of r.rows) map[row.d] = row.pts;
  return map;
}

async function countCompletedLogsInRange(userId, from, to) {
  const r = await client.execute({
    sql: `SELECT COUNT(*) AS c FROM logs
          WHERE user_id = ? AND is_bonus = 0 AND logged_date BETWEEN ? AND ?`,
    args: [Number(userId), from, to],
  });
  return r.rows[0].c;
}

async function getBestDay(userId) {
  const r = await client.execute({
    sql: `SELECT logged_date AS date, SUM(points_earned) AS points FROM logs
          WHERE user_id = ? GROUP BY logged_date ORDER BY points DESC, date DESC LIMIT 1`,
    args: [Number(userId)],
  });
  return r.rows[0] || null;
}

async function getTaskCompletionStats(userId, from, to) {
  const r = await client.execute({
    sql: `SELECT t.id AS task_id, t.name, t.category,
                 COUNT(DISTINCT l.logged_date) AS completed_days
          FROM tasks t
          LEFT JOIN logs l ON l.task_id = t.id
            AND l.user_id = t.user_id
            AND l.is_bonus = 0
            AND l.logged_date BETWEEN ? AND ?
          WHERE t.user_id = ?
          GROUP BY t.id, t.name, t.category
          ORDER BY completed_days DESC, t.sort_order`,
    args: [from, to, Number(userId)],
  });
  return r.rows;
}

async function getDayOfWeekPoints(userId, from, to) {
  const r = await client.execute({
    sql: `SELECT CAST(strftime('%w', logged_date) AS INTEGER) AS dow,
                 SUM(points_earned) AS total_points,
                 COUNT(DISTINCT logged_date) AS day_count
          FROM logs
          WHERE user_id = ? AND logged_date BETWEEN ? AND ?
          GROUP BY dow`,
    args: [Number(userId), from, to],
  });
  return r.rows;
}

async function countTasks(userId) {
  const r = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM tasks WHERE user_id = ?', args: [Number(userId)] });
  return r.rows[0].c;
}

// ---------- default tasks ----------

const DEFAULT_TASKS = [
  { name: 'Wake up on time',       points: 10, category: 'Morning routine' },
  { name: 'Brush teeth – morning', points: 5,  category: 'Morning routine' },
  { name: 'Make bed',              points: 5,  category: 'Morning routine' },
  { name: 'Eat breakfast',         points: 5,  category: 'Morning routine' },
  { name: 'Get dressed',           points: 5,  category: 'Morning routine' },
  { name: 'Do homework',           points: 20, category: 'Homework' },
  { name: 'Read for 20 min',       points: 15, category: 'Reading' },
  { name: 'Exercise / sport',      points: 20, category: 'Exercise' },
  { name: 'Tidy room',             points: 10, category: 'Chores' },
  { name: 'Brush teeth – night',   points: 5,  category: 'Evening routine' },
  { name: 'In bed on time',        points: 10, category: 'Evening routine' },
];

async function seedDefaultTasks(userId) {
  await client.batch(
    DEFAULT_TASKS.map((t, i) => ({
      sql: 'INSERT INTO tasks (user_id, name, points, category, sort_order, is_default) VALUES (?, ?, ?, ?, ?, 1)',
      args: [Number(userId), t.name, t.points, t.category, i],
    })),
    'write'
  );
}

module.exports = {
  client,
  init,
  getUserById,
  getUserByUsername,
  insertUser,
  updateUserPassword,
  updateUserAvatarColor,
  deleteUser,
  getTasks,
  getTaskById,
  getTaskForUser,
  getMaxSortOrder,
  insertTask,
  deleteTask,
  reorderTasks,
  getLogsForDate,
  getLogForTaskDate,
  getBonusLog,
  insertLog,
  deleteLogById,
  deleteLogForTaskDate,
  getDistinctLogDates,
  totalPoints,
  sumPointsByDateRange,
  countCompletedLogsInRange,
  getBestDay,
  countTasks,
  seedDefaultTasks,
  getTaskCompletionStats,
  getDayOfWeekPoints,
};
