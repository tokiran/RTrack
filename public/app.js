'use strict';

// ==================== state ====================

let token = localStorage.getItem('token');
let currentUser = null;
let tasks = [];
let today = { date: null, completedTaskIds: [], pointsToday: 0, bonusAwarded: false };
let viewDate = localDateStr();
let editingTasks = false;
let statsRange = 'week';
let chart = null;
let trendsChart = null;
let dowChart = null;

const AVATAR_COLORS = ['#3B82F6', '#22C55E', '#8B5CF6', '#F59E0B', '#06B6D4', '#EC4899'];
const CATEGORY_ICONS = {
  'Morning routine': '🌅',
  Homework: '📚',
  Chores: '🧹',
  Exercise: '⚽',
  Reading: '📖',
  'Evening routine': '🌙',
  Custom: '⭐',
};

const $ = (id) => document.getElementById(id);

// ==================== api ====================

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch('/api' + path, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    throw new Error("Can't reach the server. Check your connection!");
  }
  if (res.status === 401 && token) {
    logout();
    showToast('Your session expired — please log in again.');
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ==================== helpers ====================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function localDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clientAddDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function dateNavLabel(dateStr) {
  const tod = localDateStr();
  if (dateStr === tod) return 'Today';
  if (dateStr === clientAddDays(tod, -1)) return 'Yesterday';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function setLoading(btn, loading) {
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearError(id) {
  $(id).classList.add('hidden');
}

let toastTimer = null;
function showToast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function showConfirm({ title, message, confirmLabel = 'Delete', onConfirm }) {
  $('modal-title').textContent = title;
  $('modal-message').textContent = message;
  $('modal-confirm').textContent = confirmLabel;
  $('modal-overlay').classList.remove('hidden');
  $('modal-confirm').onclick = () => {
    closeModal();
    onConfirm();
  };
}

function closeModal() {
  $('modal-overlay').classList.add('hidden');
}

// ==================== routing ====================

const SCREENS = ['login', 'register', 'dashboard', 'stats', 'profile'];

function showScreen(name) {
  $('splash').classList.add('hidden');
  for (const s of SCREENS) {
    const el = $('screen-' + s);
    el.classList.toggle('hidden', s !== name);
    if (s === name) {
      // retrigger the slide-in animation
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    }
  }
  const loggedInScreen = ['dashboard', 'stats', 'profile'].includes(name);
  $('bottom-nav').classList.toggle('hidden', !loggedInScreen);
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === name);
  });
  if (name === 'dashboard') { viewDate = localDateStr(); loadDashboard(); }
  if (name === 'stats') loadStats();
  if (name === 'profile') renderProfile();
}

// ==================== auth ====================

function logout() {
  token = null;
  currentUser = null;
  tasks = [];
  localStorage.removeItem('token');
  showScreen('login');
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError('login-error');
  const btn = e.target.querySelector('button[type=submit]');
  setLoading(btn, true);
  try {
    const data = await api('/login', {
      method: 'POST',
      body: {
        username: $('login-username').value.trim(),
        password: $('login-password').value,
      },
    });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('token', token);
    e.target.reset();
    showScreen('dashboard');
  } catch (err) {
    showError('login-error', err.message);
  } finally {
    setLoading(btn, false);
  }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError('register-error');
  const username = $('register-username').value.trim();
  const password = $('register-password').value;
  const confirm = $('register-confirm').value;

  if (!/^[a-zA-Z0-9]{3,20}$/.test(username)) {
    return showError('register-error', 'Username must be 3–20 letters or numbers (no spaces or symbols).');
  }
  if (password.length < 8) {
    return showError('register-error', 'Password must be at least 8 characters long.');
  }
  if (password !== confirm) {
    return showError('register-error', "Those passwords don't match.");
  }

  const btn = e.target.querySelector('button[type=submit]');
  setLoading(btn, true);
  try {
    const data = await api('/register', { method: 'POST', body: { username, password } });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('token', token);
    e.target.reset();
    showScreen('dashboard');
  } catch (err) {
    showError('register-error', err.message);
  } finally {
    setLoading(btn, false);
  }
});

$('goto-register').addEventListener('click', (e) => {
  e.preventDefault();
  clearError('login-error');
  showScreen('register');
});

$('goto-login').addEventListener('click', (e) => {
  e.preventDefault();
  clearError('register-error');
  showScreen('login');
});

// ==================== dashboard ====================

