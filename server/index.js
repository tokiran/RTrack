require('dotenv').config();

const path = require('path');
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');

const { db, seedDefaultTasks } = require('./db');
const { signToken } = require('./auth');
const { requireAuth } = require('./middleware');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 12;
const FULL_DAY_BONUS = 25;

const USERNAME_RE = /^[a-zA-Z0-9]{3,20}$/;
const ALLOWED_POINTS = [5, 10, 15, 20, 50];
const CATEGORIES = [
  'Morning routine',
  'Homework',
  'Chores',
  'Exercise',
  'Reading',
  'Evening routine',
  'Custom',
];
const AVATAR_COLORS = ['#3B82F6', '#22C55E', '#8B5CF6', '#F59E0B', '#06B6D4', '#EC4899'];

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a minute and try again.' },
});

// ---------- date helpers (server-local time, YYYY-MM-DD) ----------

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStr() {
  return fmtDate(new Date());
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return fmtDate(dt);
}

// ---------- shared queries ----------

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    avatarColor: row.avatar_color,
    createdAt: row.created_at,
  };
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// Award the +25 full-day bonus when every task is logged for `date`,
// and take it back if the day stops being complete (task unchecked or added).
function updateBonus(userId, date) {
  const taskCount = db
    .prepare('SELECT COUNT(*) AS c FROM tasks WHERE user_id = ?')
    .get(userId).c;
  const doneCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM logs
       WHERE user_id = ? AND logged_date = ? AND is_bonus = 0 AND task_id IS NOT NULL`
    )
    .get(userId, date).c;
  const bonus = db
    .prepare(
      'SELECT id FROM logs WHERE user_id = ? AND logged_date = ? AND is_bonus = 1'
    )
    .get(userId, date);

  const complete = taskCount > 0 && doneCount >= taskCount;
  if (complete && !bonus) {
    db.prepare(
      `INSERT INTO logs (user_id, task_id, logged_date, points_earned, is_bonus)
       VALUES (?, NULL, ?, ?, 1)`
    ).run(userId, date, FULL_DAY_BONUS);
  } else if (!complete && bonus) {
    db.prepare('DELETE FROM logs WHERE id = ?').run(bonus.id);
  }
}

function todayPayload(userId) {
  const date = todayStr();
  const rows = db
    .prepare('SELECT task_id, points_earned, is_bonus FROM logs WHERE user_id = ? AND logged_date = ?')
    .all(userId, date);
  return {
    date,
    completedTaskIds: rows.filter((r) => !r.is_bonus && r.task_id !== null).map((r) => r.task_id),
    pointsToday: rows.reduce((sum, r) => sum + r.points_earned, 0),
    bonusAwarded: rows.some((r) => r.is_bonus === 1),
  };
}

function calcStreaks(userId) {
  const rows = db
    .prepare('SELECT DISTINCT logged_date AS d FROM logs WHERE user_id = ? ORDER BY d')
    .all(userId)
    .map((r) => r.d);
  const dates = new Set(rows);

  // Current streak counts back from today; an unlogged today doesn't break
  // it yet (the streak only resets after a full day with zero logs).
  let current = 0;
  let cursor = todayStr();
  if (!dates.has(cursor)) cursor = addDays(cursor, -1);
  while (dates.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of rows) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return { current, best };
}

// ==================== auth ====================

app.post('/api/register', authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: 'Username must be 3–20 letters or numbers (no spaces or symbols).',
      });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res
        .status(400)
        .json({ error: 'Password must be at least 8 characters long.' });
    }
    const existing = db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(username);
    if (existing) {
      return res
        .status(409)
        .json({ error: 'That username is already taken. Try another one!' });
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    const info = db
      .prepare(
        'INSERT INTO users (username, password_hash, avatar_color) VALUES (?, ?, ?)'
      )
      .run(username, hash, color);
    seedDefaultTasks(info.lastInsertRowid);

    const user = getUser(info.lastInsertRowid);
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/login', authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const user = db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username);
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// ==================== account ====================

app.get('/api/me', requireAuth, (req, res) => {
  const user = getUser(req.userId);
  if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
  res.json({ user: publicUser(user) });
});

app.put('/api/me/password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res
        .status(400)
        .json({ error: 'New password must be at least 8 characters long.' });
    }
    const user = getUser(req.userId);
    const ok =
      typeof currentPassword === 'string' &&
      (await bcrypt.compare(currentPassword, user.password_hash));
    if (!ok) {
      return res.status(401).json({ error: 'Current password is wrong.' });
    }
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      hash,
      req.userId
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.put('/api/me/avatar', requireAuth, (req, res) => {
  const { color } = req.body || {};
  if (!AVATAR_COLORS.includes(color)) {
    return res.status(400).json({ error: 'Pick one of the available colors.' });
  }
  db.prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run(
    color,
    req.userId
  );
  res.json({ user: publicUser(getUser(req.userId)) });
});

app.delete('/api/me', requireAuth, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    const user = getUser(req.userId);
    const ok =
      typeof password === 'string' &&
      (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      return res
        .status(401)
        .json({ error: 'Password is wrong — account not deleted.' });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(req.userId); // cascades to tasks + logs
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ==================== tasks ====================

app.get('/api/tasks', requireAuth, (req, res) => {
  const tasks = db
    .prepare(
      'SELECT id, name, points, category, sort_order, is_default FROM tasks WHERE user_id = ? ORDER BY sort_order, id'
    )
    .all(req.userId);
  res.json({ tasks });
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const { name, points, category } = req.body || {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > 40) {
    return res
      .status(400)
      .json({ error: 'Task name must be 1–40 characters.' });
  }
  if (!ALLOWED_POINTS.includes(points)) {
    return res
      .status(400)
      .json({ error: 'Points must be 5, 10, 15, 20 or 50.' });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Pick a valid category.' });
  }
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM tasks WHERE user_id = ?')
    .get(req.userId).m;
  const info = db
    .prepare(
      'INSERT INTO tasks (user_id, name, points, category, sort_order) VALUES (?, ?, ?, ?, ?)'
    )
    .run(req.userId, trimmed, points, category, max + 1);
  // A new unchecked task can invalidate today's full-day bonus.
  updateBonus(req.userId, todayStr());
  const task = db
    .prepare('SELECT id, name, points, category, sort_order, is_default FROM tasks WHERE id = ?')
    .get(info.lastInsertRowid);
  res.status(201).json({ task, today: todayPayload(req.userId) });
});

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const info = db
    .prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.userId);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Task not found.' });
  }
  // Removing a task can make today complete.
  updateBonus(req.userId, todayStr());
  res.json({ ok: true, today: todayPayload(req.userId) });
});

app.put('/api/tasks/:id/move', requireAuth, (req, res) => {
  const { direction } = req.body || {};
  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: 'Direction must be "up" or "down".' });
  }
  const tasks = db
    .prepare('SELECT id, sort_order FROM tasks WHERE user_id = ? ORDER BY sort_order, id')
    .all(req.userId);
  const idx = tasks.findIndex((t) => t.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Task not found.' });
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= tasks.length) {
    return res.json({ ok: true }); // already at the edge, nothing to do
  }
  const setOrder = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');
  db.transaction(() => {
    // Normalize sort_order to the list index so swaps stay stable.
    tasks.forEach((t, i) => setOrder.run(i, t.id));
    setOrder.run(swapWith, tasks[idx].id);
    setOrder.run(idx, tasks[swapWith].id);
  })();
  res.json({ ok: true });
});

// ==================== daily log ====================

app.get('/api/log/today', requireAuth, (req, res) => {
  res.json(todayPayload(req.userId));
});

app.post('/api/log', requireAuth, (req, res) => {
  const { taskId } = req.body || {};
  const task = db
    .prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
    .get(taskId, req.userId);
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  const date = todayStr();
  const already = db
    .prepare(
      'SELECT id FROM logs WHERE user_id = ? AND task_id = ? AND logged_date = ?'
    )
    .get(req.userId, task.id, date);
  if (already) {
    return res
      .status(409)
      .json({ error: 'You already checked that one off today!' });
  }
  db.prepare(
    `INSERT INTO logs (user_id, task_id, logged_date, points_earned, is_bonus)
     VALUES (?, ?, ?, ?, 0)`
  ).run(req.userId, task.id, date, task.points);
  updateBonus(req.userId, date);
  res.status(201).json(todayPayload(req.userId));
});

app.delete('/api/log/:taskId', requireAuth, (req, res) => {
  const date = todayStr();
  const info = db
    .prepare(
      'DELETE FROM logs WHERE user_id = ? AND task_id = ? AND logged_date = ? AND is_bonus = 0'
    )
    .run(req.userId, req.params.taskId, date);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'That task is not logged for today.' });
  }
  updateBonus(req.userId, date);
  res.json(todayPayload(req.userId));
});

// ==================== stats ====================

function pointsByDate(userId, from, to) {
  const rows = db
    .prepare(
      `SELECT logged_date AS d, SUM(points_earned) AS pts FROM logs
       WHERE user_id = ? AND logged_date BETWEEN ? AND ? GROUP BY logged_date`
    )
    .all(userId, from, to);
  const map = {};
  for (const r of rows) map[r.d] = r.pts;
  return map;
}

app.get('/api/stats/week', requireAuth, (req, res) => {
  const today = todayStr();
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0 = Sunday
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const map = pointsByDate(req.userId, monday, addDays(monday, 6));
  const days = labels.map((label, i) => {
    const date = addDays(monday, i);
    return { date, label, points: map[date] || 0 };
  });
  res.json({ days, total: days.reduce((s, x) => s + x.points, 0) });
});

app.get('/api/stats/month', requireAuth, (req, res) => {
  const today = todayStr();
  const [y, m] = today.split('-').map(Number);
  const monthStart = `${today.slice(0, 7)}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const map = pointsByDate(
    req.userId,
    monthStart,
    `${today.slice(0, 7)}-${String(daysInMonth).padStart(2, '0')}`
  );
  // Four buckets: days 1–7, 8–14, 15–21, 22–end of month.
  const weeks = [0, 1, 2, 3].map((w) => {
    const startDay = w * 7 + 1;
    const endDay = w === 3 ? daysInMonth : startDay + 6;
    let points = 0;
    for (let day = startDay; day <= endDay; day++) {
      const date = `${today.slice(0, 7)}-${String(day).padStart(2, '0')}`;
      points += map[date] || 0;
    }
    return { label: `Week ${w + 1}`, points };
  });
  res.json({ weeks, total: weeks.reduce((s, x) => s + x.points, 0) });
});

