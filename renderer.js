const { ipcRenderer } = require('electron');
const fs   = require('fs');
const path = require('path');

// Load .env from app root (gitignored — safe to put token here)
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');

let config = {
  notionToken:      process.env.NOTION_TOKEN       || '',   // from .env
  notionDatabaseId: process.env.NOTION_DATABASE_ID || '3807d2c4a614804fb87fd0d683a2c38f',
  assigneeName: '',
  statusFilter: 'Not started',
  fields: {
    taskName: 'Task name',
    assignee: 'Assignee',
    status: 'Status',
    startTime: 'Start Time',
    endTime: 'End Time',
    duration: 'Actual Time Spend',
  }
};

if (fs.existsSync(CONFIG_PATH)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    config = { ...config, ...saved, fields: { ...config.fields, ...(saved.fields || {}) } };
  } catch (e) { /* ignore */ }
}

// ─── STATE ───────────────────────────────────────────────────────────────────
let timerInterval  = null;
let startTime      = null;
let elapsed        = 0;
let isPaused       = false;
let currentBreak   = null;
let breakStart     = null;

let taskQueue      = [];
let currentTask    = null;
let completedTasks = [];
let lastEntry      = null;
let taskStartWall  = null;

let selectedUser   = null;   // { name, taskCount }

// ─── DOM ─────────────────────────────────────────────────────────────────────
const timeDisplay        = document.getElementById('timeDisplay');
const taskLabel          = document.getElementById('taskLabel');
const btnStart           = document.getElementById('btnStart');
const btnPause           = document.getElementById('btnPause');
const btnStop            = document.getElementById('btnStop');
const btnSync            = document.getElementById('btnSync');
const statusText         = document.getElementById('statusText');
const statusUser         = document.getElementById('statusUser');
const queueDots          = document.getElementById('queueDots');
const queueCount         = document.getElementById('queueCount');
const taskDropdown       = document.getElementById('taskDropdown');
const btnRefreshTasks    = document.getElementById('btnRefreshTasks');

const loadingOverlay     = document.getElementById('loadingOverlay');
const loadingMsg         = document.getElementById('loadingMsg');
const manualOverlay      = document.getElementById('manualOverlay');
const manualInput        = document.getElementById('manualInput');
const btnConfirmManual   = document.getElementById('btnConfirmManual');
const btnCancelManual    = document.getElementById('btnCancelManual');
const userPickerOverlay  = document.getElementById('userPickerOverlay');
const userList           = document.getElementById('userList');

const btnMorning         = document.getElementById('btnMorning');
const btnLunch           = document.getElementById('btnLunch');
const btnEvening         = document.getElementById('btnEvening');

// Stats DOM
const statsTodayDate     = document.getElementById('statsTodayDate');
const statsTotalTime     = document.getElementById('statsTotalTime');
const statsTaskCount     = document.getElementById('statsTaskCount');
const statsHistory       = document.getElementById('statsHistory');

// Settings DOM
const settingAssignee    = document.getElementById('settingAssignee');
const settingStatus      = document.getElementById('settingStatus');
const settingDbId        = document.getElementById('settingDbId');
const settingFieldTask   = document.getElementById('settingFieldTask');
const settingFieldAssignee = document.getElementById('settingFieldAssignee');
const settingFieldStatus = document.getElementById('settingFieldStatus');
const settingFieldStart  = document.getElementById('settingFieldStart');
const settingFieldEnd    = document.getElementById('settingFieldEnd');
const settingFieldDuration = document.getElementById('settingFieldDuration');
const btnSaveSettings    = document.getElementById('btnSaveSettings');

// Mini-pill DOM
const miniPill           = document.getElementById('miniPill');
const miniTimeSp         = document.getElementById('miniTime');
const miniTaskSp         = document.getElementById('miniTaskName');
const btnMiniExpand      = document.getElementById('btnMiniExpand');
const btnMiniPause       = document.getElementById('btnMiniPause');
const btnMiniStop        = document.getElementById('btnMiniStop');
const mainWidget         = document.getElementById('mainWidget');

let isMiniMode = false;

