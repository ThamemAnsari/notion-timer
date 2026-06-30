const { ipcRenderer } = require('electron');
const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');

let config = {
  airtableToken:           process.env.AIRTABLE_TOKEN       || '',
  airtableBaseId:          process.env.AIRTABLE_BASE_ID     || 'appb8bp8Oax0sM4NC',
  airtableTableId:         process.env.AIRTABLE_TABLE_ID    || 'tbl4e3rdZ7T4ARVLO',
  airtableEmployeeTableId: 'tblRJBTklGq8tph6o',
  assigneeName: '',
  statusFilter: 'Yet to Start',
  fields: {
    taskName:  'Task',
    assignee:  'Assignee',
    status:    'Task Status',
    startTime: 'Planned Start Date',
    endTime:   'Planned End Date',
    duration:  'Actual Time Spend',
  }
};

if (fs.existsSync(CONFIG_PATH)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    config = {
      ...config, ...saved,
      fields: { ...config.fields, ...(saved.fields || {}) },
      airtableEmployeeTableId: saved.airtableEmployeeTableId || 'tblRJBTklGq8tph6o',
    };
  } catch(e) {}
}

// ─── STATE ───────────────────────────────────────────────────────────────────
let timerInterval = null, startTime = null, elapsed = 0;
let isPaused = false, currentBreak = null, breakStart = null;
let taskQueue = [], currentTask = null, completedTasks = [], lastEntry = null, taskStartWall = null;
let selectedUser = null;

// ─── EMPLOYEE CACHE ───────────────────────────────────────────────────────────
const recordNameCache = {};
let employeeMap = {};

async function loadEmployeeMap() {
  employeeMap = {};
  let offset = null, total = 0;
  try {
    do {
      let url = `https://api.airtable.com/v0/${config.airtableBaseId}/${encodeURIComponent(config.airtableEmployeeTableId)}?pageSize=100&fields[]=Unique%20Name&fields[]=Full%20Name&fields[]=First%20Name&fields[]=Name`;
      if (offset) url += `&offset=${encodeURIComponent(offset)}`;
      const data = await airtableRequest(url);
      (data.records || []).forEach(rec => {
        const name = rec.fields?.['Unique Name'] || rec.fields?.['Full Name'] || rec.fields?.['First Name'] || rec.fields?.['Name'];
        if (name) { employeeMap[rec.id] = name; recordNameCache[rec.id] = name; total++; }
      });
      offset = data.offset || null;
    } while (offset);
    console.log(`[loadEmployeeMap] ✓ ${total} employees`);
  } catch(err) { console.error('[loadEmployeeMap]', err.message); }
}

async function resolveRecordIdsBatch(recordIds) {
  const unresolved = recordIds.filter(id => !employeeMap[id]);
  if (!unresolved.length) return;
  await Promise.all(unresolved.map(async id => {
    try {
      const url = `https://api.airtable.com/v0/${config.airtableBaseId}/${encodeURIComponent(config.airtableEmployeeTableId)}/${id}`;
      const data = await airtableRequest(url);
      const name = data.fields?.['Unique Name'] || data.fields?.['Full Name'] || data.fields?.['First Name'] || data.fields?.['Name'];
      if (name) { employeeMap[id] = name; recordNameCache[id] = name; }
    } catch(e) {}
  }));
}

function resolveEmployeeName(id) { return employeeMap[id] || recordNameCache[id] || id; }

function resolveAssigneeField(raw) {
  if (!raw) return '';
  if (Array.isArray(raw)) return raw.map(v => typeof v === 'object' ? (v.name || resolveEmployeeName(v.id)) : resolveEmployeeName(String(v))).filter(Boolean).join(', ');
  if (typeof raw === 'string') return (raw.startsWith('rec') && raw.length > 10) ? resolveEmployeeName(raw) : raw;
  return String(raw);
}

// ─── DOM ─────────────────────────────────────────────────────────────────────
// Timer
const clock             = document.getElementById('clock');
const chipDot           = document.getElementById('chipDot');
const chipName          = document.getElementById('chipName');
const btnStart          = document.getElementById('btnStart');
const btnPause          = document.getElementById('btnPause');
const btnStop           = document.getElementById('btnStop');
const btnSync           = document.getElementById('btnSync');
const statusText        = document.getElementById('statusText');
const statusUser        = document.getElementById('statusUser');
const queuePips         = document.getElementById('queuePips');
const queueBadge        = document.getElementById('queueBadge');
const taskDropdown      = document.getElementById('taskDropdown');
const btnRefreshTasks   = document.getElementById('btnRefreshTasks');
const progFill          = document.getElementById('progFill');