async function loadDashboard() {
  renderHeader();
  updateDateNav();
  try {
    const [taskData, dayData] = await Promise.all([
      api('/tasks'),
      api(`/log?date=${viewDate}`),
    ]);
    tasks = taskData.tasks;
    today = dayData;
    renderTaskList();
    renderTodaySummary();
    await refreshStreak();
  } catch (err) {
    if (err.message !== 'Session expired') {
      $('task-list').innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }
}

function updateDateNav() {
  $('date-nav-label').textContent = dateNavLabel(viewDate);
  $('date-next').disabled = viewDate >= localDateStr();
  $('tasks-heading').textContent =
    viewDate === localDateStr() ? "Today's tasks" : `Tasks — ${dateNavLabel(viewDate)}`;
}

function renderHeader() {
  if (!currentUser) return;
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $('greeting').textContent = `${part}, ${currentUser.username}! 👋`;
  const [y, m, d] = viewDate.split('-').map(Number);
  $('today-date').textContent = new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const av = $('header-avatar');
  av.textContent = currentUser.username.slice(0, 2).toUpperCase();
  av.style.background = currentUser.avatarColor;
}

function renderTodaySummary() {
  $('points-today').textContent = today.pointsToday;
  $('points-label').textContent = viewDate === localDateStr() ? 'points today' : 'points earned';
  $('bonus-banner').classList.toggle('hidden', !today.bonusAwarded);
}

async function refreshStreak() {
  try {
    const s = await api('/stats/summary');
    $('streak-count').textContent = s.currentStreak;
  } catch {
    /* non-critical */
  }
}

function renderTaskList() {
  const list = $('task-list');
  list.classList.toggle('editing', editingTasks);
  if (tasks.length === 0) {
    list.innerHTML = '<p class="subtle" style="text-align:center;padding:20px">No tasks yet — tap ✏️ Edit to add one!</p>';
    return;
  }
  const done = new Set(today.completedTaskIds);
  let html = '';
  let lastCategory = null;
  for (const t of tasks) {
    if (t.category !== lastCategory) {
      html += `<div class="category-label">${CATEGORY_ICONS[t.category] || '⭐'} ${escapeHtml(t.category)}</div>`;
      lastCategory = t.category;
    }
    const isDone = done.has(t.id);
    html += `
      <div class="task-row ${isDone ? 'done' : ''}" data-id="${t.id}">
        <button class="task-check" aria-label="Mark ${escapeHtml(t.name)} ${isDone ? 'not done' : 'done'}">✓</button>
        <div class="task-info"><div class="task-name">${escapeHtml(t.name)}</div></div>
        <span class="task-points">+${t.points}</span>
        <div class="task-edit-controls">
          <button class="icon-btn move-up" aria-label="Move up">⬆️</button>
          <button class="icon-btn move-down" aria-label="Move down">⬇️</button>
          <button class="icon-btn delete" aria-label="Delete task">🗑️</button>
        </div>
      </div>`;
  }
  list.innerHTML = html;
}

$('task-list').addEventListener('click', (e) => {
  const row = e.target.closest('.task-row');
  if (!row) return;
  const taskId = Number(row.dataset.id);
  if (e.target.closest('.task-check')) return toggleTask(taskId, row);
  if (e.target.closest('.move-up')) return moveTask(taskId, 'up');
  if (e.target.closest('.move-down')) return moveTask(taskId, 'down');
  if (e.target.closest('.delete')) return confirmDeleteTask(taskId);
});

async function toggleTask(taskId, row) {
  const wasDone = today.completedTaskIds.includes(taskId);
  row.classList.add('busy');
  try {
    today = wasDone
      ? await api(`/log/${taskId}?date=${viewDate}`, { method: 'DELETE' })
      : await api('/log', { method: 'POST', body: { taskId, date: viewDate } });
    row.classList.remove('busy');
    row.classList.toggle('done', !wasDone);
    if (!wasDone) {
      const check = row.querySelector('.task-check');
      check.classList.add('pop');
      check.addEventListener('animationend', () => check.classList.remove('pop'), { once: true });
    }
    renderTodaySummary();
    refreshStreak();
  } catch (err) {
    row.classList.remove('busy');
    if (err.message !== 'Session expired') showToast(err.message);
  }
}

async function moveTask(taskId, direction) {
  try {
    await api(`/tasks/${taskId}/move`, { method: 'PUT', body: { direction } });
    const data = await api('/tasks');
    tasks = data.tasks;
    renderTaskList();
  } catch (err) {
    if (err.message !== 'Session expired') showToast(err.message);
  }
}

function confirmDeleteTask(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  showConfirm({
    title: 'Delete task?',
    message: `"${task.name}" will be removed from your list. Points you already earned are safe.`,
    onConfirm: async () => {
      try {
        const data = await api('/tasks/' + taskId, { method: 'DELETE' });
        today = viewDate === localDateStr() ? data.today : await api(`/log?date=${viewDate}`);
        tasks = tasks.filter((t) => t.id !== taskId);
        renderTaskList();
        renderTodaySummary();
      } catch (err) {
        if (err.message !== 'Session expired') showToast(err.message);
      }
    },
  });
}

$('edit-tasks-btn').addEventListener('click', () => {
  editingTasks = !editingTasks;
  $('edit-tasks-btn').textContent = editingTasks ? '✅ Done' : '✏️ Edit';
  $('add-task-form').classList.toggle('hidden', !editingTasks);
  renderTaskList();
});

$('date-prev').addEventListener('click', () => {
  viewDate = clientAddDays(viewDate, -1);
  editingTasks = false;
  $('edit-tasks-btn').textContent = '✏️ Edit';
  $('add-task-form').classList.add('hidden');
  loadDashboard();
});

$('date-next').addEventListener('click', () => {
  if (viewDate >= localDateStr()) return;
  viewDate = clientAddDays(viewDate, 1);
  editingTasks = false;
  $('edit-tasks-btn').textContent = '✏️ Edit';
  $('add-task-form').classList.add('hidden');
  loadDashboard();
});

$('add-task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError('add-task-error');
  const name = $('new-task-name').value.trim();
  if (!name) return showError('add-task-error', 'Give your task a name!');
  const btn = e.target.querySelector('button[type=submit]');
  setLoading(btn, true);
  try {
    const data = await api('/tasks', {
      method: 'POST',
      body: {
        name,
        points: Number($('new-task-points').value),
        category: $('new-task-category').value,
      },
    });
    tasks.push(data.task);
    tasks.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    today = viewDate === localDateStr() ? data.today : await api(`/log?date=${viewDate}`);
    $('new-task-name').value = '';
    renderTaskList();
    renderTodaySummary();
    showToast('Task added! 🎉');
  } catch (err) {
    if (err.message !== 'Session expired') showError('add-task-error', err.message);
  } finally {
    setLoading(btn, false);
  }
});