// ─── MINI MODE ─────────────────────────────────────────────────────────────────────────
function enterMiniMode(taskName) {
  isMiniMode = true;
  miniTaskSp.textContent = taskName;
  miniTimeSp.textContent = timeDisplay.textContent;
  btnMiniPause.textContent = '\u23f8';
  btnMiniPause.classList.remove('paused');
  miniPill.classList.add('visible');
  mainWidget.style.display = 'none';   // hide entire widget
  ipcRenderer.send('show-mini');
}

function exitMiniMode() {
  isMiniMode = false;
  miniPill.classList.remove('visible');
  mainWidget.style.display = '';       // restore widget
  ipcRenderer.send('show-full');
}

// Drag the mini-pill (reuse same move-window IPC)
let miniDragging = false, miniLastX, miniLastY;
miniPill.addEventListener('mousedown', (e) => {
  // Don't drag if clicking action buttons
  if (e.target.closest('.mini-actions')) return;
  miniDragging = true; miniLastX = e.screenX; miniLastY = e.screenY;
});
document.addEventListener('mousemove', (e) => {
  if (!miniDragging) return;
  ipcRenderer.send('move-window', { dx: e.screenX - miniLastX, dy: e.screenY - miniLastY });
  miniLastX = e.screenX; miniLastY = e.screenY;
});
document.addEventListener('mouseup', () => { miniDragging = false; });

btnMiniExpand.addEventListener('click', () => exitMiniMode());

// Mini pause — toggle pause/resume
btnMiniPause.addEventListener('click', () => {
  if (isPaused) {
    resumeTimer();
    btnMiniPause.textContent = '\u23f8';   // ⏸
    btnMiniPause.classList.remove('paused');
    btnMiniPause.setAttribute('data-tip', 'Pause');
  } else {
    pauseTimer();
    btnMiniPause.textContent = '\u25b6';   // ▶
    btnMiniPause.classList.add('paused');
    btnMiniPause.setAttribute('data-tip', 'Resume');
  }
});

// Mini stop — stop timer and exit mini mode
btnMiniStop.addEventListener('click', () => {
  stopTimer();   // stopTimer already calls exitMiniMode()
});

// ─── TAB SWITCHING ───────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');

    // Tell main process to resize the window for this tab
    ipcRenderer.send('resize-for-tab', tab);

    if (tab === 'stats') renderStats();
    if (tab === 'settings') populateSettings();
  });
});