// Overlays (inside .main)
const loadingOverlay    = document.getElementById('loadingOverlay');
const loadingMsg        = document.getElementById('loadingMsg');
const manualOverlay     = document.getElementById('manualOverlay');
const manualInput       = document.getElementById('manualInput');
const btnConfirmManual  = document.getElementById('btnConfirmManual');
const btnCancelManual   = document.getElementById('btnCancelManual');

// User picker modal (full-widget)
const userPickerModal   = document.getElementById('userPickerModal');
const upTitle           = document.getElementById('upTitle');
const upSub             = document.getElementById('upSub');
const upBody            = document.getElementById('upBody');
const upSearchWrap      = document.getElementById('upSearchWrap');
const upSearch          = document.getElementById('upSearch');
const btnUpCancel       = document.getElementById('btnUpCancel');

// Break buttons
const btnMorning        = document.getElementById('btnMorning');
const btnLunch          = document.getElementById('btnLunch');
const btnEvening        = document.getElementById('btnEvening');

// Stats
const statsTodayDate    = document.getElementById('statsTodayDate');
const statsTotalTime    = document.getElementById('statsTotalTime');
const statsTaskCount    = document.getElementById('statsTaskCount');
const statsHistory      = document.getElementById('statsHistory');

// Settings
const settingAssignee   = document.getElementById('settingAssignee');
const settingStatus     = document.getElementById('settingStatus');
const settingBaseId     = document.getElementById('settingBaseId');
const settingFieldTask  = document.getElementById('settingFieldTask');
const settingFieldAssignee = document.getElementById('settingFieldAssignee');
const settingFieldStatus   = document.getElementById('settingFieldStatus');
const settingFieldStart    = document.getElementById('settingFieldStart');
const settingFieldEnd      = document.getElementById('settingFieldEnd');
const settingFieldDuration = document.getElementById('settingFieldDuration');
const btnSaveSettings      = document.getElementById('btnSaveSettings');
const mainWidget           = document.getElementById('mainWidget');

// ─── SIDEBAR COLLAPSE ────────────────────────────────────────────────────────
const sidebar = document.getElementById('sidebar');
document.getElementById('sidebarToggle').addEventListener('click', () => sidebar.classList.toggle('collapsed'));

// ─── SIDEBAR NAV ─────────────────────────────────────────────────────────────
const titles = { timer: 'Timer', stats: 'Stats', chrome: 'Tabs', settings: 'Settings' };
document.querySelectorAll('.sb-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.sb-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${tab}`)?.classList.add('active');
    document.getElementById('topTitle').textContent = titles[tab] || tab;
    ipcRenderer.send('resize-for-tab', tab);
    if (tab === 'stats') renderStats();
    if (tab === 'settings') populateSettings();
  });
});

// ─── WINDOW CONTROLS ─────────────────────────────────────────────────────────
let dragging = false, lastX, lastY;
['dragBar','topDragBar'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('mousedown', e => { dragging = true; lastX = e.screenX; lastY = e.screenY; });
});
document.addEventListener('mousemove', e => {
  if (!dragging) return;
  ipcRenderer.send('move-window', { dx: e.screenX - lastX, dy: e.screenY - lastY });
  lastX = e.screenX; lastY = e.screenY;
});
document.addEventListener('mouseup', () => { dragging = false; });
document.getElementById('btnClose').addEventListener('click', () => ipcRenderer.send('close-app'));
document.getElementById('btnMin').addEventListener('click',   () => ipcRenderer.send('minimize-app'));

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function fmtTime(ms) {
  const s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return [h, m, s%60].map(v => String(v).padStart(2,'0')).join(':');
}
function fmtDur(ms) {
  const t = Math.floor(ms/60000), h = Math.floor(t/60), m = t%60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function setStatus(msg, type='') {
  statusText.textContent = msg;
  statusText.className = `st ${type}`;
}
function setLoading(msg, show=true) {
  loadingMsg.textContent = msg;
  loadingOverlay.classList.toggle('open', show);
}
function initials(name) { return name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2); }
function avatarColor(name) {
  const p = [
    {bg:'#b5d4f4',color:'#0c447c'},{bg:'#9fe1cb',color:'#085041'},
    {bg:'#f5c4b3',color:'#712b13'},{bg:'#f4c0d1',color:'#72243e'},
    {bg:'#c0dd97',color:'#27500a'},{bg:'#fac775',color:'#633806'},
  ];
  let h=0; for (const c of name) h=(h*31+c.charCodeAt(0))&0xffff;
  return p[h%p.length];
}