// ==================== stats ====================

async function loadStats() {
  clearError('stats-error');
  if (statsRange === 'trends') return loadTrends();
  $('chart-loading').classList.remove('hidden');
  try {
    const [range, summary] = await Promise.all([
      api(statsRange === 'week' ? '/stats/week' : '/stats/month'),
      api('/stats/summary'),
    ]);
    renderChart(range);
    $('stat-total').textContent = summary.totalPoints;
    $('stat-best-day').textContent = summary.bestDay ? summary.bestDay.points : 0;
    $('stat-completion').textContent = summary.completionRate + '%';
    $('stat-best-streak').textContent = summary.bestStreak + '🔥';
  } catch (err) {
    if (err.message !== 'Session expired') showError('stats-error', err.message);
  } finally {
    $('chart-loading').classList.add('hidden');
  }
}

async function loadTrends() {
  $('trends-loading').classList.remove('hidden');
  try {
    const data = await api('/stats/trends');
    renderTrendChart(data.dailyPoints);
    renderDowChart(data.dayOfWeek);
    renderTaskCompletion(data.taskStats);
  } catch (err) {
    if (err.message !== 'Session expired') showError('stats-error', err.message);
  } finally {
    $('trends-loading').classList.add('hidden');
  }
}

function renderTrendChart(dailyPoints) {
  const labels = dailyPoints.map((d) => d.label);
  const values = dailyPoints.map((d) => d.points);
  if (trendsChart) trendsChart.destroy();
  trendsChart = new Chart($('trends-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#8B5CF6',
        backgroundColor: 'rgba(139,92,246,0.1)',
        borderWidth: 2,
        pointRadius: 3,
        tension: 0.35,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
      },
    },
  });
}

function renderDowChart(dayOfWeek) {
  // Display Mon–Sun order (strftime %w gives Sun=0)
  const ordered = [1, 2, 3, 4, 5, 6, 0].map((dow) => dayOfWeek[dow]);
  const labels = ordered.map((d) => d.label);
  const values = ordered.map((d) => d.avgPoints);
  const max = Math.max(...values);
  const colors = values.map((v) => (v === max && v > 0 ? '#8B5CF6' : '#3B82F6'));
  if (dowChart) dowChart.destroy();
  dowChart = new Chart($('dow-chart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderRadius: 6,
        maxBarThickness: 36,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderTaskCompletion(taskStats) {
  const container = $('task-completion-list');
  if (taskStats.length === 0) {
    container.innerHTML = '<p class="subtle" style="padding:12px 0">No tasks yet.</p>';
    return;
  }
  container.innerHTML = taskStats.map((t) => `
    <div class="completion-row">
      <div class="completion-header">
        <span class="completion-name">${escapeHtml(t.name)}</span>
        <span class="completion-rate">${t.rate}%</span>
      </div>
      <div class="completion-bar-bg">
        <div class="completion-bar-fill" style="width:${t.rate}%"></div>
      </div>
      <div class="completion-days">${t.completedDays} of 30 days</div>
    </div>
  `).join('');
}

function renderChart(range) {
  const isWeek = statsRange === 'week';
  const items = isWeek ? range.days : range.weeks;
  const labels = items.map((x) => x.label);
  const values = items.map((x) => x.points);
  const todayLabel = isWeek
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()]
    : null;
  const colors = labels.map((l) =>
    l === todayLabel ? '#8B5CF6' : '#3B82F6'
  );

  if (chart) chart.destroy();
  chart = new Chart($('stats-chart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
          borderRadius: 8,
          maxBarThickness: 40,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
        x: { grid: { display: false } },
      },
    },
  });
}

