'use strict';
/* Court & Fairway — single-user training logger. No server, no accounts. */

const EX = {}; DATA_EXERCISES.exercises.forEach(e => EX[e.id] = e);
const SESS = {}; DATA_SESSIONS.sessions.forEach(s => SESS[s.id] = s);
const WEEK = DATA_SCHEDULE.week, PHASES = DATA_SCHEDULE.phases, RULES = DATA_SCHEDULE.rules, GATES = DATA_SCHEDULE.gates;
const $ = sel => document.querySelector(sel);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.floor(Math.random()*1e9));

/* ---------- storage ---------- */
let db = null, storageOK = true;
function openDB() {
  return new Promise(res => {
    try {
      const req = indexedDB.open('court-and-fairway', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        const s = d.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('date', 'date'); s.createIndex('sessionId', 'sessionId');
        d.createObjectStore('days', { keyPath: 'date' });
        d.createObjectStore('gates', { keyPath: 'id' });
        d.createObjectStore('appState', { keyPath: 'k' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => { storageOK = false; res(null); };
    } catch (e) { storageOK = false; res(null); }
  });
}
function idb(store, mode, fn) {
  return new Promise(res => {
    if (!db) return res(null);
    try {
      const tx = db.transaction(store, mode), st = tx.objectStore(store);
      const out = fn(st);
      tx.oncomplete = () => res(out && out.result !== undefined ? out.result : true);
      tx.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}
const putRec = (store, rec) => idb(store, 'readwrite', st => st.put(rec));
const delRec = (store, key) => idb(store, 'readwrite', st => st.delete(key));
const getAll = store => idb(store, 'readonly', st => st.getAll()).then(r => r || []);
const getRec = (store, key) => idb(store, 'readonly', st => st.get(key)).then(r => (r === true ? null : r));

const DEFAULT_STATE = { programStartDate: todayStr(), currentWeek: 1, units: 'imperial', theme: 'dark', flaggedVideos: [], lastExerciseValues: {}, schemaVersion: 1 };
let S = DEFAULT_STATE;
function loadState() {
  try { const raw = localStorage.getItem('caf-state'); if (raw) S = Object.assign({}, DEFAULT_STATE, JSON.parse(raw)); } catch (e) {}
}
function saveState() {
  try { localStorage.setItem('caf-state', JSON.stringify(S)); } catch (e) {}
  putRec('appState', { k: 'state', v: S });
}

/* caches for sync rendering */
let allSessions = [], allDays = [], allGates = [];
async function refreshCaches() {
  allSessions = (await getAll('sessions')).sort((a,b) => a.date < b.date ? -1 : 1);
  allDays = (await getAll('days')).sort((a,b) => a.date < b.date ? -1 : 1);
  allGates = (await getAll('gates')).sort((a,b) => a.date < b.date ? -1 : 1);
}

/* ---------- program math ---------- */
function programWeek(dateStr) {
  const start = new Date(S.programStartDate + 'T12:00:00'), d = new Date(dateStr + 'T12:00:00');
  return Math.max(1, Math.floor((d - start) / 864e5 / 7) + 1);
}
function phaseFor(week) { return week <= 2 ? 'Foundation' : week <= 4 ? 'Absorb' : 'Express'; }
function planFor(dateStr) {
  const dow = new Date(dateStr + 'T12:00:00').getDay(); // 0 Sun
  return WEEK[(dow + 6) % 7]; // WEEK starts Mon
}
function weekDates(dateStr) {
  const d = new Date(dateStr + 'T12:00:00'), dow = (d.getDay() + 6) % 7, out = [];
  for (let i = 0; i < 7; i++) { const x = new Date(d); x.setDate(d.getDate() - dow + i); out.push(todayStr(x)); }
  return out;
}
function hardCourtCount(dateStr) {
  const wk = weekDates(dateStr);
  return allDays.filter(d => wk.includes(d.date) && (d.courtIntensityActual === 'hard' || (d.courtIntensityActual == null && d.playedPickleball && d.courtIntensityPlanned === 'hard'))).length;
}
function streak() {
  const dates = new Set(allDays.filter(dayHasActivity).map(d => d.date));
  allSessions.forEach(s => dates.add(s.date));
  let n = 0; const d = new Date();
  if (!dates.has(todayStr(d))) d.setDate(d.getDate() - 1);
  while (dates.has(todayStr(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function dayHasActivity(d) {
  return d.playedPickleball || d.playedGolf || d.sauna.used || d.coldPlunge.used || d.steam.used || d.hotTub.used || (d.sessionLogIds && d.sessionLogIds.length);
}
function blankDay(date) {
  const plan = planFor(date);
  const mod = () => ({ used: false, minutes: null, timeOfDay: null });
  return { date, sessionLogIds: [], playedPickleball: false, courtIntensityPlanned: plan.courtIntensity, courtIntensityActual: null,
    courtMinutes: null, playedGolf: false, golfHoles: null, sauna: mod(), coldPlunge: mod(), steam: mod(), hotTub: mod(),
    sleepHours: null, kneePainAm: null, kneePainPm: null, shoulderPainAm: null, shoulderPainPm: null, bodyweight: null, notes: '' };
}

/* ---------- toast / undo ---------- */
let toastTimer = null;
function toast(msg, undoFn) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (undoFn ? ' <button id="undoBtn">UNDO</button>' : '');
  t.hidden = false;
  if (undoFn) $('#undoBtn').onclick = () => { undoFn(); t.hidden = true; };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, undoFn ? 6000 : 2500);
}

/* ---------- router ---------- */
let route = { tab: 'today' };
function go(r) { route = r; render(); window.scrollTo(0, 0); }
function render() {
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === route.tab));
  const v = $('#view');
  try {
    if (route.tab === 'today') v.innerHTML = viewToday();
    else if (route.tab === 'runner') v.innerHTML = viewRunner();
    else if (route.tab === 'daylog') v.innerHTML = viewDayLog();
    else if (route.tab === 'history') v.innerHTML = route.date ? viewDayDetail(route.date) : viewHistory();
    else if (route.tab === 'library') v.innerHTML = route.ex ? viewExercise(route.ex) : viewLibrary();
    else if (route.tab === 'program') v.innerHTML = viewProgram();
    else if (route.tab === 'settings') v.innerHTML = viewSettings();
    bindView();
  } catch (e) { v.innerHTML = '<div class="card">Something went wrong rendering this view. Your data is safe. <button class="ghost" onclick="location.reload()">Reload</button></div>'; }
}

/* ---------- TODAY ---------- */
function viewToday() {
  const date = todayStr(), plan = planFor(date), wk = programWeek(date), ph = phaseFor(Math.min(wk, 6));
  const sess = SESS[plan.amSessionId];
  const hc = hardCourtCount(date);
  const doneToday = allSessions.filter(s => s.date === date && s.completedAt);
  const dayRec = allDays.find(d => d.date === date);
  const wkLabel = wk > 6 ? `Week ${wk} · Maintain (program is 6 weeks)` : `Week ${wk} · ${ph}`;
  return `
  <h2>${new Date(date + 'T12:00:00').toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'})}</h2>
  <div class="mono sm mut">${esc(wkLabel)} · Streak ${streak()}d</div>
  <div class="bigchip ${plan.courtIntensity}">COURT · ${plan.courtIntensity === 'hard' ? 'HARD' : plan.courtIntensity === 'mod' ? 'MODERATE' : 'TECHNICAL'}</div>
  ${hc > RULES.hardCourtDaysPerWeek ? `<div class="note">Hard court days this week: ${hc} of ${RULES.hardCourtDaysPerWeek}.</div>` : `<div class="sm mut mono">Hard court days this week: ${hc} of ${RULES.hardCourtDaysPerWeek}</div>`}
  <button class="big" data-run="${esc(plan.amSessionId)}">${doneToday.some(s=>s.sessionId===plan.amSessionId) ? '✓ ' : ''}${esc(plan.amSessionLabel)} — ${esc(sess ? sess.name : '')}</button>
  <button class="ghost" data-run="DAILY">${doneToday.some(s=>s.sessionId==='DAILY') ? '✓ ' : ''}The Daily 10 — every morning</button>
  <button class="ghost" data-run="PRE">${doneToday.some(s=>s.sessionId==='PRE') ? '✓ ' : ''}Pre-court warm-up — before play</button>
  <div class="card">
    <h3 style="margin-top:0">This afternoon</h3>
    <div>${esc(plan.pm)}</div>
    <h3>Tonight's recovery</h3>
    <div>${esc(plan.recovery)}</div>
    <div class="sm mut" style="margin-top:6px">Heat after lifting. Cold after playing. Never the other way round.</div>
  </div>
  <button class="ghost" data-nav="daylog">${dayRec && dayHasActivity(dayRec) ? '✓ ' : ''}Log the day — court, golf, recovery, sleep, pain</button>`;
}

/* ---------- SESSION RUNNER ---------- */
let run = null; // { log, idx, timer:{left,total,int} }
function startSession(sessionId) {
  const date = todayStr(), sess = SESS[sessionId];
  if (!sess) return;
  const wk = Math.min(programWeek(date), 6);
  run = {
    idx: 0, timer: null,
    log: {
      id: uuid(), date, sessionId, programWeek: wk, phase: phaseFor(wk),
      startedAt: new Date().toISOString(), completedAt: null, sessionRpe: null, durationMinutes: null, notes: '',
      exercises: sess.exercises.map(exId => {
        const ex = EX[exId];
        const last = (S.lastExerciseValues || {})[exId];
        const sets = last && last.length ? last.map((s, i) => Object.assign({}, s, { setIndex: i + 1, completed: false }))
          : [1,2].map(i => ({ setIndex: i, reps: null, seconds: null, load: null, loadUnit: null, bandColor: null, side: null, tempoHeld: true, completed: false }));
        return { exerciseId: exId, prescribedDose: ex ? ex.dose : '', sets, rpe: null, painDuring: null, painLocation: null,
          completed: false, skipped: false, skipReason: null, notes: '', videoFlagged: (S.flaggedVideos || []).includes(exId) };
      })
    }
  };
  go({ tab: 'runner' });
}
function restSecondsFor(ex) {
  const d = (ex && ex.dose || '').toLowerCase();
  if (/iso|hold|spanish|wall sit/.test(d)) return 60;
  if (/sprint|bound|hop|jump|throw|shuttle/.test(d)) return 120;
  return 90;
}
function viewRunner() {
  if (!run) return viewToday();
  if (run.idx >= run.log.exercises.length) return viewFinish();
  const en = run.log.exercises[run.idx], ex = EX[en.exerciseId] || { name: en.exerciseId, dose: en.prescribedDose, equipment: [], video: '' };
  const offline = !navigator.onLine;
  const setRows = en.sets.map((s, i) => `
    <div class="setrow" data-set="${i}">
      <div class="mono sm mut">${i+1}</div>
      <input type="number" inputmode="decimal" placeholder="reps" value="${s.reps ?? ''}" data-f="reps">
      <input type="number" inputmode="decimal" placeholder="load" value="${s.load ?? ''}" data-f="load">
      <button class="done ${s.completed ? 'on' : ''}" data-donetoggle="${i}">✓</button>
    </div>`).join('');
  const unit = en.sets[0] && en.sets[0].loadUnit || '';
  const t = run.timer;
  return `
  <div class="row spread">
    <button class="back" data-quit="1">✕ Exit</button>
    <span class="pos">${run.idx + 1} OF ${run.log.exercises.length} · ${esc(run.log.sessionId)}</span>
  </div>
  <h2>${esc(ex.name)}</h2>
  <div class="mono" style="color:var(--accent);font-weight:600">${esc(ex.dose)}</div>
  <div class="row" style="margin:12px 0">
    ${offline ? '<span class="pill">VIDEO NEEDS SIGNAL</span>' : `<a class="watch" href="${esc(ex.video)}" target="_blank" rel="noopener">▶ Watch</a>`}
    <button class="flagb ${en.videoFlagged ? 'on' : ''}" data-flag="1">${en.videoFlagged ? '⚑ flagged' : '⚑ bad clip'}</button>
  </div>
  <div class="card">
    <div class="row spread" style="margin-bottom:8px">
      <span class="sm mut">SETS ${unit ? '· load in ' + esc(unit === 'band' ? 'band' : unit) : ''}</span>
      <span class="row" style="gap:6px">
        <button class="flagb" data-addset="1">+ set</button>
        <button class="flagb" data-unit="1">${esc(unit || 'unit')}</button>
        <button class="flagb" data-side="1">${esc(en.sets[0] && en.sets[0].side || 'both sides?')}</button>
      </span>
    </div>
    ${setRows}
    ${unit === 'band' ? `<input type="text" placeholder="band color" value="${esc(en.sets[0].bandColor || '')}" data-band="1" style="width:100%">` : ''}
  </div>
  <div class="card">
    <div class="timer" id="timerDisp">${t ? fmtT(t.left) : fmtT(restSecondsFor(ex))}</div>
    <button class="ghost" data-timer="1">${t ? 'Stop rest timer' : 'Start rest timer'}</button>
  </div>
  <div class="grid2">
    <div><label class="f">RPE 1–10</label><input type="number" inputmode="numeric" min="1" max="10" value="${en.rpe ?? ''}" data-exf="rpe"></div>
    <div><label class="f">Pain during 0–10</label><input type="number" inputmode="numeric" min="0" max="10" value="${en.painDuring ?? ''}" data-exf="painDuring"></div>
  </div>
  ${(en.painDuring || 0) > 0 ? `<label class="f">Pain location</label><input type="text" value="${esc(en.painLocation || '')}" data-exf="painLocation" style="width:100%">` : ''}
  <label class="f">Notes</label><textarea data-exf="notes">${esc(en.notes)}</textarea>
  <div class="runner-nav">
    <button class="prev" data-prev="1" ${run.idx === 0 ? 'disabled' : ''}>‹ Back</button>
    <button class="prev" data-skip="1">Skip</button>
    <button class="next" data-next="1">Done ›</button>
  </div>`;
}
function fmtT(s) { return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'); }
function viewFinish() {
  const l = run.log;
  const done = l.exercises.filter(e => e.completed).length, skipped = l.exercises.filter(e => e.skipped).length;
  return `
  <h2>Finish — ${esc(SESS[l.sessionId].name)}</h2>
  <div class="statgrid card">
    <div><div class="n">${done}</div><div class="l">done</div></div>
    <div><div class="n">${skipped}</div><div class="l">skipped</div></div>
    <div><div class="n">${Math.round((Date.now() - new Date(l.startedAt)) / 60000)}</div><div class="l">minutes</div></div>
  </div>
  <label class="f">Session RPE 1–10</label><input type="number" inputmode="numeric" min="1" max="10" value="${l.sessionRpe ?? ''}" data-sesf="sessionRpe" style="width:100%">
  <label class="f">Notes</label><textarea data-sesf="notes">${esc(l.notes)}</textarea>
  <button class="big" data-save="1">Save session</button>
  <button class="ghost" data-prev="1">‹ Back to last exercise</button>`;
}
async function saveRun() {
  const l = run.log;
  l.completedAt = new Date().toISOString();
  l.durationMinutes = Math.round((new Date(l.completedAt) - new Date(l.startedAt)) / 60000);
  l.exercises.forEach(en => {
    if (!en.skipped) en.completed = en.completed || en.sets.some(s => s.completed);
    if (en.completed) S.lastExerciseValues[en.exerciseId] = en.sets.map(s => Object.assign({}, s));
  });
  await putRec('sessions', l);
  let day = (await getRec('days', l.date)) || blankDay(l.date);
  if (!day.sessionLogIds.includes(l.id)) day.sessionLogIds.push(l.id);
  await putRec('days', day);
  saveState();
  await refreshCaches();
  const savedId = l.id;
  run = null;
  const n = allSessions.filter(s => s.completedAt).length;
  go({ tab: 'today' });
  if (n > 0 && n % 10 === 0) toast(`Session saved. ${n} sessions logged — export a backup in More.`);
  else toast('Session saved.', async () => { await delRec('sessions', savedId); await refreshCaches(); render(); });
}

/* ---------- DAY LOG ---------- */
let dayDraft = null;
function viewDayLog() {
  const date = route.date || todayStr();
  if (!dayDraft || dayDraft.date !== date) {
    const ex = allDays.find(d => d.date === date);
    dayDraft = ex ? JSON.parse(JSON.stringify(ex)) : blankDay(date);
  }
  const d = dayDraft;
  const seg = (name, val, opts) => `<div class="seg" data-seg="${name}">` + opts.map(o => `<button data-v="${o[0]}" class="${val === o[0] ? 'on' : ''}">${o[1]}</button>`).join('') + '</div>';
  const modRow = (key, label) => `
    <div class="row spread" style="margin:8px 0">
      <button class="flagb ${d[key].used ? 'on' : ''}" data-mod="${key}" style="min-width:110px">${d[key].used ? '✓ ' : ''}${label}</button>
      <input type="number" inputmode="numeric" placeholder="min" value="${d[key].minutes ?? ''}" data-modmin="${key}" style="width:80px">
      <input type="text" placeholder="time (e.g. 8pm)" value="${esc(d[key].timeOfDay || '')}" data-modtime="${key}" style="width:110px">
    </div>`;
  const num = (label, field, step) => `<div><label class="f">${label}</label><input type="number" inputmode="decimal" ${step?`step="${step}"`:''} value="${d[field] ?? ''}" data-df="${field}"></div>`;
  return `
  <div class="row spread"><button class="back" data-nav="${route.date ? 'history' : 'today'}">‹ Back</button><span class="pos">${esc(date)}</span></div>
  <h2>Day log</h2>
  <h3>Court</h3>
  <button class="flagb ${d.playedPickleball ? 'on' : ''}" data-toggle="playedPickleball" style="width:100%;min-height:48px">${d.playedPickleball ? '✓ ' : ''}Played pickleball</button>
  <label class="f">Planned intensity: <span class="chip ${d.courtIntensityPlanned || 'easy'}">${esc(d.courtIntensityPlanned || '—')}</span> · Actual:</label>
  ${seg('courtIntensityActual', d.courtIntensityActual, [['hard','Hard'],['mod','Moderate'],['easy','Technical']])}
  <label class="f">Court minutes</label><input type="number" inputmode="numeric" value="${d.courtMinutes ?? ''}" data-df="courtMinutes" style="width:100%">
  <h3>Golf</h3>
  <div class="row">
    <button class="flagb ${d.playedGolf ? 'on' : ''}" data-toggle="playedGolf" style="flex:1;min-height:48px">${d.playedGolf ? '✓ ' : ''}Played golf</button>
    <input type="number" inputmode="numeric" placeholder="holes" value="${d.golfHoles ?? ''}" data-df="golfHoles" style="width:100px">
  </div>
  <h3>Recovery</h3>
  ${modRow('sauna','Sauna')}${modRow('coldPlunge','Cold plunge')}${modRow('steam','Steam')}${modRow('hotTub','Hot tub')}
  <h3>Readouts</h3>
  <div class="grid2">
    ${num('Sleep hours','sleepHours','0.5')}${num('Bodyweight','bodyweight','0.1')}
    ${num('Knee pain AM','kneePainAm')}${num('Knee pain PM','kneePainPm')}
    ${num('Shoulder pain AM','shoulderPainAm')}${num('Shoulder pain PM','shoulderPainPm')}
  </div>
  <label class="f">Notes</label><textarea data-df="notes">${esc(d.notes)}</textarea>
  <button class="big" data-saveday="1">Save day</button>`;
}
async function saveDay() {
  const prev = allDays.find(x => x.date === dayDraft.date);
  const prevCopy = prev ? JSON.parse(JSON.stringify(prev)) : null;
  await putRec('days', dayDraft);
  await refreshCaches();
  const saved = dayDraft; dayDraft = null;
  go({ tab: route.date ? 'history' : 'today', date: route.date });
  toast('Day saved.', async () => {
    if (prevCopy) await putRec('days', prevCopy); else await delRec('days', saved.date);
    await refreshCaches(); render();
  });
}

/* ---------- HISTORY ---------- */
let histMonth = null;
function viewHistory() {
  const now = new Date(); if (!histMonth) histMonth = { y: now.getFullYear(), m: now.getMonth() };
  const { y, m } = histMonth;
  const first = new Date(y, m, 1), startPad = (first.getDay() + 6) % 7, dim = new Date(y, m + 1, 0).getDate();
  const byDate = {}; allSessions.forEach(s => { (byDate[s.date] = byDate[s.date] || []).push(s); });
  const dayMap = {}; allDays.forEach(d => dayMap[d.date] = d);
  let cells = ['Mo','Tu','We','Th','Fr','Sa','Su'].map(h => `<div class="hd">${h}</div>`).join('');
  for (let i = 0; i < startPad; i++) cells += '<div></div>';
  for (let day = 1; day <= dim; day++) {
    const ds = `${y}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const ns = (byDate[ds] || []).length, act = dayMap[ds] && dayHasActivity(dayMap[ds]);
    const lvl = ns >= 2 ? 'l2' : (ns === 1 || act) ? 'l1' : '';
    cells += `<button class="c ${lvl} ${ds === todayStr() ? 'today' : ''}" data-day="${ds}">${day}</button>`;
  }
  const wk = Math.min(programWeek(todayStr()), 6), ph = phaseFor(wk);
  const phSessions = allSessions.filter(s => s.phase === ph && s.completedAt).length;
  const lastGate = allGates[allGates.length - 1];
  const hc = hardCourtCount(todayStr());
  const flags = recoveryFlags();
  return `
  <h2>History</h2>
  <div class="card">
    <div class="row spread" style="margin-bottom:8px">
      <button class="iconbtn" data-mnav="-1">‹</button>
      <span class="mono sm">${first.toLocaleDateString(undefined,{month:'long', year:'numeric'})}</span>
      <button class="iconbtn" data-mnav="1">›</button>
    </div>
    <div class="heat">${cells}</div>
  </div>
  <div class="statgrid card">
    <div><div class="n">${streak()}</div><div class="l">day streak</div></div>
    <div><div class="n">${phSessions}</div><div class="l">${esc(ph)} sessions</div></div>
    <div><div class="n">${hc}/${RULES.hardCourtDaysPerWeek}</div><div class="l">hard court wk</div></div>
  </div>
  <div class="card sm">
    Gate — single-leg vertical hop: ${lastGate ? `<span class="${lastGate.passed ? 'gatepass' : 'gatefail'}">${lastGate.passed ? 'PASS' : 'FAIL'}</span> <span class="mono">LSI ${lastGate.lsi}%</span> (${esc(lastGate.date)})` : '<span class="mut">not tested — see Program tab</span>'}
  </div>
  ${flags.map(f => `<div class="note">${esc(f)}</div>`).join('')}
  <h3>Exercise trends</h3>
  <div class="card">${trendListHTML()}</div>`;
}
function recoveryFlags() {
  const out = [], wk = weekDates(todayStr());
  const colds = allDays.filter(d => wk.includes(d.date) && d.coldPlunge.used).length;
  if (colds > 3) out.push(`Cold plunge used ${colds}× this week — habitual daily cold trades adaptation for comfort.`);
  allDays.slice(-7).forEach(d => {
    if (d.coldPlunge.used && (d.sessionLogIds || []).length && !['A','B','C','D','E'].every(id => !allSessions.find(s => s.id && d.sessionLogIds.includes(s.id) && ['A','B','C','D','E'].includes(s.sessionId))))
      out.push(`${d.date}: cold plunge on a lift day — keep it 6h+ after the lift.`);
  });
  return out.slice(0, 3);
}
function trendListHTML() {
  const ids = [...new Set(allSessions.flatMap(s => s.exercises.filter(e => e.sets.some(x => x.completed)).map(e => e.exerciseId)))];
  if (!ids.length) return '<span class="sm mut">Log a session and per-exercise trends appear here.</span>';
  return ids.map(id => `<div class="exli" data-ex="${id}"><span>${esc(EX[id] ? EX[id].name : id)}</span><span class="mut">›</span></div>`).join('');
}
function viewDayDetail(date) {
  const day = allDays.find(d => d.date === date);
  const sessions = allSessions.filter(s => s.date === date);
  const sessHTML = sessions.map(l => `
    <div class="card">
      <div class="row spread"><b>${esc(SESS[l.sessionId] ? SESS[l.sessionId].name : l.sessionId)}</b><span class="pill">${l.completedAt ? (l.durationMinutes ?? '?') + ' min' : 'unfinished'}${l.sessionRpe ? ' · RPE ' + l.sessionRpe : ''}</span></div>
      ${l.exercises.map(en => {
        const name = EX[en.exerciseId] ? EX[en.exerciseId].name : en.exerciseId;
        if (en.skipped) return `<div class="sm" style="margin-top:8px"><span class="mut">⊘ ${esc(name)}</span> — skipped (${esc(en.skipReason || '?')})</div>`;
        const sets = en.sets.filter(s => s.completed).map(s =>
          `${s.reps ?? ''}${s.seconds ? s.seconds + 's' : ''}${s.load != null ? ' @ ' + s.load + (s.loadUnit === 'band' ? ' band' + (s.bandColor ? ' (' + s.bandColor + ')' : '') : ' ' + (s.loadUnit || '')) : ''}${s.side && s.side !== 'both' ? ' [' + s.side[0].toUpperCase() + ']' : ''}`).join(' · ');
        return sets ? `<div class="sm" style="margin-top:8px"><b>${esc(name)}</b><div class="mono mut">${esc(sets)}${en.rpe ? ' · RPE ' + en.rpe : ''}${en.painDuring ? ' · pain ' + en.painDuring : ''}</div>${en.notes ? `<div class="mut">${esc(en.notes)}</div>` : ''}</div>` : '';
      }).join('')}
      ${l.notes ? `<div class="note">${esc(l.notes)}</div>` : ''}
    </div>`).join('');
  const dHTML = day ? `
    <div class="card sm">
      ${day.playedPickleball ? `<div>Pickleball — ${esc(day.courtIntensityActual || day.courtIntensityPlanned || '?')}${day.courtMinutes ? ' · ' + day.courtMinutes + ' min' : ''}</div>` : ''}
      ${day.playedGolf ? `<div>Golf${day.golfHoles ? ' · ' + day.golfHoles + ' holes' : ''}</div>` : ''}
      ${['sauna','coldPlunge','steam','hotTub'].filter(k => day[k].used).map(k => `<div>${k === 'coldPlunge' ? 'Cold plunge' : k === 'hotTub' ? 'Hot tub' : k[0].toUpperCase() + k.slice(1)}${day[k].minutes ? ' · ' + day[k].minutes + ' min' : ''}${day[k].timeOfDay ? ' · ' + esc(day[k].timeOfDay) : ''}</div>`).join('')}
      ${day.sleepHours != null ? `<div>Sleep ${day.sleepHours}h</div>` : ''}
      ${day.kneePainAm != null || day.kneePainPm != null ? `<div>Knee pain AM ${day.kneePainAm ?? '—'} / PM ${day.kneePainPm ?? '—'}</div>` : ''}
      ${day.shoulderPainAm != null || day.shoulderPainPm != null ? `<div>Shoulder pain AM ${day.shoulderPainAm ?? '—'} / PM ${day.shoulderPainPm ?? '—'}</div>` : ''}
      ${day.bodyweight != null ? `<div>Bodyweight ${day.bodyweight}</div>` : ''}
      ${day.notes ? `<div class="note">${esc(day.notes)}</div>` : ''}
    </div>` : '<div class="sm mut">No day log.</div>';
  return `
  <div class="row spread"><button class="back" data-nav="history">‹ History</button><span class="pos">${esc(date)}</span></div>
  <h2>${new Date(date + 'T12:00:00').toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'})}</h2>
  ${sessHTML || '<div class="sm mut" style="margin-bottom:10px">No sessions logged.</div>'}
  <h3>Day</h3>${dHTML}
  <button class="ghost" data-editday="${esc(date)}">Edit day log</button>`;
}

/* ---------- trend chart ---------- */
function exerciseSeries(exId) {
  const pts = [];
  allSessions.forEach(s => s.exercises.forEach(en => {
    if (en.exerciseId !== exId) return;
    const done = en.sets.filter(x => x.completed);
    if (!done.length) return;
    const load = Math.max(...done.map(x => x.load ?? 0));
    const reps = Math.max(...done.map(x => x.reps ?? x.seconds ?? 0));
    pts.push({ date: s.date, load, reps, pain: en.painDuring ?? 0 });
  }));
  return pts;
}
function trendSVG(pts) {
  if (pts.length < 2) return '<div class="sm mut">Two or more logged sessions draw the trend.</div>';
  const W = 340, H = 150, P = 24;
  const xs = i => P + i * (W - 2*P) / (pts.length - 1);
  const maxL = Math.max(1, ...pts.map(p => p.load)), maxR = Math.max(1, ...pts.map(p => p.reps));
  const yL = v => H - P - v / maxL * (H - 2*P), yR = v => H - P - v / maxR * (H - 2*P), yP = v => H - P - v / 10 * (H - 2*P);
  const path = (f, key) => pts.map((p, i) => (i ? 'L' : 'M') + xs(i).toFixed(1) + ',' + f(p[key]).toFixed(1)).join(' ');
  return `<svg class="trend" viewBox="0 0 ${W} ${H}">
    <path d="${path(yL,'load')}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    <path d="${path(yR,'reps')}" fill="none" stroke="var(--easy)" stroke-width="1.5" stroke-dasharray="4 3"/>
    <path d="${path(yP,'pain')}" fill="none" stroke="var(--hard)" stroke-width="1.5"/>
    ${pts.map((p,i)=>`<circle cx="${xs(i).toFixed(1)}" cy="${yL(p.load).toFixed(1)}" r="3" fill="var(--accent)"/>`).join('')}
  </svg>
  <div class="sm mono"><span style="color:var(--accent)">— load</span> · <span style="color:var(--easy)">- - reps/secs</span> · <span style="color:var(--hard)">— pain 0–10</span></div>`;
}

/* ---------- LIBRARY ---------- */
let libQ = '', libRegion = '', libEquip = '';
function viewLibrary() {
  const regions = [...new Set(DATA_EXERCISES.exercises.map(e => e.region))].sort();
  const equips = [...new Set(DATA_EXERCISES.exercises.flatMap(e => e.equipment))].sort();
  const list = DATA_EXERCISES.exercises.filter(e =>
    (!libQ || (e.name + ' ' + e.tags.join(' ')).toLowerCase().includes(libQ.toLowerCase())) &&
    (!libRegion || e.region === libRegion) && (!libEquip || e.equipment.includes(libEquip)));
  return `
  <h2>Library <span class="mono sm mut">${list.length}/${DATA_EXERCISES.count}</span></h2>
  <input type="search" id="libq" placeholder="Search exercises" value="${esc(libQ)}" style="width:100%">
  <div class="grid2" style="margin-top:8px">
    <select id="libr"><option value="">All regions</option>${regions.map(r => `<option ${r===libRegion?'selected':''}>${esc(r)}</option>`).join('')}</select>
    <select id="libe"><option value="">All equipment</option>${equips.map(r => `<option ${r===libEquip?'selected':''}>${esc(r)}</option>`).join('')}</select>
  </div>
  <div class="card" style="margin-top:12px">
    ${list.map(e => `<div class="exli" data-ex="${e.id}"><span>${esc(e.name)}${(S.flaggedVideos||[]).includes(e.id) ? ' <span style="color:var(--hard)">⚑</span>' : ''}<br><span class="sm mut mono">${esc(e.dose)}</span></span><span class="mut">›</span></div>`).join('') || '<span class="sm mut">No matches.</span>'}
  </div>`;
}
function viewExercise(exId) {
  const e = EX[exId]; if (!e) return viewLibrary();
  const flagged = (S.flaggedVideos || []).includes(exId);
  const pts = exerciseSeries(exId);
  const backTab = route.from || 'library';
  return `
  <button class="back" data-nav="${backTab}">‹ Back</button>
  <h2>${esc(e.name)}</h2>
  <div class="mono" style="color:var(--accent);font-weight:600">${esc(e.dose)}</div>
  <div class="sm" style="margin:10px 0">${esc(e.why)}</div>
  <div class="row" style="margin:12px 0;flex-wrap:wrap">
    <span class="pill">${esc(e.region)}</span>${e.equipment.map(q => `<span class="pill">${esc(q)}</span>`).join('')}
  </div>
  <div class="row" style="margin-bottom:14px">
    <a class="watch" href="${esc(e.video)}" target="_blank" rel="noopener">▶ Watch</a>
    <button class="flagb ${flagged ? 'on' : ''}" data-flaglib="${exId}">${flagged ? '⚑ flagged bad clip' : '⚑ bad clip'}</button>
  </div>
  <h3>History</h3>
  <div class="card">${trendSVG(pts)}
    ${pts.slice(-8).reverse().map(p => `<div class="sm mono mut">${p.date} · load ${p.load || '—'} · reps ${p.reps || '—'}${p.pain ? ' · pain ' + p.pain : ''}</div>`).join('') || ''}
  </div>`;
}

/* ---------- PROGRAM ---------- */
function viewProgram() {
  const wk = Math.min(programWeek(todayStr()), 6);
  const lastGate = allGates[allGates.length - 1];
  return `
  <h2>Program</h2>
  <div class="sm mono mut">Started ${esc(S.programStartDate)} · now week ${programWeek(todayStr())}</div>
  <h3>The week</h3>
  <div class="card twrap"><table class="t">
    <tr><th>Day</th><th>AM</th><th>Court</th><th>PM</th></tr>
    ${WEEK.map(d => `<tr><td class="mono">${esc(d.day)}</td><td>${esc(d.amSessionLabel)}</td><td><span class="chip ${d.courtIntensity}">${d.courtIntensity}</span></td><td class="sm">${esc(d.pm)}</td></tr>`).join('')}
  </table></div>
  <div class="sm mut">Rules: ${RULES.hardCourtDaysPerWeek} hard court days/week max · ${RULES.minHoursBetweenLiftAndSport}h between lift and sport · lift AM, play PM.</div>
  <h3>Phases</h3>
  ${PHASES.map((p, i) => `<div class="card ${''}"><b>${esc(p.name)} <span class="mono sm mut">wk ${esc(p.weeks)}</span>${phaseFor(wk) === p.name ? ' <span class="chip easy">NOW</span>' : ''}</b><ul style="margin:8px 0 0 18px" class="sm">${p.rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>`).join('')}
  <h3>Gate check — single-leg vertical hop</h3>
  <div class="card">
    <div class="sm mut">Required before week 5. Vertical, not broad. Pass = limb symmetry index ≥ 90%.</div>
    <div class="grid3" style="margin-top:10px">
      <div><label class="f">Left</label><input type="number" inputmode="decimal" id="gateL"></div>
      <div><label class="f">Right</label><input type="number" inputmode="decimal" id="gateR"></div>
      <div><label class="f">Unit</label><select id="gateU"><option value="in" ${S.units==='imperial'?'selected':''}>in</option><option value="cm" ${S.units==='metric'?'selected':''}>cm</option></select></div>
    </div>
    <button class="ghost" data-gate="1">Compute + save</button>
    <div id="gateOut" class="sm" style="margin-top:6px">${lastGate ? `Last: ${lastGate.date} · L ${lastGate.leftValue} / R ${lastGate.rightValue} ${lastGate.unit} · LSI <b class="${lastGate.passed?'gatepass':'gatefail'}">${lastGate.lsi}% ${lastGate.passed?'PASS':'FAIL'}</b>` : ''}</div>
  </div>
  <div class="card sm"><b>Second gate — 24-hour quiet.</b> No knee or shoulder symptoms 24h after every session in weeks 3–4. Pain during work up to 3/10 is fine if it settles by next morning. Judge it from the AM pain scores in your day logs.</div>
  <h3>Recovery protocol</h3>
  <div class="card twrap"><table class="t">
    <tr><th>After</th><th>Use</th><th>Dose</th></tr>
    <tr><td>Morning lift</td><td>Sauna</td><td>80–100°C · 15–20 min</td></tr>
    <tr><td>Hard court</td><td>Cold plunge</td><td>10–12°C · 10–12 min, to the shoulders</td></tr>
    <tr><td>Technical day</td><td>Nothing</td><td>Passive recovery wins</td></tr>
    <tr><td>Evening, hard day</td><td>Hot tub</td><td>~40°C · 15 min, ending 60–120 min before bed</td></tr>
    <tr><td>Before mobility</td><td>Steam</td><td>10–15 min max</td></tr>
  </table></div>
  <div class="card sm"><b>Never:</b> cold plunge within 6h of lifting · whole-body heat before playing · cold within 2h of a match · ending on cold before bed · cold every day out of habit.</div>
  <h3>Sessions</h3>
  ${DATA_SESSIONS.sessions.map(s => `<div class="card sm"><b>${esc(s.name)}</b> <span class="mono mut">${esc(s.meta)}</span><div class="mut" style="margin:6px 0">${esc(s.note)}</div>${s.exercises.map(id => `<div class="exli" data-ex="${id}" data-from="program"><span>${esc(EX[id] ? EX[id].name : id)}</span><span class="mut">›</span></div>`).join('')}</div>`).join('')}`;
}
async function computeGate() {
  const L = parseFloat($('#gateL').value), R = parseFloat($('#gateR').value), unit = $('#gateU').value;
  if (!(L > 0) || !(R > 0)) { $('#gateOut').innerHTML = '<span class="mut">Enter both hop heights.</span>'; return; }
  const lsi = Math.round(Math.min(L, R) / Math.max(L, R) * 1000) / 10, passed = lsi >= 90;
  const rec = { id: uuid(), date: todayStr(), type: 'slVerticalHop', leftValue: L, rightValue: R, unit, lsi, passed, notes: '' };
  await putRec('gates', rec); await refreshCaches();
  $('#gateOut').innerHTML = `LSI <b class="${passed ? 'gatepass' : 'gatefail'}">${lsi}% — ${passed ? 'PASS' : 'FAIL'}</b>. Saved.`;
}

/* ---------- SETTINGS ---------- */
let storageInfo = { persisted: null, usage: null };
function viewSettings() {
  const n = allSessions.filter(s => s.completedAt).length;
  return `
  <h2>More</h2>
  <div class="card">
    <label class="f">Program start date</label>
    <input type="date" id="startDate" value="${esc(S.programStartDate)}" style="width:100%">
    <label class="f">Units</label>
    <div class="seg" id="unitSeg"><button data-v="imperial" class="${S.units==='imperial'?'on':''}">lb / in</button><button data-v="metric" class="${S.units==='metric'?'on':''}">kg / cm</button></div>
    <label class="f">Theme</label>
    <div class="seg" id="themeSeg">${['dark','light','system'].map(t => `<button data-v="${t}" class="${S.theme===t?'on':''}">${t}</button>`).join('')}</div>
  </div>
  <h3>Backup</h3>
  <div class="card">
    <div class="sm mut" style="margin-bottom:8px">This data lives only on this phone. Export is the only backup that exists. ${n} sessions logged.</div>
    <button class="big" data-export="json">Export backup (JSON)</button>
    <button class="ghost" data-export="csv">Export sets (CSV)</button>
    <button class="ghost" data-import="1">Import backup</button>
    <input type="file" id="importFile" accept="application/json,.json" hidden>
  </div>
  <h3>Storage</h3>
  <div class="card sm mono">
    ${storageOK ? '' : '<div class="gatefail">Storage unavailable — logging is off this session.</div>'}
    <div>Persistence: ${storageInfo.persisted === null ? '…' : storageInfo.persisted ? 'persisted' : 'best-effort (iOS may evict — keep exports)'}</div>
    <div>Usage: ${storageInfo.usage ?? '…'}</div>
    <div>Flagged clips: ${(S.flaggedVideos || []).length}</div>
  </div>
  <div class="sm mut">Court &amp; Fairway · local-only · schema v${S.schemaVersion}</div>`;
}
function download(name, text, type) {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { toast('Export failed on this browser.'); }
}
async function exportJSON() {
  const payload = { app: 'court-and-fairway', schemaVersion: 1, exportedAt: new Date().toISOString(), appState: S, sessions: allSessions, days: allDays, gates: allGates };
  download(`court-and-fairway-backup-${todayStr()}.json`, JSON.stringify(payload, null, 1), 'application/json');
  toast('Backup exported.');
}
function csvEsc(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
async function exportCSV() {
  const rows = [['date','session','exercise','setIndex','side','reps','seconds','load','loadUnit','bandColor','exerciseRpe','painDuring']];
  allSessions.forEach(l => l.exercises.forEach(en => en.sets.forEach(s => {
    if (!s.completed) return;
    rows.push([l.date, l.sessionId, EX[en.exerciseId] ? EX[en.exerciseId].name : en.exerciseId, s.setIndex, s.side || '', s.reps ?? '', s.seconds ?? '', s.load ?? '', s.loadUnit || '', s.bandColor || '', en.rpe ?? '', en.painDuring ?? '']);
  })));
  download(`court-and-fairway-sets-${todayStr()}.csv`, rows.map(r => r.map(csvEsc).join(',')).join('\n'), 'text/csv');
  toast('CSV exported.');
}
async function importJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'court-and-fairway') { toast('Not a Court & Fairway backup.'); return; }
    for (const s of data.sessions || []) await putRec('sessions', s);
    for (const d of data.days || []) await putRec('days', d);
    for (const g of data.gates || []) await putRec('gates', g);
    if (data.appState) { S = Object.assign({}, DEFAULT_STATE, data.appState); saveState(); applyTheme(); }
    await refreshCaches(); render();
    toast(`Restored ${(data.sessions || []).length} sessions, ${(data.days || []).length} days.`);
  } catch (e) { toast('Import failed — file unreadable.'); }
}

/* ---------- theme / offline ---------- */
function applyTheme() {
  const sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = S.theme === 'dark' || (S.theme === 'system' && sys);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
function updateOffline() { $('#offlineDot').hidden = navigator.onLine; }

/* ---------- event wiring ---------- */
document.getElementById('tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  if (run && b.dataset.tab !== 'today') { /* allow leaving runner via tabs; run stays resumable */ }
  histMonth = null; libQ = libQ; go({ tab: b.dataset.tab });
});
$('#themeBtn').onclick = () => { S.theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; saveState(); applyTheme(); };

function bindView() {
  const v = $('#view');
  v.querySelectorAll('[data-run]').forEach(b => b.onclick = () => {
    if (run && run.log.sessionId === b.dataset.run) go({ tab: 'runner' }); else startSession(b.dataset.run);
  });
  v.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => { dayDraft = null; go({ tab: b.dataset.nav }); });
  v.querySelectorAll('[data-day]').forEach(b => b.onclick = () => go({ tab: 'history', date: b.dataset.day }));
  v.querySelectorAll('[data-editday]').forEach(b => b.onclick = () => { route = { tab: 'daylog', date: b.dataset.editday }; dayDraft = null; render(); });
  v.querySelectorAll('[data-mnav]').forEach(b => b.onclick = () => { histMonth.m += +b.dataset.mnav; if (histMonth.m < 0) { histMonth.m = 11; histMonth.y--; } if (histMonth.m > 11) { histMonth.m = 0; histMonth.y++; } render(); });
  v.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => go({ tab: 'library', ex: b.dataset.ex, from: b.dataset.from || route.tab === 'history' ? (b.dataset.from || (route.tab === 'history' ? 'history' : 'library')) : 'library' }));
  v.querySelectorAll('[data-flaglib]').forEach(b => b.onclick = () => {
    const id = b.dataset.flaglib, i = S.flaggedVideos.indexOf(id);
    if (i >= 0) S.flaggedVideos.splice(i, 1); else S.flaggedVideos.push(id);
    saveState(); render();
  });
  v.querySelectorAll('[data-gate]').forEach(b => b.onclick = computeGate);

  /* runner */
  if (route.tab === 'runner' && run) {
    const en = run.log.exercises[run.idx];
    v.querySelectorAll('.setrow').forEach(row => {
      const i = +row.dataset.set;
      row.querySelectorAll('input[data-f]').forEach(inp => inp.oninput = () => { en.sets[i][inp.dataset.f] = inp.value === '' ? null : +inp.value; });
      const d = row.querySelector('[data-donetoggle]');
      if (d) d.onclick = () => { en.sets[i].completed = !en.sets[i].completed; d.classList.toggle('on', en.sets[i].completed); };
    });
    const band = v.querySelector('[data-band]'); if (band) band.oninput = () => en.sets.forEach(s => s.bandColor = band.value || null);
    v.querySelectorAll('[data-exf]').forEach(inp => inp.oninput = () => {
      en[inp.dataset.exf] = inp.value === '' ? (inp.type === 'number' ? null : '') : (inp.type === 'number' ? +inp.value : inp.value);
      if (inp.dataset.exf === 'painDuring') render();
    });
    const add = v.querySelector('[data-addset]'); if (add) add.onclick = () => {
      const last = en.sets[en.sets.length - 1] || { reps: null, load: null, loadUnit: null, bandColor: null, side: null };
      en.sets.push({ setIndex: en.sets.length + 1, reps: last.reps, seconds: null, load: last.load, loadUnit: last.loadUnit, bandColor: last.bandColor, side: last.side, tempoHeld: true, completed: false });
      render();
    };
    const un = v.querySelector('[data-unit]'); if (un) un.onclick = () => {
      const order = [null, S.units === 'metric' ? 'kg' : 'lb', 'band', 'bodyweight'];
      const cur = en.sets[0] ? en.sets[0].loadUnit : null;
      const next = order[(order.indexOf(cur) + 1) % order.length];
      en.sets.forEach(s => s.loadUnit = next); render();
    };
    const sd = v.querySelector('[data-side]'); if (sd) sd.onclick = () => {
      const order = [null, 'both', 'left', 'right'], cur = en.sets[0] ? en.sets[0].side : null;
      const next = order[(order.indexOf(cur) + 1) % order.length];
      en.sets.forEach(s => s.side = next); render();
    };
    const fl = v.querySelector('[data-flag]'); if (fl) fl.onclick = () => {
      en.videoFlagged = !en.videoFlagged;
      const i = S.flaggedVideos.indexOf(en.exerciseId);
      if (en.videoFlagged && i < 0) S.flaggedVideos.push(en.exerciseId);
      if (!en.videoFlagged && i >= 0) S.flaggedVideos.splice(i, 1);
      saveState(); render();
    };
    const tm = v.querySelector('[data-timer]'); if (tm) tm.onclick = () => {
      if (run.timer) { clearInterval(run.timer.int); run.timer = null; render(); return; }
      const total = restSecondsFor(EX[en.exerciseId]);
      run.timer = { left: total, endAt: Date.now() + total * 1000, int: setInterval(() => {
        if (!run || !run.timer) return;
        run.timer.left = Math.max(0, Math.round((run.timer.endAt - Date.now()) / 1000));
        const disp = document.getElementById('timerDisp'); if (disp) disp.textContent = fmtT(run.timer.left);
        if (run.timer.left <= 0) {
          clearInterval(run.timer.int); run.timer = null;
          try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
          beep(); if (route.tab === 'runner') render();
        }
      }, 250) };
      render();
    };
    const nx = v.querySelector('[data-next]'); if (nx) nx.onclick = () => {
      en.completed = en.sets.some(s => s.completed) || true; en.skipped = false;
      if (run.timer) { clearInterval(run.timer.int); run.timer = null; }
      run.idx++; render();
    };
    const pv = v.querySelector('[data-prev]'); if (pv) pv.onclick = () => { if (run.idx > 0) { run.idx--; } render(); };
    const sk = v.querySelector('[data-skip]'); if (sk) sk.onclick = () => {
      const reason = ['time','pain','equipment','other'][+prompt('Skip reason: 1 time · 2 pain · 3 equipment · 4 other', '1') - 1] || 'other';
      en.skipped = true; en.completed = false; en.skipReason = reason;
      run.idx++; render();
      toast('Skipped — that is data, not a gap.', () => { en.skipped = false; en.skipReason = null; run.idx--; render(); });
    };
    const q = v.querySelector('[data-quit]'); if (q) q.onclick = () => {
      go({ tab: 'today' });
      toast('Session paused — reopen it from Today.');
    };
    v.querySelectorAll('[data-sesf]').forEach(inp => inp.oninput = () => { run.log[inp.dataset.sesf] = inp.type === 'number' ? (inp.value === '' ? null : +inp.value) : inp.value; });
    const sv = v.querySelector('[data-save]'); if (sv) sv.onclick = saveRun;
    /* swipe to advance */
    let sx = null;
    v.ontouchstart = e => { sx = e.touches[0].clientX; };
    v.ontouchend = e => {
      if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null;
      if (Math.abs(dx) < 80 || e.target.closest('input,textarea,.setrow')) return;
      if (dx < 0 && run.idx < run.log.exercises.length) { run.idx++; render(); }
      else if (dx > 0 && run.idx > 0) { run.idx--; render(); }
    };
  }

  /* day log */
  if (route.tab === 'daylog' && dayDraft) {
    v.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => { dayDraft[b.dataset.toggle] = !dayDraft[b.dataset.toggle]; render(); });
    v.querySelectorAll('[data-seg]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.onclick = () => {
      dayDraft[seg.dataset.seg] = dayDraft[seg.dataset.seg] === b.dataset.v ? null : b.dataset.v; render();
    }));
    v.querySelectorAll('[data-mod]').forEach(b => b.onclick = () => { dayDraft[b.dataset.mod].used = !dayDraft[b.dataset.mod].used; render(); });
    v.querySelectorAll('[data-modmin]').forEach(i => i.oninput = () => { dayDraft[i.dataset.modmin].minutes = i.value === '' ? null : +i.value; });
    v.querySelectorAll('[data-modtime]').forEach(i => i.oninput = () => { dayDraft[i.dataset.modtime].timeOfDay = i.value || null; });
    v.querySelectorAll('[data-df]').forEach(i => i.oninput = () => { dayDraft[i.dataset.df] = i.type === 'number' ? (i.value === '' ? null : +i.value) : i.value; });
    const sv = v.querySelector('[data-saveday]'); if (sv) sv.onclick = saveDay;
  }

  /* library */
  const lq = v.querySelector('#libq'); if (lq) lq.oninput = () => { libQ = lq.value; const scroll = window.scrollY; render(); const nq = $('#libq'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); window.scrollTo(0, scroll); };
  const lr = v.querySelector('#libr'); if (lr) lr.onchange = () => { libRegion = lr.value; render(); };
  const le = v.querySelector('#libe'); if (le) le.onchange = () => { libEquip = le.value; render(); };

  /* settings */
  const sdI = v.querySelector('#startDate'); if (sdI) sdI.onchange = () => { if (sdI.value) { S.programStartDate = sdI.value; saveState(); render(); } };
  const us = v.querySelector('#unitSeg'); if (us) us.querySelectorAll('button').forEach(b => b.onclick = () => { S.units = b.dataset.v; saveState(); render(); });
  const th = v.querySelector('#themeSeg'); if (th) th.querySelectorAll('button').forEach(b => b.onclick = () => { S.theme = b.dataset.v; saveState(); applyTheme(); render(); });
  v.querySelectorAll('[data-export]').forEach(b => b.onclick = () => b.dataset.export === 'json' ? exportJSON() : exportCSV());
  const imp = v.querySelector('[data-import]'); if (imp) imp.onclick = () => $('#importFile').click();
  const impF = v.querySelector('#importFile'); if (impF) impF.onchange = () => { if (impF.files[0]) importJSON(impF.files[0]); };
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.15;
    o.start(); o.stop(ctx.currentTime + 0.4);
  } catch (e) {}
}

/* ---------- boot ---------- */
(async function boot() {
  loadState(); applyTheme(); updateOffline();
  window.addEventListener('online', updateOffline);
  window.addEventListener('offline', updateOffline);
  db = await openDB();
  if (db) {
    const st = await getRec('appState', 'state');
    if (st && st.v && !localStorage.getItem('caf-state')) { S = Object.assign({}, DEFAULT_STATE, st.v); }
  }
  saveState();
  await refreshCaches();
  render();
  try {
    if (navigator.storage && navigator.storage.persist) {
      storageInfo.persisted = await navigator.storage.persist();
      if (navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        storageInfo.usage = Math.round((est.usage || 0) / 1024) + ' KB used';
      }
      if (route.tab === 'settings') render();
    }
  } catch (e) {}
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('sw.js'); } catch (e) {} }
})();