// ─── AIRTABLE ────────────────────────────────────────────────────────────────
function atBase() { return `https://api.airtable.com/v0/${config.airtableBaseId}/${encodeURIComponent(config.airtableTableId)}`; }

async function airtableRequest(url, method='GET', body=null) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  const opts = {
    method, signal: ctrl.signal,
    headers: { 'Authorization': `Bearer ${config.airtableToken}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || data.error || `Airtable ${res.status}`);
    return data;
  } catch(e) {
    if (e.name === 'AbortError') throw new Error('Request timed out (12s) — check token & base ID');
    throw e;
  } finally { clearTimeout(t); }
}

async function atFetchAll(formula) {
  let records=[], offset=null;
  do {
    let url = `${atBase()}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;
    if (offset) url += `&offset=${encodeURIComponent(offset)}`;
    const data = await airtableRequest(url);
    records = records.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);
  return records;
}

function extractField(rec, field) {
  if (!rec?.fields) return '';
  const v = rec.fields[field];
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

// ─── USER PICKER ─────────────────────────────────────────────────────────────
async function fetchAllAssignees() {
  const formula = `{${config.fields.status}} = "${config.statusFilter || 'Yet to Start'}"`;
  const records = await atFetchAll(formula);
  if (!records.length) return [];

  const allIds = new Set();
  records.forEach(rec => {
    const raw = rec.fields[config.fields.assignee];
    if (!raw) return;
    (Array.isArray(raw)?raw:[raw]).forEach(v => {
      const s = typeof v==='object'?v?.id:String(v);
      if (s?.startsWith('rec')&&s.length>10) allIds.add(s);
    });
  });
  if (!Object.keys(employeeMap).length && allIds.size) await resolveRecordIdsBatch([...allIds]);

  const map = {};
  records.forEach(rec => {
    const raw = rec.fields[config.fields.assignee];
    if (!raw) return;
    (Array.isArray(raw)?raw:[raw]).forEach(v => {
      let name;
      if (typeof v==='object'&&v!==null) name = v.name||resolveEmployeeName(v.id);
      else { const s=String(v).trim(); name=(s.startsWith('rec')&&s.length>10)?resolveEmployeeName(s):s; }
      if (name) map[name]=(map[name]||0)+1;
    });
  });
  return Object.entries(map).map(([name,taskCount])=>({name,taskCount})).sort((a,b)=>a.name.localeCompare(b.name));
}

async function showUserPicker(fromSettings=false) {
  if (fromSettings) {
    upTitle.textContent = 'Switch Assignee';
    upSub.textContent = 'Pick a different team member';
    btnUpCancel.classList.add('show');
    btnUpCancel.onclick = () => userPickerModal.classList.remove('open');
  } else {
    upTitle.textContent = "Who's tracking today?";
    upSub.textContent = 'Connecting to Airtable…';
    btnUpCancel.classList.remove('show');
  }

  userPickerModal.classList.add('open');
  upSearchWrap.style.display = 'none';
  upBody.innerHTML = `<div class="up-loader"><div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div><div class="up-loader-msg">Loading employees from Airtable…</div></div>`;

  try {
    if (!config.airtableToken) {
      upBody.innerHTML = `<div class="up-loader"><div class="up-loader-msg" style="color:#dc2626;text-align:center;">⚠ No AIRTABLE_TOKEN in .env<br><span style="color:#9898b0;font-size:9px;display:block;margin-top:4px;">Add it and restart the app</span></div></div>`;
      return;
    }
    try { await loadEmployeeMap(); } catch(e) {}
    const assignees = await fetchAllAssignees();

    if (!assignees.length) {
      upBody.innerHTML = `<div class="up-loader"><div class="up-loader-msg" style="text-align:center;">No assignees found.<br><span style="color:#9898b0;font-size:9px;display:block;margin-top:4px;">Status filter: "${config.statusFilter}"<br>Check DevTools console for details.</span></div></div>`;
      return;
    }

    if (!fromSettings && config.assigneeName) {
      const match = assignees.find(a => a.name.toLowerCase() === config.assigneeName.toLowerCase());
      if (match) { onUserSelected(match, false); return; }
    }

    upSub.textContent = `${assignees.length} team members`;
    upSearchWrap.style.display = 'block';

    function renderList(list) {
      upBody.innerHTML = '';
      const ul = document.createElement('div');
      ul.className = 'up-list';
      if (!list.length) { ul.innerHTML = '<div class="empty-msg">No matches found.</div>'; }
      list.forEach(user => {
        const pal = avatarColor(user.name);
        const row = document.createElement('div');
        row.className = 'up-row' + (config.assigneeName && user.name.toLowerCase()===config.assigneeName.toLowerCase()?' sel':'');
        row.innerHTML = `
          <div class="up-av" style="background:${pal.bg};color:${pal.color};">${initials(user.name)}</div>
          <div>
            <div class="up-name">${user.name}</div>
            <div class="up-count">${user.taskCount} task${user.taskCount!==1?'s':''} waiting</div>
          </div>
          <span class="up-chev">›</span>`;
        row.addEventListener('click', () => onUserSelected(user, fromSettings));
        ul.appendChild(row);
      });
      upBody.appendChild(ul);
    }
    renderList(assignees);
    upSearch.value = '';
    upSearch.oninput = () => {
      const q = upSearch.value.toLowerCase().trim();
      renderList(q ? assignees.filter(a=>a.name.toLowerCase().includes(q)) : assignees);
    };

  } catch(e) {
    upBody.innerHTML = `<div class="up-loader"><div class="up-loader-msg" style="color:#dc2626;">Error: ${e.message}</div></div>`;
  }
}

function onUserSelected(user, fromSettings=false) {
  selectedUser = user;
  config.assigneeName = user.name;

  // Update sidebar avatar + name
  const sbAv = document.getElementById('sbAvatar');
  const sbUname = document.getElementById('sbUname');
  if (sbAv) { sbAv.textContent = initials(user.name); const p=avatarColor(user.name); sbAv.style.background=p.bg; sbAv.style.color=p.color; }
  if (sbUname) sbUname.textContent = user.name;
  statusUser.textContent = user.name;

  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch(e) {}
  userPickerModal.classList.remove('open');

  if (fromSettings) {
    updateAssigneeBtn(user.name);
    document.querySelector('[data-tab="settings"]')?.click();
    setStatus(`Assignee → ${user.name}`, 'ok');
  }
  loadTasks();
}

function updateAssigneeBtn(name) {
  const nameEl   = document.getElementById('settingAssigneeName');
  const avatarEl = document.getElementById('settingAssigneeAvatar');
  const hiddenEl = document.getElementById('settingAssignee');
  if (!name) { nameEl.textContent='—'; avatarEl.textContent=''; avatarEl.style.background=''; if(hiddenEl)hiddenEl.value=''; return; }
  const pal = avatarColor(name);
  avatarEl.textContent = initials(name);
  avatarEl.style.background = pal.bg;
  avatarEl.style.color = pal.color;
  nameEl.textContent = name;
  if (hiddenEl) hiddenEl.value = name;
}

// ─── QUEUE UI ────────────────────────────────────────────────────────────────
function renderQueue() {
  queuePips.innerHTML = '';
  const total = taskQueue.length;
  const show = Math.min(total, 20);
  for (let i=0; i<show; i++) {
    const d=document.createElement('div'); d.className='q-pip on';
    queuePips.appendChild(d);
  }
  queueBadge.textContent = total ? `${total} task${total!==1?'s':''}` : 'Empty';
  queueBadge.style.color = total ? 'var(--accent)' : 'var(--text3)';
}

function populateDropdown(tasks) {
  taskDropdown.innerHTML = '<option value="">— Select a task —</option>';
  tasks.forEach(t => {
    const o=document.createElement('option');
    o.value=t.id; o.textContent=t.name; o.dataset.name=t.name;
    taskDropdown.appendChild(o);
  });
  if (tasks.length===1) { taskDropdown.selectedIndex=1; onDropdownChange(); }
}

function onDropdownChange() {
  const sel = taskDropdown.options[taskDropdown.selectedIndex];
  if (!sel?.value) {
    currentTask=null;
    chipName.textContent='Select a task above ↑';
    chipName.className='task-chip-name';
    chipDot.className='task-chip-dot';
    btnStart.disabled=true;
    return;
  }
  currentTask = {id:sel.value, name:sel.dataset.name, airtableRecordId:sel.value};
  chipName.textContent=`Ready: ${currentTask.name}`;
  chipName.className='task-chip-name';
  chipDot.className='task-chip-dot';
  btnStart.disabled=false;
  setStatus('Task selected — press Start','');
}
taskDropdown.addEventListener('change', onDropdownChange);

// ─── FETCH TASKS ─────────────────────────────────────────────────────────────
async function fetchTasksFromAirtable() {
  const formula = `{${config.fields.status}} = "${config.statusFilter||'Yet to Start'}"`;
  let records=[], offset=null;
  do {
    let url=`${atBase()}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;
    if (offset) url+=`&offset=${encodeURIComponent(offset)}`;
    const data=await airtableRequest(url);
    records=records.concat(data.records||[]);
    offset=data.offset||null;
  } while(offset);

  const allIds=new Set();
  records.forEach(rec=>{
    const raw=rec.fields[config.fields.assignee];
    if(!raw)return;
    (Array.isArray(raw)?raw:[raw]).forEach(v=>{
      const s=typeof v==='object'?v?.id:String(v);
      if(s?.startsWith('rec')&&s.length>10)allIds.add(s);
    });
  });
  if(!Object.keys(employeeMap).length&&allIds.size) await resolveRecordIdsBatch([...allIds]);

  const mapped=records.map(rec=>({
    id:rec.id, airtableRecordId:rec.id,
    name:extractField(rec,config.fields.taskName)||'Unnamed Task',
    assignee:resolveAssigneeField(rec.fields[config.fields.assignee]),
  }));
  return mapped.filter(t=>{
    if(!t.name)return false;
    if(!config.assigneeName)return true;
    return t.assignee.split(',').map(s=>s.trim().toLowerCase()).some(n=>n===config.assigneeName.toLowerCase()||n.includes(config.assigneeName.toLowerCase()));
  });
}

// ─── TIMER LOGIC ─────────────────────────────────────────────────────────────
function tick() {
  if (isPaused||currentBreak) return;
  clock.textContent = fmtTime(elapsed+(Date.now()-startTime));
}

async function patchRecord(id, fields) {
  if(!id||id==='manual')return false;
  const data=await airtableRequest(`${atBase()}/${id}`,'PATCH',{fields});
  return !!data.id;
}

function fmtDate(date) {
  if(!date)return '';
  const d=new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function startTask(taskObj) {
  elapsed=0; isPaused=false; currentBreak=null;
  startTime=Date.now(); taskStartWall=new Date(); lastEntry=null;
  clearInterval(timerInterval);
  timerInterval=setInterval(tick,1000);

  clock.textContent='00:00:00';
  clock.className='clock running';
  chipName.textContent=taskObj.name;
  chipName.className='task-chip-name active';
  chipDot.className='task-chip-dot running';
  btnStart.disabled=true;
  taskDropdown.disabled=true;
  btnRefreshTasks.disabled=true;
  resetBreakBtns();
  setStatus('Running…','warn');

  const recId=taskObj.airtableRecordId;
  if(recId&&recId!=='manual') {
    patchRecord(recId,{[config.fields.status]:'In Progress',[config.fields.startTime]:fmtDate(taskStartWall)})
    .then(ok=>{ if(ok) setStatus('Running…','warn'); else setStatus('Start sync error','err'); })
    .catch(e=>setStatus(`Network error: ${e.message}`,'err'));
  }
}

function pauseTimer() {
  if(!timerInterval||isPaused||currentBreak)return;
  isPaused=true; elapsed+=(Date.now()-startTime);
  clearInterval(timerInterval); timerInterval=null;
  clock.className='clock paused';
  chipName.className='task-chip-name';
  chipDot.className='task-chip-dot paused';
  btnPause.classList.add('is-paused');
  btnPause.innerHTML='<svg viewBox="0 0 24 24" style="width:10px;height:10px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  setStatus('Paused','warn');
}

function resumeTimer() {
  if(!isPaused||currentBreak)return;
  isPaused=false; startTime=Date.now();
  timerInterval=setInterval(tick,1000);
  clock.className='clock running';
  chipName.className='task-chip-name active';
  chipDot.className='task-chip-dot running';
  btnPause.classList.remove('is-paused');
  btnPause.innerHTML='<svg viewBox="0 0 24 24" style="width:10px;height:10px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round"><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>';
  setStatus('Running…','warn');
}

function startBreak(type) {
  if(timerInterval&&!isPaused) pauseTimer();
  currentBreak=type; breakStart=Date.now();
  const labels={morning:'Morning Break',lunch:'Lunch Break',evening:'Evening Break'};
  chipName.textContent=labels[type]||'On Break';
  chipName.className='task-chip-name';
  chipDot.className='task-chip-dot paused';
  setBreakActive(type);
  setStatus(`On ${type} break`,'');
}

function endBreak(type) {
  if(currentBreak!==type)return;
  currentBreak=null; breakStart=null;
  resetBreakBtns();
  if(currentTask){
    chipName.textContent=currentTask.name;
    if(isPaused){ chipName.className='task-chip-name'; chipDot.className='task-chip-dot paused'; setStatus('Paused','warn'); }
    else resumeTimer();
  }
}

function stopTimer() {
  if(!timerInterval&&!isPaused)return;
  let finalMs=elapsed;
  if(!isPaused&&startTime) finalMs+=(Date.now()-startTime);
  clearInterval(timerInterval); timerInterval=null;
  isPaused=false; currentBreak=null;

  const endWall=new Date();
  lastEntry={ taskName:currentTask?.name||'Unknown', airtableRecordId:currentTask?.airtableRecordId||null, startTime:taskStartWall, endTime:endWall, duration:finalMs };
  completedTasks.push(lastEntry);

  clock.className='clock done';
  chipDot.className='task-chip-dot done';
  chipName.className='task-chip-name done';
  chipName.textContent=`Done — ${fmtDur(finalMs)}`;
  btnStart.disabled=false;
  taskDropdown.disabled=false;
  btnRefreshTasks.disabled=false;
  btnSync.classList.add('sync-ready');
  resetBreakBtns();
  setStatus('Stopped — press ↑ to sync','warn');
}

// break buttons
function setBreakActive(type) {
  [btnMorning,btnLunch,btnEvening].forEach(b=>b.classList.remove('on'));
  if(type==='morning')btnMorning.classList.add('on');
  if(type==='lunch')btnLunch.classList.add('on');
  if(type==='evening')btnEvening.classList.add('on');
}
function resetBreakBtns() { [btnMorning,btnLunch,btnEvening].forEach(b=>b.classList.remove('on')); }
function handleBreak(type) { if(currentBreak===type)endBreak(type); else startBreak(type); }
btnMorning.addEventListener('click',()=>handleBreak('morning'));
btnLunch.addEventListener('click',()=>handleBreak('lunch'));
btnEvening.addEventListener('click',()=>handleBreak('evening'));

// ─── BUTTON HANDLERS ─────────────────────────────────────────────────────────
btnStart.addEventListener('click', () => {
  if(timerInterval&&!isPaused)return;
  if(currentTask) startTask(currentTask);
  else { manualInput.value=''; manualOverlay.classList.add('open'); manualInput.focus(); }
});
btnPause.addEventListener('click', () => { if(currentBreak)return; if(isPaused)resumeTimer(); else pauseTimer(); });
btnStop.addEventListener('click',  () => { if(!timerInterval&&!isPaused)return; stopTimer(); });
btnSync.addEventListener('click',  () => { if(lastEntry)syncToAirtable(lastEntry); });
btnRefreshTasks.addEventListener('click', () => loadTasks());
btnConfirmManual.addEventListener('click', confirmManual);
btnCancelManual.addEventListener('click', () => manualOverlay.classList.remove('open'));
manualInput.addEventListener('keydown', e => {
  if(e.key==='Enter')confirmManual();
  if(e.key==='Escape')manualOverlay.classList.remove('open');
});

function confirmManual() {
  const name=manualInput.value.trim()||'Untitled Task';
  manualOverlay.classList.remove('open');
  currentTask={id:'manual',name,airtableRecordId:null};
  chipName.textContent=`Ready: ${name}`;
  chipDot.className='task-chip-dot';
  btnStart.disabled=false;
  startTask(currentTask);
}

// ─── SYNC ────────────────────────────────────────────────────────────────────
async function syncToAirtable({taskName,startTime,endTime,duration,airtableRecordId}) {
  btnSync.classList.remove('sync-ready');
  btnSync.innerHTML='<svg class="spin" viewBox="0 0 24 24" style="width:10px;height:10px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
  setStatus('Syncing…','');

  const durText=fmtDur(duration);
  try {
    if(airtableRecordId) {
      const fields={[config.fields.endTime]:fmtDate(endTime),[config.fields.status]:'Done'};
      if(config.fields.duration) fields[config.fields.duration]=durText;
      await patchRecord(airtableRecordId,fields);
    } else {
      const fields={[config.fields.taskName]:taskName,[config.fields.startTime]:fmtDate(startTime),[config.fields.endTime]:fmtDate(endTime)};
      if(config.fields.duration) fields[config.fields.duration]=durText;
      if(config.assigneeName) fields[config.fields.assignee]=config.assigneeName;
      await airtableRequest(atBase(),'POST',{fields});
    }
    btnSync.classList.add('synced');
    btnSync.innerHTML='<svg viewBox="0 0 24 24" style="width:10px;height:10px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round"><polyline points="20 6 9 17 4 12"/></svg>';
    setStatus(`Synced: ${durText} logged`,'ok');
    lastEntry=null;
    setTimeout(()=>{ btnSync.classList.remove('synced'); btnSync.innerHTML='<svg viewBox="0 0 24 24" style="width:10px;height:10px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>'; loadTasks(); },2500);
  } catch(e) {
    btnSync.innerHTML='<svg viewBox="0 0 24 24" style="width:10px;height:10px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>';
    setStatus(`Sync error: ${e.message}`,'err');
  }
}

// ─── LOAD TASKS ──────────────────────────────────────────────────────────────
async function loadTasks() {
  setLoading('Fetching tasks…',true);
  try {
    if(!Object.keys(employeeMap).length) await loadEmployeeMap();
    const tasks=await fetchTasksFromAirtable();
    setLoading('',false);
    if(!tasks.length) {
      taskQueue=[];
      populateDropdown([]);
      renderQueue();
      chipName.textContent=`No tasks for ${config.assigneeName||'—'}`;
      chipDot.className='task-chip-dot';
      btnStart.disabled=false;
      setStatus('No tasks — use manual mode','warn');
      return;
    }
    taskQueue=tasks;
    populateDropdown(tasks);
    renderQueue();
    if(!currentTask){ chipName.textContent='Select a task ↑'; chipDot.className='task-chip-dot'; btnStart.disabled=true; }
    setStatus(`${tasks.length} task${tasks.length!==1?'s':''} loaded`,'ok');
  } catch(e) {
    setLoading('',false);
    taskQueue=[];
    populateDropdown([]);
    renderQueue();
    chipName.textContent='Could not load — manual mode';
    btnStart.disabled=false;
    setStatus(`Error: ${e.message}`,'err');
  }
}

// ─── STATS ───────────────────────────────────────────────────────────────────
function renderStats() {
  const today=new Date();
  statsTodayDate.textContent=today.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
  const todayStr=today.toDateString();
  const todayTasks=completedTasks.filter(t=>new Date(t.startTime).toDateString()===todayStr);
  const totalMs=todayTasks.reduce((s,t)=>s+t.duration,0);
  statsTotalTime.textContent=fmtDur(totalMs)||'0m';
  statsTaskCount.textContent=todayTasks.length;
  if(!todayTasks.length){ statsHistory.innerHTML='<div class="empty-msg">No completed tasks yet.<br>Start tracking to see history.</div>'; return; }
  statsHistory.innerHTML='';
  [...todayTasks].reverse().forEach(t=>{
    const row=document.createElement('div'); row.className='hist-row';
    row.innerHTML=`<div class="hist-pip"></div><div class="hist-name" title="${t.taskName}">${t.taskName}</div><div class="hist-dur">${fmtDur(t.duration)}</div>`;
    statsHistory.appendChild(row);
  });
  document.getElementById('statsUser').textContent=config.assigneeName||'—';
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────
function populateSettings() {
  updateAssigneeBtn(config.assigneeName||'');
  settingStatus.value        = config.statusFilter||'Yet to Start';
  settingBaseId.value        = `${config.airtableBaseId} / ${config.airtableTableId}`;
  settingFieldTask.value     = config.fields.taskName||'';
  settingFieldAssignee.value = config.fields.assignee||'';
  settingFieldStatus.value   = config.fields.status||'';
  settingFieldStart.value    = config.fields.startTime||'';
  settingFieldEnd.value      = config.fields.endTime||'';
  settingFieldDuration.value = config.fields.duration||'';
  document.getElementById('settingsUser').textContent=config.assigneeName||'—';
}

document.getElementById('btnPickAssignee').addEventListener('click', () => showUserPicker(true));

btnSaveSettings.addEventListener('click', () => {
  config.assigneeName    = document.getElementById('settingAssignee').value.trim()||config.assigneeName;
  config.statusFilter    = settingStatus.value.trim();
  const dbVal=settingBaseId.value.trim();
  if(dbVal.includes('/')){
    const parts=dbVal.split('/').map(s=>s.trim());
    config.airtableBaseId=parts[0]||config.airtableBaseId;
    config.airtableTableId=parts[1]||config.airtableTableId;
  } else if(dbVal) config.airtableBaseId=dbVal;
  config.fields.taskName  =settingFieldTask.value.trim();
  config.fields.assignee  =settingFieldAssignee.value.trim();
  config.fields.status    =settingFieldStatus.value.trim();
  config.fields.startTime =settingFieldStart.value.trim();
  config.fields.endTime   =settingFieldEnd.value.trim();
  config.fields.duration  =settingFieldDuration.value.trim();
  try {
    fs.writeFileSync(CONFIG_PATH,JSON.stringify(config,null,2));
    statusUser.textContent=config.assigneeName||'—';
    setStatus('Settings saved','ok');
    Object.keys(employeeMap).forEach(k=>delete employeeMap[k]);
    Object.keys(recordNameCache).forEach(k=>delete recordNameCache[k]);
    document.querySelector('[data-tab="timer"]')?.click();
    loadTasks();
  } catch(e){ setStatus(`Save error: ${e.message}`,'err'); }
});

// ─── CHROME (stub) ───────────────────────────────────────────────────────────
document.getElementById('btnRefreshChrome').addEventListener('click', () => {
  document.getElementById('chromeTabsList').innerHTML='<div class="empty-msg">No Chrome tabs detected.<br><button class="chrome-connect-btn" id="btnConnectChrome"><svg viewBox="0 0 24 24" style="width:10px;height:10px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Connect extension</button></div>';
});
document.getElementById('btnConnectChrome').addEventListener('click', () => setStatus('Chrome extension not configured','warn'));
ipcRenderer.on('chrome-tabs', (_, tabs) => {
  const list=document.getElementById('chromeTabsList');
  if(!tabs?.length){list.innerHTML='<div class="empty-msg">No tabs.</div>';return;}
  list.innerHTML='';
  tabs.forEach(tab=>{
    const domain=(()=>{try{return new URL(tab.url).hostname;}catch{return'';}})();
    const item=document.createElement('div');
    item.style.cssText='display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:7px;margin-bottom:4px;';
    item.innerHTML=`<div style="width:14px;height:14px;border-radius:3px;background:var(--border2);display:flex;align-items:center;justify-content:center;font-size:8px;flex-shrink:0;">${tab.favIconUrl?`<img src="${tab.favIconUrl}" width="12" height="12">`:'🌐'}</div><div style="flex:1;overflow:hidden;"><div style="font-size:10px;color:var(--text1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${tab.title||'Untitled'}</div><div style="font-size:8px;color:var(--text3);">${domain}</div></div>`;
    list.appendChild(item);
  });
});

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  // Restore sidebar user display if assignee was saved
  if (config.assigneeName) {
    const sbAv = document.getElementById('sbAvatar');
    const sbUname = document.getElementById('sbUname');
    if (sbAv) { sbAv.textContent=initials(config.assigneeName); const p=avatarColor(config.assigneeName); sbAv.style.background=p.bg; sbAv.style.color=p.color; }
    if (sbUname) sbUname.textContent=config.assigneeName;
    statusUser.textContent=config.assigneeName;
  }
  await showUserPicker();
}

init();