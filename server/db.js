const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  avatar_color  TEXT NOT NULL DEFAULT '#3B82F6',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  points     INTEGER NOT NULL,
  category   TEXT NOT NULL DEFAULT 'Custom',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  logged_date   TEXT NOT NULL,
  points_earned INTEGER NOT NULL,
  is_bonus      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, task_id, logged_date)
);

CREATE INDEX IF NOT EXISTS idx_logs_user_date ON logs(user_id, logged_date);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
`);

// task_id is NULL for the daily "full day bonus" row (is_bonus = 1) and for
// logs whose task was later deleted (history keeps its earned points).

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

const insertTask = db.prepare(
  `INSERT INTO tasks (user_id, name, points, category, sort_order, is_default)
   VALUES (?, ?, ?, ?, ?, 1)`
);

const seedDefaultTasks = db.transaction((userId) => {
  DEFAULT_TASKS.forEach((t, i) => {
    insertTask.run(userId, t.name, t.points, t.category, i);
  });
});

module.exports = { db, seedDefaultTasks };
