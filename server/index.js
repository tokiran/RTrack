require('dotenv').config();

const path = require('path');
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');

const db = require('./db');
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

// Forwards rejected promises from async route handlers to Express's error middleware.
function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(str) {
  if (typeof str !== 'string' || !DATE_RE.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() + 1 !== m || dt.getDate() !== d) return null;
  return str;
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

// Award the +25 full-day bonus when every task is logged for `date`,
// and take it back if the day stops being complete (task unchecked or added).
async function updateBonus(userId, date) {
  const taskCount = await db.countTasks(userId);
  const logs = await db.getLogsForDate(userId, date);
  const doneCount = logs.filter((l) => l.is_bonus === 0 && l.task_id !== null).length;
  const bonus = await db.getBonusLog(userId, date);

  const complete = taskCount > 0 && doneCount >= taskCount;
  if (complete && !bonus) {
    await db.insertLog(userId, null, date, FULL_DAY_BONUS, 1);
  } else if (!complete && bonus) {
    await db.deleteLogById(bonus.id);
  }
}

async function datePayload(userId, date) {
  const rows = await db.getLogsForDate(userId, date);
  return {
    date,
    completedTaskIds: rows.filter((r) => !r.is_bonus && r.task_id !== null).map((r) => r.task_id),
    pointsToday: rows.reduce((sum, r) => sum + r.points_earned, 0),
    bonusAwarded: rows.some((r) => r.is_bonus === 1),
  };
}

async function todayPayload(userId) {
  return datePayload(userId, todayStr());
}

async function calcStreaks(userId) {
  const rows = await db.getDistinctLogDates(userId);
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

app.post('/api/register', authLimiter, asyncHandler(async (req, res) => {
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
  const existing = await db.getUserByUsername(username);
  if (existing) {
    return res
      .status(409)
      .json({ error: 'That username is already taken. Try another one!' });
  }
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const user = await db.insertUser(username, hash, color);
  await db.seedDefaultTasks(user.id);

  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

app.post('/api/login', authLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = await db.getUserByUsername(username);
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
}));

// ==================== account ====================

app.get('/api/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await db.getUserById(req.userId);
  if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
  res.json({ user: publicUser(user) });
}));

app.put('/api/me/password', requireAuth, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res
      .status(400)
      .json({ error: 'New password must be at least 8 characters long.' });
  }
  const user = await db.getUserById(req.userId);
  const ok =
    typeof currentPassword === 'string' &&
    (await bcrypt.compare(currentPassword, user.password_hash));
  if (!ok) {
    return res.status(401).json({ error: 'Current password is wrong.' });
  }
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await db.updateUserPassword(req.userId, hash);
  res.json({ ok: true });
}));

app.put('/api/me/avatar', requireAuth, asyncHandler(async (req, res) => {
  const { color } = req.body || {};
  if (!AVATAR_COLORS.includes(color)) {
    return res.status(400).json({ error: 'Pick one of the available colors.' });
  }
  await db.updateUserAvatarColor(req.userId, color);
  res.json({ user: publicUser(await db.getUserById(req.userId)) });
}));

app.delete('/api/me', requireAuth, asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  const user = await db.getUserById(req.userId);
  const ok =
    typeof password === 'string' &&
    (await bcrypt.compare(password, user.password_hash));
  if (!ok) {
    return res
      .status(401)
      .json({ error: 'Password is wrong — account not deleted.' });
  }
  await db.deleteUser(req.userId); // also removes tasks + logs
  res.json({ ok: true });
}));

// ==================== tasks ====================

app.get('/api/tasks', requireAuth, asyncHandler(async (req, res) => {
  res.json({ tasks: await db.getTasks(req.userId) });
}));

app.post('/api/tasks', requireAuth, asyncHandler(async (req, res) => {
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
  const max = await db.getMaxSortOrder(req.userId);
  const task = await db.insertTask(req.userId, trimmed, points, category, max + 1);
  // A new unchecked task can invalidate today's full-day bonus.
  await updateBonus(req.userId, todayStr());
  res.status(201).json({ task, today: await todayPayload(req.userId) });
}));

app.delete('/api/tasks/:id', requireAuth, asyncHandler(async (req, res) => {
  const deleted = await db.deleteTask(req.params.id, req.userId);
  if (!deleted) {
    return res.status(404).json({ error: 'Task not found.' });
  }
  // Removing a task can make today complete.
  await updateBonus(req.userId, todayStr());
  res.json({ ok: true, today: await todayPayload(req.userId) });
}));

app.put('/api/tasks/:id/move', requireAuth, asyncHandler(async (req, res) => {
  const { direction } = req.body || {};
  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: 'Direction must be "up" or "down".' });
  }
  const tasks = await db.getTasks(req.userId);
  const idx = tasks.findIndex((t) => t.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Task not found.' });
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= tasks.length) {
    return res.json({ ok: true }); // already at the edge, nothing to do
  }
  // Normalize sort_order to the list index, then swap the two affected tasks.
  const updates = tasks.map((t, i) => ({ id: t.id, sort_order: i }));
  [updates[idx].sort_order, updates[swapWith].sort_order] = [
    updates[swapWith].sort_order,
    updates[idx].sort_order,
  ];
  await db.reorderTasks(updates);
  res.json({ ok: true });
}));