$('stats-week-btn').addEventListener('click', () => setStatsRange('week'));
$('stats-month-btn').addEventListener('click', () => setStatsRange('month'));
$('stats-trends-btn').addEventListener('click', () => setStatsRange('trends'));

function setStatsRange(range) {
  statsRange = range;
  $('stats-week-btn').classList.toggle('active', range === 'week');
  $('stats-month-btn').classList.toggle('active', range === 'month');
  $('stats-trends-btn').classList.toggle('active', range === 'trends');
  const isTrends = range === 'trends';
  $('chart-card-main').classList.toggle('hidden', isTrends);
  $('stats-grid').classList.toggle('hidden', isTrends);
  $('trends-section').classList.toggle('hidden', !isTrends);
  loadStats();
}

// ==================== profile ====================

function renderProfile() {
  if (!currentUser) return;
  const av = $('profile-avatar');
  av.textContent = currentUser.username.slice(0, 2).toUpperCase();
  av.style.background = currentUser.avatarColor;
  $('profile-username').textContent = currentUser.username;
  $('profile-since').textContent =
    'Member since ' +
    new Date(currentUser.createdAt.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });

  const row = $('color-row');
  row.innerHTML = '';
  for (const color of AVATAR_COLORS) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'color-dot' + (color === currentUser.avatarColor ? ' selected' : '');
    dot.style.background = color;
    dot.setAttribute('aria-label', 'Avatar color ' + color);
    dot.addEventListener('click', async () => {
      try {
        const data = await api('/me/avatar', { method: 'PUT', body: { color } });
        currentUser = data.user;
        renderProfile();
      } catch (err) {
        if (err.message !== 'Session expired') showToast(err.message);
      }
    });
    row.appendChild(dot);
  }
}

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError('password-error');
  $('password-success').classList.add('hidden');
  const current = $('current-password').value;
  const next = $('new-password').value;
  const confirm = $('confirm-new-password').value;
  if (next.length < 8) {
    return showError('password-error', 'New password must be at least 8 characters long.');
  }
  if (next !== confirm) {
    return showError('password-error', "Those passwords don't match.");
  }
  const btn = e.target.querySelector('button[type=submit]');
  setLoading(btn, true);
  try {
    await api('/me/password', {
      method: 'PUT',
      body: { currentPassword: current, newPassword: next },
    });
    e.target.reset();
    $('password-success').classList.remove('hidden');
  } catch (err) {
    if (err.message !== 'Session expired') showError('password-error', err.message);
  } finally {
    setLoading(btn, false);
  }
});

$('logout-btn').addEventListener('click', () => {
  logout();
  showToast("You're logged out. See you soon! 👋");
});

// Tapping the dashboard avatar is a shortcut to the profile screen (logout lives there).
$('header-avatar').addEventListener('click', () => showScreen('profile'));

$('delete-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearError('delete-error');
  const password = $('delete-password').value;
  if (!password) return showError('delete-error', 'Type your password to confirm.');
  showConfirm({
    title: 'Delete your account?',
    message: 'This permanently erases your tasks, points and streaks. There is no undo!',
    confirmLabel: 'Delete forever',
    onConfirm: async () => {
      const btn = $('delete-form').querySelector('button[type=submit]');
      setLoading(btn, true);
      try {
        await api('/me', { method: 'DELETE', body: { password } });
        $('delete-form').reset();
        logout();
        showToast('Your account was deleted. Bye! 👋');
      } catch (err) {
        if (err.message !== 'Session expired') showError('delete-error', err.message);
      } finally {
        setLoading(btn, false);
      }
    },
  });
});

// ==================== modal wiring ====================

$('modal-cancel').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', (e) => {
  if (e.target === $('modal-overlay')) closeModal();
});

// ==================== boot ====================

async function init() {
  if (!token) {
    showScreen('login');
    return;
  }
  try {
    const data = await api('/me');
    currentUser = data.user;
    showScreen('dashboard');
  } catch {
    // api() already cleared the token and showed login on 401;
    // for network errors fall back to login too.
    if (token) logout();
  }
}

init();