// ─── WINDOW DRAG ─────────────────────────────────────────────────────────────
let dragging = false, lastX, lastY;
document.getElementById('dragBar').addEventListener('mousedown', (e) => {
  dragging = true; lastX = e.screenX; lastY = e.screenY;
});
document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  ipcRenderer.send('move-window', { dx: e.screenX - lastX, dy: e.screenY - lastY });
  lastX = e.screenX; lastY = e.screenY;
});
document.addEventListener('mouseup', () => { dragging = false; });
document.getElementById('btnClose').addEventListener('click', () => ipcRenderer.send('close-app'));
document.getElementById('btnMin').addEventListener('click', () => ipcRenderer.send('minimize-app'));

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function formatDuration(ms) {
  const totalMins = Math.floor(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function setStatus(msg, type = '') {
  statusText.textContent = msg;
  statusText.className = `status-text ${type}`;
}

function setLoading(msg, show = true) {
  loadingMsg.textContent = msg;
  if (show) loadingOverlay.classList.add('visible');
  else loadingOverlay.classList.remove('visible');
}

// ─── NOTION API ──────────────────────────────────────────────────────────────
async function notionRequest(endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${config.notionToken}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `Notion error ${res.status}`);
  return data;
}

function extractText(prop) {
  if (!prop) return '';
  if (prop.type === 'title')     return prop.title.map(t => t.plain_text).join('');
  if (prop.type === 'rich_text') return prop.rich_text.map(t => t.plain_text).join('');
  if (prop.type === 'select')    return prop.select?.name || '';
  if (prop.type === 'status')    return prop.status?.name || '';
  if (prop.type === 'people')    return prop.people?.map(p => p.name).join(', ') || '';
  return '';
}

// ─── USER PICKER ─────────────────────────────────────────────────────────────
async function fetchAllAssignees() {
  // Query all "Not started" tasks to extract unique assignees
  const queryBody = {
    page_size: 100,
    filter: {
      property: config.fields.status,
      status: { equals: config.statusFilter || 'Not started' }
    },
  };
  const data = await notionRequest(
    `/databases/${config.notionDatabaseId}/query`, 'POST', queryBody
  );

  // Count tasks per assignee
  const assigneeMap = {};
  (data.results || []).forEach(page => {
    const props = page.properties;
    const assigneeRaw = props[config.fields.assignee];
    if (!assigneeRaw || assigneeRaw.type !== 'people') return;
    (assigneeRaw.people || []).forEach(person => {
      if (!person.name) return;
      if (!assigneeMap[person.name]) assigneeMap[person.name] = 0;
      assigneeMap[person.name]++;
    });
  });

  return Object.entries(assigneeMap)
    .map(([name, count]) => ({ name, taskCount: count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Generate a consistent avatar colour per name
function avatarColor(name) {
  const palettes = [
    { bg: '#b5d4f4', color: '#0c447c' },
    { bg: '#9fe1cb', color: '#085041' },
    { bg: '#f5c4b3', color: '#712b13' },
    { bg: '#f4c0d1', color: '#72243e' },
    { bg: '#c0dd97', color: '#27500a' },
    { bg: '#fac775', color: '#633806' },
  ];
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffff;
  return palettes[hash % palettes.length];
}

function initials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

async function showUserPicker(fromSettings = false) {
  const btnBack = document.getElementById('btnUserPickerBack');
  const titleEl = document.getElementById('userPickerTitle');
  const subEl   = document.getElementById('userPickerSub');

  // Adjust header for context
  if (fromSettings) {
    titleEl.textContent = 'Switch Assignee';
    subEl.textContent = 'Pick a different user';
    btnBack.style.display = 'block';
    btnBack.onclick = () => {
      userPickerOverlay.classList.remove('visible');
      // return to settings tab
      document.querySelector('[data-tab="settings"]').click();
    };
  } else {
    titleEl.textContent = "Who's tracking today?";
    subEl.textContent = 'Fetching users from Notion…';
    btnBack.style.display = 'none';
  }

  userPickerOverlay.classList.add('visible');

  // Show loading state
  userList.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:10px;padding:30px 0;">
      <div class="loading-dots">
        <div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div>
      </div>
      <div class="overlay-msg">Connecting to Notion…</div>
    </div>`;

  try {
    const assignees = await fetchAllAssignees();

    if (assignees.length === 0) {
      userList.innerHTML = `<div class="overlay-msg" style="padding:30px 0;text-align:center;">
        No assignees found in database.<br>Check your Notion token &amp; filters in Settings.
      </div>`;
      return;
    }

    // If config already has an assigneeName saved (and not coming from settings), auto-pick if found
    if (!fromSettings && config.assigneeName) {
      const match = assignees.find(a =>
        a.name.toLowerCase() === config.assigneeName.toLowerCase()
      );
      if (match) {
        onUserSelected(match, false);
        return;
      }
    }

    userList.innerHTML = '';
    assignees.forEach(user => {
      const pal = avatarColor(user.name);
      const row = document.createElement('div');
      row.className = 'user-row';
      // highlight currently selected user
      if (config.assigneeName && user.name.toLowerCase() === config.assigneeName.toLowerCase()) {
        row.style.borderColor = 'rgba(0,122,255,0.35)';
        row.style.background = '#eef5ff';
      }
      row.innerHTML = `
        <div class="user-avatar" style="background:${pal.bg};color:${pal.color};">${initials(user.name)}</div>
        <div>
          <div class="user-name">${user.name}</div>
          <div class="user-meta">${user.taskCount} task${user.taskCount !== 1 ? 's' : ''} waiting</div>
        </div>
        <span class="user-chevron">›</span>
      `;
      row.addEventListener('click', () => onUserSelected(user, fromSettings));
      userList.appendChild(row);
    });

  } catch (e) {
    userList.innerHTML = `<div class="overlay-msg" style="padding:30px 0;text-align:center;color:#ff3b30;">
      Error: ${e.message}
    </div>`;
  }
}

function onUserSelected(user, fromSettings = false) {
  selectedUser = user;
  config.assigneeName = user.name;
  statusUser.textContent = user.name;

  // Save selection
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) { /* ignore */ }

  userPickerOverlay.classList.remove('visible');

  if (fromSettings) {
    // Update the assignee button in settings and go back to settings tab
    updateAssigneeBtn(user.name);
    document.querySelector('[data-tab="settings"]').click();
    setStatus(`Assignee changed to ${user.name}`, 'ok');
    loadTasks();
  } else {
    loadTasks();
  }
}

// Update the visual assignee picker button in Settings
function updateAssigneeBtn(name) {
  const nameEl   = document.getElementById('settingAssigneeName');
  const avatarEl = document.getElementById('settingAssigneeAvatar');
  const hiddenEl = document.getElementById('settingAssignee');
  if (!name) {
    nameEl.textContent = '—';
    avatarEl.textContent = '';
    avatarEl.style.background = '';
    if (hiddenEl) hiddenEl.value = '';
    return;
  }
  const pal = avatarColor(name);
  avatarEl.textContent = initials(name);
  avatarEl.style.background = pal.bg;
  avatarEl.style.color = pal.color;
  nameEl.textContent = name;
  if (hiddenEl) hiddenEl.value = name;
}

// ─── QUEUE UI ─────────────────────────────────────────────────────────────────
function renderQueue() {
  queueDots.innerHTML = '';
  const total = taskQueue.length;
  const show = Math.min(total, 18);
  for (let i = 0; i < show; i++) {
    const dot = document.createElement('div');
    dot.className = 'q-dot';
    queueDots.appendChild(dot);
  }
  if (total === 0) {
    queueCount.textContent = 'No tasks';
    queueCount.className = 'queue-count';
  } else {
    queueCount.textContent = `${total} tasks`;
    queueCount.className = 'queue-count loaded';
  }
}

function populateDropdown(tasks) {
  taskDropdown.innerHTML = '<option value="">— Select a task —</option>';
  tasks.forEach(task => {
    const opt = document.createElement('option');
    opt.value = task.id;
    opt.textContent = task.name;
    opt.dataset.name = task.name;
    taskDropdown.appendChild(opt);
  });
  if (tasks.length === 1) {
    taskDropdown.selectedIndex = 1;
    onDropdownChange();
  }
}

function onDropdownChange() {
  const selected = taskDropdown.options[taskDropdown.selectedIndex];
  if (!selected || !selected.value) {
    currentTask = null;
    taskLabel.textContent = 'Select a task above';
    taskLabel.className = 'task-label';
    btnStart.disabled = true;
    return;
  }
  currentTask = { id: selected.value, name: selected.dataset.name, notionPageId: selected.value };
  taskLabel.textContent = `Ready: ${currentTask.name}`;
  taskLabel.className = 'task-label';
  btnStart.disabled = false;
  setStatus('Task selected — press Start', '');
}

taskDropdown.addEventListener('change', onDropdownChange);

// ─── NOTION FETCH TASKS ───────────────────────────────────────────────────────
async function fetchTasksFromNotion() {
  const queryBody = {
    page_size: 100,
    filter: {
      property: config.fields.status,
      status: { equals: config.statusFilter || 'Not started' }
    },
    sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
  };
  const data = await notionRequest(
    `/databases/${config.notionDatabaseId}/query`, 'POST', queryBody
  );
  return (data.results || [])
    .map(page => {
      const props = page.properties;
      return {
        id: page.id,
        name: extractText(props[config.fields.taskName]) || 'Unnamed Task',
        assignee: extractText(props[config.fields.assignee]),
        notionPageId: page.id,
      };
    })
    .filter(t => t.name)
    .filter(t => {
      if (!config.assigneeName) return true;
      return t.assignee.toLowerCase().includes(config.assigneeName.toLowerCase());
    });
}

// ─── TIMER LOGIC ─────────────────────────────────────────────────────────────
function tick() {
  if (isPaused || currentBreak) return;
  const now = Date.now();
  const display = formatTime(elapsed + (now - startTime));
  timeDisplay.textContent = display;
  // keep mini-pill in sync
  if (isMiniMode) miniTimeSp.textContent = display;
}

async function patchNotionStatus(notionPageId, statusName) {
  if (!notionPageId || notionPageId === 'manual') return;
  const res = await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${config.notionToken}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: { [config.fields.status]: { status: { name: statusName } } }
    })
  });
  const data = await res.json();
  if (!res.ok) { setStatus(`Notion error: ${data.message}`, 'err'); return false; }
  return true;
}

function startTask(taskObj) {
  elapsed = 0; isPaused = false; currentBreak = null;
  startTime = Date.now();
  taskStartWall = new Date();
  lastEntry = null;

  clearInterval(timerInterval);
  timerInterval = setInterval(tick, 1000);

  timeDisplay.textContent = '00:00:00';
  timeDisplay.className = 'time running';
  taskLabel.textContent = taskObj.name;
  taskLabel.className = 'task-label active';

  btnStart.textContent = '▶ Running';
  btnStart.disabled = true;
  taskDropdown.disabled = true;
  btnRefreshTasks.disabled = true;
  btnStop.classList.add('active');
  btnPause.classList.remove('active');
  btnPause.textContent = '⏸ Pause';
  btnSync.className = 'btn btn-sync';
  resetBreakBtns();
  setStatus('Running... (syncing Notion)', 'warn');

  // Enter mini mode after a short delay so the user sees the start
  setTimeout(() => enterMiniMode(taskObj.name), 600);

  const pageId = taskObj.notionPageId;
  if (pageId && pageId !== 'manual') {
    fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${config.notionToken}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          [config.fields.status]:    { status: { name: 'In progress' } },
          [config.fields.startTime]: { date: { start: taskStartWall.toISOString() } },
        }
      })
    })
    .then(r => r.json())
    .then(d => {
      if (d.object === 'error') setStatus(`Start sync error: ${d.message}`, 'err');
      else setStatus('Running...', 'warn');
    })
    .catch(e => setStatus(`Network error: ${e.message}`, 'err'));
  } else {
    setStatus('Running...', 'warn');
  }
}

function pauseTimer() {
  if (!timerInterval || isPaused || currentBreak) return;
  isPaused = true;
  elapsed += (Date.now() - startTime);
  clearInterval(timerInterval); timerInterval = null;
  timeDisplay.className = 'time paused';
  taskLabel.className = 'task-label paused';
  btnPause.classList.add('active');
  btnPause.textContent = '▶ Resume';
  setStatus('Paused', 'warn');
}

function resumeTimer() {
  if (!isPaused || currentBreak) return;
  isPaused = false;
  startTime = Date.now();
  timerInterval = setInterval(tick, 1000);
  timeDisplay.className = 'time running';
  taskLabel.className = 'task-label active';
  btnPause.classList.remove('active');
  btnPause.textContent = '⏸ Pause';
  setStatus('Running...', 'warn');
}

function startBreak(type) {
  if (timerInterval && !isPaused) pauseTimer();
  currentBreak = type; breakStart = Date.now();
  const labels = { morning: '☀ Morning Break', lunch: '🍱 Lunch Break', evening: '🌙 Evening Break' };
  taskLabel.textContent = labels[type] || 'Break';
  taskLabel.className = 'task-label break';
  timeDisplay.className = 'time break';
  setBreakBtnActive(type);
  setStatus(`On ${type} break`, '');
}

function endBreak(type) {
  if (currentBreak !== type) return;
  currentBreak = null; breakStart = null;
  resetBreakBtns();
  if (currentTask) {
    taskLabel.textContent = currentTask.name;
    if (isPaused) {
      taskLabel.className = 'task-label paused';
      timeDisplay.className = 'time paused';
      setStatus('Paused — click Resume', 'warn');
    } else { resumeTimer(); }
  }
}

function stopTimer() {
  if (!timerInterval && !isPaused) return;
  let finalElapsed = elapsed;
  if (!isPaused && startTime) finalElapsed += (Date.now() - startTime);

  clearInterval(timerInterval); timerInterval = null;
  isPaused = false; currentBreak = null;

  const endTimeWall = new Date();
  lastEntry = {
    taskName: currentTask ? currentTask.name : 'Unknown Task',
    notionPageId: currentTask ? currentTask.notionPageId : null,
    startTime: taskStartWall,
    endTime: endTimeWall,
    duration: finalElapsed,
  };
  completedTasks.push(lastEntry);

  timeDisplay.className = 'time';
  btnStart.textContent = '▶ Start';
  btnStart.disabled = false;
  taskDropdown.disabled = false;
  btnRefreshTasks.disabled = false;
  btnStop.classList.remove('active');
  btnPause.classList.remove('active');
  btnPause.textContent = '⏸ Pause';
  btnSync.className = 'btn btn-sync ready';
  resetBreakBtns();

  const mins = Math.floor(finalElapsed / 60000);
  const secs = Math.floor((finalElapsed % 60000) / 1000);
  taskLabel.className = 'task-label';
  taskLabel.textContent = `Done — ${mins}m ${secs}s`;
  setStatus('Stopped. Sync to Notion ↑', 'warn');

  // Exit mini mode when timer stops
  if (isMiniMode) exitMiniMode();
}

// ─── BREAK BUTTONS ───────────────────────────────────────────────────────────
function setBreakBtnActive(type) {
  [btnMorning, btnLunch, btnEvening].forEach(b => b.classList.remove('active'));
  if (type === 'morning') btnMorning.classList.add('active');
  if (type === 'lunch')   btnLunch.classList.add('active');
  if (type === 'evening') btnEvening.classList.add('active');
}
function resetBreakBtns() {
  [btnMorning, btnLunch, btnEvening].forEach(b => b.classList.remove('active'));
}
function handleBreakBtn(type) {
  if (currentBreak === type) endBreak(type); else startBreak(type);
}
btnMorning.addEventListener('click', () => handleBreakBtn('morning'));
btnLunch.addEventListener('click',   () => handleBreakBtn('lunch'));
btnEvening.addEventListener('click', () => handleBreakBtn('evening'));

// ─── BUTTON HANDLERS ─────────────────────────────────────────────────────────
btnStart.addEventListener('click', () => {
  if (timerInterval && !isPaused) return;
  if (currentTask) {
    startTask(currentTask);
  } else {
    manualInput.value = '';
    manualOverlay.classList.add('visible');
    manualInput.focus();
  }
});

btnPause.addEventListener('click', () => {
  if (currentBreak) return;
  if (isPaused) resumeTimer(); else pauseTimer();
});
btnStop.addEventListener('click', () => {
  if (!timerInterval && !isPaused) return;
  stopTimer();
});
btnSync.addEventListener('click', () => {
  if (!lastEntry) return;
  syncToNotion(lastEntry);
});
btnRefreshTasks.addEventListener('click', () => loadTasks());
btnConfirmManual.addEventListener('click', confirmManual);
btnCancelManual.addEventListener('click', () => manualOverlay.classList.remove('visible'));
manualInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') confirmManual();
  if (e.key === 'Escape') manualOverlay.classList.remove('visible');
});

function confirmManual() {
  const name = manualInput.value.trim() || 'Untitled Task';
  manualOverlay.classList.remove('visible');
  currentTask = { id: 'manual', name, notionPageId: null };
  taskLabel.textContent = `Ready: ${currentTask.name}`;
  taskLabel.className = 'task-label';
  btnStart.disabled = false;
  startTask(currentTask);
}

// ─── NOTION SYNC ─────────────────────────────────────────────────────────────
async function syncToNotion({ taskName, startTime, endTime, duration, notionPageId }) {
  btnSync.className = 'btn btn-sync syncing';
  btnSync.textContent = '↻';
  setStatus('Syncing...', '');

  const durationText = formatDuration(duration);

  try {
    if (notionPageId) {
      const props = {
        [config.fields.startTime]: { date: { start: startTime.toISOString() } },
        [config.fields.endTime]:   { date: { start: endTime.toISOString() } },
      };
      if (config.fields.duration) props[config.fields.duration] = { rich_text: [{ text: { content: durationText } }] };
      if (config.fields.status)   props[config.fields.status] = { status: { name: 'Done' } };
      await notionRequest(`/pages/${notionPageId}`, 'PATCH', { properties: props });
    } else {
      const body = {
        parent: { database_id: config.notionDatabaseId },
        properties: {
          [config.fields.taskName]:  { title: [{ text: { content: taskName } }] },
          [config.fields.startTime]: { date: { start: startTime.toISOString() } },
          [config.fields.endTime]:   { date: { start: endTime.toISOString() } },
        }
      };
      if (config.fields.duration) body.properties[config.fields.duration] = { rich_text: [{ text: { content: durationText } }] };
      await notionRequest('/pages', 'POST', body);
    }

    btnSync.className = 'btn btn-sync synced';
    btnSync.textContent = '✓';
    setStatus(`Synced: ${durationText} logged`, 'ok');
    lastEntry = null;

    setTimeout(() => {
      btnSync.className = 'btn btn-sync';
      btnSync.textContent = '↑';
      loadTasks();
    }, 2500);

  } catch (e) {
    btnSync.className = 'btn btn-sync ready';
    btnSync.textContent = '↑';
    setStatus(`Sync error: ${e.message}`, 'err');
  }
}

// ─── LOAD TASKS ──────────────────────────────────────────────────────────────
async function loadTasks() {
  btnRefreshTasks.textContent = '↻';
  btnRefreshTasks.style.color = '#F5D503';
  setLoading('Fetching tasks...', true);

  try {
    const tasks = await fetchTasksFromNotion();
    setLoading('', false);
    btnRefreshTasks.textContent = '↺';
    btnRefreshTasks.style.color = '#44ff88';
    setTimeout(() => { btnRefreshTasks.style.color = '#555'; }, 2000);

    if (!tasks || tasks.length === 0) {
      taskQueue = [];
      populateDropdown([]);
      renderQueue();
      taskLabel.textContent = `No "Not started" tasks for ${config.assigneeName}`;
      taskLabel.className = 'task-label';
      btnStart.disabled = false;
      setStatus('No tasks — use manual mode', 'warn');
      return;
    }

    taskQueue = tasks;
    populateDropdown(tasks);
    renderQueue();
    taskLabel.textContent = 'Select a task above ↑';
    taskLabel.className = 'task-label';
    btnStart.disabled = true;
    setStatus(`${tasks.length} task${tasks.length > 1 ? 's' : ''} loaded`, 'ok');

  } catch (e) {
    setLoading('', false);
    btnRefreshTasks.textContent = '↺';
    btnRefreshTasks.style.color = '#ff4444';
    setTimeout(() => { btnRefreshTasks.style.color = '#555'; }, 2000);
    taskQueue = [];
    populateDropdown([]);
    renderQueue();
    taskLabel.textContent = 'Could not load tasks — manual mode';
    taskLabel.className = 'task-label';
    btnStart.disabled = false;
    setStatus(`Error: ${e.message}`, 'err');
  }
}

// ─── STATS TAB ───────────────────────────────────────────────────────────────
function renderStats() {
  const today = new Date();
  statsTodayDate.textContent = today.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  // Filter to today's completed tasks
  const todayStr = today.toDateString();
  const todayTasks = completedTasks.filter(t => new Date(t.startTime).toDateString() === todayStr);

  const totalMs = todayTasks.reduce((sum, t) => sum + t.duration, 0);
  statsTotalTime.textContent = formatDuration(totalMs) || '0m';
  statsTaskCount.textContent = todayTasks.length;

  if (todayTasks.length === 0) {
    statsHistory.innerHTML = '<div class="stats-empty">No completed tasks yet.<br>Start tracking to see history here.</div>';
    return;
  }

  statsHistory.innerHTML = '';
  // Show most recent first
  [...todayTasks].reverse().forEach(t => {
    const row = document.createElement('div');
    row.className = 'stats-row';
    row.innerHTML = `
      <div class="stats-dot"></div>
      <div class="stats-task-name" title="${t.taskName}">${t.taskName}</div>
      <div class="stats-dur">${formatDuration(t.duration)}</div>
    `;
    statsHistory.appendChild(row);
  });
}

// ─── SETTINGS TAB ────────────────────────────────────────────────────────────
function populateSettings() {
  // Assignee shown as button, not text input
  updateAssigneeBtn(config.assigneeName || '');
  settingStatus.value          = config.statusFilter || 'Not started';
  settingDbId.value            = config.notionDatabaseId || '';
  settingFieldTask.value       = config.fields.taskName || '';
  settingFieldAssignee.value   = config.fields.assignee || '';
  settingFieldStatus.value     = config.fields.status || '';
  settingFieldStart.value      = config.fields.startTime || '';
  settingFieldEnd.value        = config.fields.endTime || '';
  settingFieldDuration.value   = config.fields.duration || '';
}

// Wire the assignee picker button
document.getElementById('btnPickAssignee').addEventListener('click', () => {
  showUserPicker(true);   // true = fromSettings
});

btnSaveSettings.addEventListener('click', () => {
  // Assignee comes from hidden input (set by picker)
  config.assigneeName       = document.getElementById('settingAssignee').value.trim() || config.assigneeName;
  config.statusFilter       = settingStatus.value.trim();
  config.notionDatabaseId   = settingDbId.value.trim();
  config.fields.taskName    = settingFieldTask.value.trim();
  config.fields.assignee    = settingFieldAssignee.value.trim();
  config.fields.status      = settingFieldStatus.value.trim();
  config.fields.startTime   = settingFieldStart.value.trim();
  config.fields.endTime     = settingFieldEnd.value.trim();
  config.fields.duration    = settingFieldDuration.value.trim();

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    statusUser.textContent = config.assigneeName || '—';
    setStatus('Settings saved', 'ok');
    // Switch back to timer tab and reload
    document.querySelector('[data-tab="timer"]').click();
    loadTasks();
  } catch (e) {
    setStatus(`Save error: ${e.message}`, 'err');
  }
});

// ─── CHROME TABS (stub — requires native bridge or extension) ─────────────────
document.getElementById('btnRefreshChrome').addEventListener('click', refreshChromeTabs);
document.getElementById('btnConnectChrome').addEventListener('click', () => {
  setStatus('Chrome extension not yet configured', 'warn');
});

function refreshChromeTabs() {
  // If you have a chrome-tabs IPC bridge set up in main.js, call it here:
  // ipcRenderer.invoke('get-chrome-tabs').then(renderChromeTabs).catch(() => {});
  //
  // For now we just show the empty state.
  const list = document.getElementById('chromeTabsList');
  list.innerHTML = `<div class="chrome-empty">
    No Chrome tabs detected.<br>
    <button class="chrome-connect-btn" id="btnConnectChrome">Connect Chrome Extension</button>
  </div>`;
  document.getElementById('btnConnectChrome').addEventListener('click', () => {
    setStatus('Chrome extension not yet configured', 'warn');
  });
}

function renderChromeTabs(tabs) {
  // Called when you have real tab data from a native bridge
  const list = document.getElementById('chromeTabsList');
  if (!tabs || tabs.length === 0) {
    refreshChromeTabs(); return;
  }
  list.innerHTML = '';
  tabs.forEach(tab => {
    const item = document.createElement('div');
    item.className = 'chrome-tab-item';
    const domain = (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })();
    item.innerHTML = `
      <div class="chrome-favicon">
        ${tab.favIconUrl ? `<img src="${tab.favIconUrl}" width="14" height="14" style="border-radius:2px;">` : '🌐'}
      </div>
      <div style="flex:1;overflow:hidden;">
        <div class="chrome-tab-title">${tab.title || 'Untitled'}</div>
        <div class="chrome-tab-domain">${domain}</div>
      </div>
    `;
    list.appendChild(item);
  });
}

// Listen for chrome tabs data if main process ever sends it
ipcRenderer.on('chrome-tabs', (_, tabs) => renderChromeTabs(tabs));

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  statusUser.textContent = config.assigneeName || '—';
  await showUserPicker();
}

init();