app.get('/api/stats/summary', requireAuth, (req, res) => {
  const totalPoints =
    db
      .prepare('SELECT COALESCE(SUM(points_earned), 0) AS t FROM logs WHERE user_id = ?')
      .get(req.userId).t;
  const { current, best } = calcStreaks(req.userId);

  const bestDay = db
    .prepare(
      `SELECT logged_date AS date, SUM(points_earned) AS points FROM logs
       WHERE user_id = ? GROUP BY logged_date ORDER BY points DESC, date DESC LIMIT 1`
    )
    .get(req.userId);

  // Completion rate over the last 7 days: tasks checked / tasks possible.
  const taskCount = db
    .prepare('SELECT COUNT(*) AS c FROM tasks WHERE user_id = ?')
    .get(req.userId).c;
  const today = todayStr();
  const weekAgo = addDays(today, -6);
  const done = db
    .prepare(
      `SELECT COUNT(*) AS c FROM logs
       WHERE user_id = ? AND is_bonus = 0 AND logged_date BETWEEN ? AND ?`
    )
    .get(req.userId, weekAgo, today).c;
  const possible = taskCount * 7;
  const completionRate = possible > 0 ? Math.round((done / possible) * 100) : 0;

  res.json({
    totalPoints,
    currentStreak: current,
    bestStreak: best,
    completionRate,
    bestDay: bestDay && bestDay.points > 0 ? bestDay : null,
  });
});

// ==================== fallthrough + errors ====================

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`Routine Tracker running on http://localhost:${PORT}`);
});