// ==================== daily log ====================

app.get('/api/log', requireAuth, asyncHandler(async (req, res) => {
  const date = req.query.date ? parseDate(req.query.date) : todayStr();
  if (!date) return res.status(400).json({ error: 'Invalid date.' });
  if (date > todayStr()) return res.status(400).json({ error: 'Cannot view logs for a future date.' });
  res.json(await datePayload(req.userId, date));
}));

app.post('/api/log', requireAuth, asyncHandler(async (req, res) => {
  const { taskId, date: rawDate } = req.body || {};
  const task = await db.getTaskForUser(taskId, req.userId);
  if (!task) return res.status(404).json({ error: 'Task not found.' });

  const date = rawDate ? parseDate(rawDate) : todayStr();
  if (!date) return res.status(400).json({ error: 'Invalid date.' });
  if (date > todayStr()) return res.status(400).json({ error: 'Cannot log tasks for a future date.' });

  const already = await db.getLogForTaskDate(req.userId, task.id, date);
  if (already) {
    return res.status(409).json({ error: 'You already checked that one off!' });
  }
  await db.insertLog(req.userId, task.id, date, task.points, 0);
  await updateBonus(req.userId, date);
  res.status(201).json(await datePayload(req.userId, date));
}));

app.delete('/api/log/:taskId', requireAuth, asyncHandler(async (req, res) => {
  const rawDate = req.query.date;
  const date = rawDate ? parseDate(rawDate) : todayStr();
  if (!date) return res.status(400).json({ error: 'Invalid date.' });
  if (date > todayStr()) return res.status(400).json({ error: 'Cannot unlog tasks for a future date.' });

  const deleted = await db.deleteLogForTaskDate(req.userId, req.params.taskId, date);
  if (!deleted) {
    return res.status(404).json({ error: 'That task is not logged for this date.' });
  }
  await updateBonus(req.userId, date);
  res.json(await datePayload(req.userId, date));
}));

// ==================== stats ====================

app.get('/api/stats/week', requireAuth, asyncHandler(async (req, res) => {
  const today = todayStr();
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0 = Sunday
  const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const map = await db.sumPointsByDateRange(req.userId, monday, addDays(monday, 6));
  const days = labels.map((label, i) => {
    const date = addDays(monday, i);
    return { date, label, points: map[date] || 0 };
  });
  res.json({ days, total: days.reduce((s, x) => s + x.points, 0) });
}));

app.get('/api/stats/month', requireAuth, asyncHandler(async (req, res) => {
  const today = todayStr();
  const [y, m] = today.split('-').map(Number);
  const monthStart = `${today.slice(0, 7)}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const map = await db.sumPointsByDateRange(
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
}));

app.get('/api/stats/summary', requireAuth, asyncHandler(async (req, res) => {
  const totalPoints = await db.totalPoints(req.userId);
  const { current, best } = await calcStreaks(req.userId);
  const bestDay = await db.getBestDay(req.userId);

  // Completion rate over the last 7 days: tasks checked / tasks possible.
  const taskCount = await db.countTasks(req.userId);
  const today = todayStr();
  const weekAgo = addDays(today, -6);
  const done = await db.countCompletedLogsInRange(req.userId, weekAgo, today);
  const possible = taskCount * 7;
  const completionRate = possible > 0 ? Math.round((done / possible) * 100) : 0;

  res.json({
    totalPoints,
    currentStreak: current,
    bestStreak: best,
    completionRate,
    bestDay: bestDay && bestDay.points > 0 ? bestDay : null,
  });
}));

app.get('/api/stats/trends', requireAuth, asyncHandler(async (req, res) => {
  const today = todayStr();
  const from = addDays(today, -29);

  const map = await db.sumPointsByDateRange(req.userId, from, today);
  const dailyPoints = [];
  for (let i = 0; i < 30; i++) {
    const date = addDays(from, i);
    const [, m, d] = date.split('-');
    dailyPoints.push({ date, label: `${parseInt(m)}/${parseInt(d)}`, points: map[date] || 0 });
  }

  const taskRows = await db.getTaskCompletionStats(req.userId, from, today);
  const taskStats = taskRows.map((r) => ({
    taskId: r.task_id,
    name: r.name,
    category: r.category,
    completedDays: Number(r.completed_days),
    rate: Math.round((Number(r.completed_days) / 30) * 100),
  }));

  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dowRows = await db.getDayOfWeekPoints(req.userId, from, today);
  const dowMap = {};
  for (const row of dowRows) dowMap[Number(row.dow)] = row;
  const dayOfWeek = DOW_LABELS.map((label, dow) => {
    const row = dowMap[dow];
    return {
      dow,
      label,
      avgPoints: row ? Math.round(Number(row.total_points) / Number(row.day_count)) : 0,
      days: row ? Number(row.day_count) : 0,
    };
  });

  res.json({ dailyPoints, taskStats, dayOfWeek });
}));

// ==================== fallthrough + errors ====================

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Routine Tracker running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
