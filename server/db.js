const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function load() {
  if (fs.existsSync(DATA_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      users: loaded.users || [],
      tasks: loaded.tasks || [],
      logs: loaded.logs || [],
      nextId: loaded.nextId || { users: 1, tasks: 1, logs: 1 },
    };
  }
  return { users: [], tasks: [], logs: [], nextId: { users: 1, tasks: 1, logs: 1 } };
}

const data = load();

function save() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function allocId(table) {
  const id = data.nextId[table];
  data.nextId[table] += 1;
  return id;
}

// SQLite's datetime('now') format: "YYYY-MM-DD HH:MM:SS" (UTC).
function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// ---------- users ----------

function getUserById(id) {
  return data.users.find((u) => u.id === Number(id));
}

function getUserByUsername(username) {
  const lower = username.toLowerCase();
  return data.users.find((u) => u.username.toLowerCase() === lower);
}

function insertUser(username, passwordHash, avatarColor) {
  const user = {
    id: allocId('users'),
    username,
    password_hash: passwordHash,
    avatar_color: avatarColor,
    created_at: nowStr(),
  };
  data.users.push(user);
  save();
  return user;
}

function updateUserPassword(id, hash) {
  getUserById(id).password_hash = hash;
  save();
}

function updateUserAvatarColor(id, color) {
  getUserById(id).avatar_color = color;
  save();
}

function deleteUser(id) {
  const uid = Number(id);
  data.users = data.users.filter((u) => u.id !== uid);
  data.tasks = data.tasks.filter((t) => t.user_id !== uid);
  data.logs = data.logs.filter((l) => l.user_id !== uid);
  save();
}

// ---------- tasks ----------

function taskView(t) {
  return {
    id: t.id,
    name: t.name,
    points: t.points,
    category: t.category,
    sort_order: t.sort_order,
    is_default: t.is_default,
  };
}

function getTasks(userId) {
  return data.tasks
    .filter((t) => t.user_id === Number(userId))
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    .map(taskView);
}

function getTaskById(id) {
  return data.tasks.find((t) => t.id === Number(id));
}

function getTaskForUser(id, userId) {
  return data.tasks.find((t) => t.id === Number(id) && t.user_id === Number(userId));
}

function getMaxSortOrder(userId) {
  return data.tasks
    .filter((t) => t.user_id === Number(userId))
    .reduce((max, t) => Math.max(max, t.sort_order), -1);
}

function insertTaskRaw(userId, name, points, category, sortOrder, isDefault) {
  const task = {
    id: allocId('tasks'),
    user_id: Number(userId),
    name,
    points,
    category,
    sort_order: sortOrder,
    is_default: isDefault,
  };
  data.tasks.push(task);
  return task;
}

function insertTask(userId, name, points, category, sortOrder) {
  const task = insertTaskRaw(userId, name, points, category, sortOrder, 0);
  save();
  return taskView(task);
}

// Deleting a task sets task_id to NULL on its logs (history keeps earned
// points) instead of cascading the delete, mirroring the old FK behavior.
function deleteTask(id, userId) {
  const tid = Number(id);
  const before = data.tasks.length;
  data.tasks = data.tasks.filter((t) => !(t.id === tid && t.user_id === Number(userId)));
  const deleted = data.tasks.length < before;
  if (deleted) {
    for (const log of data.logs) {
      if (log.task_id === tid) log.task_id = null;
    }
    save();
  }
  return deleted;
}

// Applies a batch of {id, sort_order} updates in one save (used for reordering).
function reorderTasks(updates) {
  for (const { id, sort_order } of updates) {
    const task = getTaskById(id);
    if (task) task.sort_order = sort_order;
  }
  save();
}

// ---------- logs ----------

function getLogsForDate(userId, date) {
  return data.logs.filter((l) => l.user_id === Number(userId) && l.logged_date === date);
}

function getLogForTaskDate(userId, taskId, date) {
  return data.logs.find(
    (l) => l.user_id === Number(userId) && l.task_id === Number(taskId) && l.logged_date === date
  );
}

function getBonusLog(userId, date) {
  return data.logs.find(
    (l) => l.user_id === Number(userId) && l.logged_date === date && l.is_bonus === 1
  );
}

function insertLog(userId, taskId, date, points, isBonus) {
  const log = {
    id: allocId('logs'),
    user_id: Number(userId),
    task_id: taskId === null ? null : Number(taskId),
    logged_date: date,
    points_earned: points,
    is_bonus: isBonus,
    created_at: nowStr(),
  };
  data.logs.push(log);
  save();
  return log;
}

function deleteLogById(id) {
  data.logs = data.logs.filter((l) => l.id !== id);
  save();
}

function deleteLogForTaskDate(userId, taskId, date) {
  const before = data.logs.length;
  data.logs = data.logs.filter(
    (l) =>
      !(
        l.user_id === Number(userId) &&
        l.task_id === Number(taskId) &&
        l.logged_date === date &&
        l.is_bonus === 0
      )
  );
  const deleted = data.logs.length < before;
  save();
  return deleted;
}

function getDistinctLogDates(userId) {
  const set = new Set(data.logs.filter((l) => l.user_id === Number(userId)).map((l) => l.logged_date));
  return [...set].sort();
}

function totalPoints(userId) {
  return data.logs
    .filter((l) => l.user_id === Number(userId))
    .reduce((sum, l) => sum + l.points_earned, 0);
}

function sumPointsByDateRange(userId, from, to) {
  const map = {};
  for (const l of data.logs) {
    if (l.user_id === Number(userId) && l.logged_date >= from && l.logged_date <= to) {
      map[l.logged_date] = (map[l.logged_date] || 0) + l.points_earned;
    }
  }
  return map;
}

function countCompletedLogsInRange(userId, from, to) {
  return data.logs.filter(
    (l) =>
      l.user_id === Number(userId) &&
      l.is_bonus === 0 &&
      l.logged_date >= from &&
      l.logged_date <= to
  ).length;
}

function getBestDay(userId) {
  const map = {};
  for (const l of data.logs) {
    if (l.user_id === Number(userId)) {
      map[l.logged_date] = (map[l.logged_date] || 0) + l.points_earned;
    }
  }
  const entries = Object.entries(map).map(([date, points]) => ({ date, points }));
  entries.sort((a, b) => b.points - a.points || b.date.localeCompare(a.date));
  return entries[0] || null;
}

function countTasks(userId) {
  return data.tasks.filter((t) => t.user_id === Number(userId)).length;
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

function seedDefaultTasks(userId) {
  DEFAULT_TASKS.forEach((t, i) => {
    insertTaskRaw(userId, t.name, t.points, t.category, i, 1);
  });
  save();
}

module.exports = {
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
};
