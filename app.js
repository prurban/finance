// ── Web/mobile mode ────────────────────────────────────────────────────────
// When there's no Electron bridge (window.api), we're running in a plain
// browser (e.g. on a phone) and talk to the cloud database directly.
const IS_WEB = !window.api;
if (IS_WEB) {
  const SYNC_KEY = 'pf-sync-url';
  const webValid = u => typeof u === 'string' && /^https:\/\/[^\s]+\.json$/.test(u.trim());
  const getUrl = () => (localStorage.getItem(SYNC_KEY) || '').trim();
  window.api = {
    loadData: async () => {
      const url = getUrl();
      if (!webValid(url)) return { transactions: [], recurring: [], bankBalance: 0, _needsSetup: true };
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      return (j && typeof j === 'object') ? j : { transactions: [], recurring: [], bankBalance: 0 };
    },
    saveData: async (d) => {
      const url = getUrl();
      if (!webValid(url)) return { ok: false };
      d.updatedAt = Date.now();
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return { ok: true };
    },
    getSyncUrl: async () => getUrl(),
    setSyncUrl: async (u) => {
      const t = (u || '').trim();
      if (t && !webValid(t)) return { ok: false, error: "That doesn't look like a sync code (it should start with https:// and end in .json)" };
      localStorage.setItem(SYNC_KEY, t);
      return { ok: true };
    },
    getSyncStatus: async () => ({ state: webValid(getUrl()) ? 'ok' : 'off', configured: webValid(getUrl()), lastSync: null, error: null }),
    syncNow: async () => ({ ok: true }),
    onRemoteUpdate: () => {},
    onSyncStatus: () => {},
  };
}

// ── Constants ──────────────────────────────────────────────────────────────
const TODAY = new Date().toISOString().split('T')[0];
const CYCLE_ANCHOR = '2026-06-19'; // first Friday of our pay cycle

const INCOME_CATS = ['salary', 'stripe', 'bank-transfer', 'other-income'];
const INCOME_LABELS = { salary: 'Salary/Wages', stripe: 'Stripe/Freelance', 'bank-transfer': 'Bank Transfer', 'other-income': 'Other Income' };
const EXPENSE_CATS = ['rent', 'groceries', 'transport', 'subscriptions', 'eating-out', 'health', 'entertainment', 'other'];
const EXPENSE_LABELS = { rent: 'Rent', groceries: 'Groceries', transport: 'Transport', subscriptions: 'Subscriptions', 'eating-out': 'Eating Out', health: 'Health', entertainment: 'Entertainment', other: 'Other' };

// ── State ──────────────────────────────────────────────────────────────────
let DATA = { transactions: [], recurring: [], suppressedRecurring: [], bankBalance: 0 };
let txFilter = 'all';
let txView = 'fn';
let sortNewest = false;
let fnChart = null;
let catChart = null;
let currentFnOffset = 0;

// ── Fortnightly helpers ────────────────────────────────────────────────────
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function getFortnightStart(dateStr) {
  const anchor = CYCLE_ANCHOR;
  const diff = daysBetween(anchor, dateStr);
  const offset = ((diff % 14) + 14) % 14;
  const startMs = new Date(dateStr).getTime() - offset * 86400000;
  return new Date(startMs).toISOString().split('T')[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function addMonths(dateStr, n) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().split('T')[0];
}

function fnLabel(startStr) {
  const end = addDays(startStr, 13);
  const fmt = (s) => new Date(s).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  return `${fmt(startStr)} - ${fmt(end)}`;
}

function fmtMoney(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);
}

function fmtDate(s) {
  return new Date(s).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateShort(s) {
  return new Date(s).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
}

function getFnNumber(fnStart) {
  return Math.round(daysBetween(CYCLE_ANCHOR, fnStart) / 14) + 1;
}

// ── Recurring -> transactions ───────────────────────────────────────────────
function generateRecurringDates(rec) {
  const dates = [];
  const cutoff = addDays(TODAY, 45); // through end of current month + buffer
  const start60 = addDays(TODAY, -60);
  let cur = rec.startDate;
  // fast-forward to within window
  if (cur < start60) {
    if (rec.frequency === 'weekly') {
      const weeks = Math.floor(daysBetween(cur, start60) / 7);
      cur = addDays(cur, weeks * 7);
    } else if (rec.frequency === 'fortnightly') {
      const fns = Math.floor(daysBetween(cur, start60) / 14);
      cur = addDays(cur, fns * 14);
    } else {
      const months = Math.floor(daysBetween(cur, start60) / 30);
      cur = addMonths(cur, months);
    }
  }
  let safety = 0;
  while (cur <= cutoff && safety < 500) {
    const pastEnd = rec.endDate && cur > rec.endDate;
    const pausedFuture = rec.paused && cur >= TODAY;
    if (cur >= start60 && !pastEnd && !pausedFuture) dates.push(cur);
    if (rec.frequency === 'weekly') cur = addDays(cur, 7);
    else if (rec.frequency === 'fortnightly') cur = addDays(cur, 14);
    else cur = addMonths(cur, 1);
    safety++;
  }
  return dates;
}

function buildRecurringTxs() {
  const suppressed = new Set(DATA.suppressedRecurring || []);
  const txs = [];
  for (const rec of DATA.recurring) {
    const dates = generateRecurringDates(rec);
    for (const d of dates) {
      const id = `rec-${rec.id}-${d}`;
      if (suppressed.has(id)) continue;
      txs.push({
        id,
        type: rec.type || 'expense',
        category: rec.category,
        amount: rec.amount,
        date: d,
        description: rec.name,
        isRecurring: true,
        recId: rec.id,
      });
    }
  }
  return txs;
}

function allTxs() {
  return [...DATA.transactions, ...buildRecurringTxs()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── Cleared (mark as paid) ─────────────────────────────────────────────────
function isCleared(t) {
  return t.isRecurring ? (DATA.clearedRecurring || []).includes(t.id) : !!t.cleared;
}

async function toggleCleared(t) {
  const clearing = !isCleared(t);
  if (t.isRecurring) {
    if (clearing) {
      // Materialize the occurrence into a permanent transaction so it stays
      // in the fortnight history forever (generated occurrences only exist
      // within a ~60-day window around today).
      if (!DATA.suppressedRecurring) DATA.suppressedRecurring = [];
      if (!DATA.suppressedRecurring.includes(t.id)) DATA.suppressedRecurring.push(t.id);
      DATA.transactions.push({
        id: 'tx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        type: t.type, category: t.category, amount: t.amount, date: t.date,
        description: t.description,
        cleared: true,
        fromRec: t.recId,
      });
    } else {
      // Legacy un-tick for occurrences cleared under the old scheme
      DATA.clearedRecurring = (DATA.clearedRecurring || []).filter(id => id !== t.id);
    }
  } else {
    const real = DATA.transactions.find(x => x.id === t.id);
    if (real) { if (clearing) real.cleared = true; else delete real.cleared; }
  }
  // Auto-adjust bank balance: expense out = minus, income in = plus (reversed on un-tick)
  const delta = (t.type === 'expense' ? -t.amount : t.amount) * (clearing ? 1 : -1);
  DATA.bankBalance = Math.round(((DATA.bankBalance || 0) + delta) * 100) / 100;
  DATA.balanceDate = TODAY;
  document.getElementById('bank-balance').value = DATA.bankBalance;
  document.getElementById('balance-updated').textContent = 'Updated ' + fmtDate(TODAY);
  await save();
  renderAll();
  toast(clearing
    ? `Marked paid — balance now ${fmtMoney(DATA.bankBalance)}`
    : `Un-marked — balance now ${fmtMoney(DATA.bankBalance)}`);
}

function clearBtnHtml(t) {
  const on = isCleared(t);
  return `<button class="tx-clear ${on ? 'on' : ''}" data-cid="${t.id}" title="${on ? 'Paid — click to undo' : 'Mark as paid (updates bank balance)'}">&#10003;</button>`;
}

function wireClearButtons(rootEl, txById) {
  rootEl.querySelectorAll('.tx-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = txById[btn.dataset.cid];
      if (t) toggleCleared(t);
    });
  });
}

// ── Liquid Cash ────────────────────────────────────────────────────────────
function liquidCash() {
  const txs = allTxs();
  const nextPayout = txs.find(t => t.type === 'income' && (t.category === 'stripe' || t.category === 'salary') && t.date >= TODAY);
  const cutoffDate = nextPayout ? nextPayout.date : addDays(getFortnightStart(TODAY), 13);
  const payoutLabel = nextPayout
    ? `Before ${INCOME_LABELS[nextPayout.category]} on ${fmtDate(nextPayout.date)}`
    : `Until end of fortnight (${fmtDate(cutoffDate)})`;
  const expensesUntilPayout = txs
    .filter(t => t.type === 'expense' && !isCleared(t) && t.date >= TODAY && t.date < cutoffDate)
    .reduce((s, t) => s + t.amount, 0);
  const pool = (DATA.bankBalance || 0) - expensesUntilPayout;
  return { pool, payoutLabel, expensesUntilPayout };
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

// ── Persist ────────────────────────────────────────────────────────────────
async function save() {
  try {
    await window.api.saveData(DATA);
    toast('Saved');
  } catch (e) {
    toast('Save failed — check your internet connection');
  }
}

// ── Cloud sync UI helpers ──────────────────────────────────────────────────
function ensureDefaults(d) {
  if (!d.transactions) d.transactions = [];
  if (!d.recurring) d.recurring = [];
  if (!d.suppressedRecurring) d.suppressedRecurring = [];
  if (!d.clearedRecurring) d.clearedRecurring = [];
  if (!d.goals) d.goals = [];
  if (!d.bankBalance) d.bankBalance = 0;
  return d;
}

function applyRemote(remote) {
  if (editCtx) return; // don't clobber the screen mid-edit
  DATA = ensureDefaults(remote);
  document.getElementById('bank-balance').value = DATA.bankBalance || '';
  if (DATA.balanceDate) {
    document.getElementById('balance-updated').textContent = 'Updated ' + fmtDate(DATA.balanceDate);
  }
  renderAll();
  toast('Synced');
}

function renderSyncStatus(s) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.title = '';
  if (!s.configured) { el.textContent = 'Not connected'; el.style.color = '#555'; }
  else if (s.state === 'error') { el.textContent = 'Sync error'; el.style.color = '#f04a4a'; el.title = s.error || ''; }
  else if (s.state === 'connecting') { el.textContent = 'Connecting…'; el.style.color = '#e0a840'; }
  else { el.textContent = 'Synced ✓'; el.style.color = '#c8f04a'; }
}

async function webRefresh() {
  if (!IS_WEB || editCtx) return;
  try {
    const remote = await window.api.loadData();
    if (remote && !remote._needsSetup && (remote.updatedAt || 0) > (DATA.updatedAt || 0)) {
      applyRemote(remote);
    }
  } catch (_) {}
}

// ── Edit modal ─────────────────────────────────────────────────────────────
let editCtx = null; // {kind:'tx'|'rec'|'occ', id?, recId?, occDate?, scope?}

function showEl(el, on) { el.style.display = on ? '' : 'none'; }

function editBtnHtml(t) {
  const attrs = t.isRecurring
    ? `data-kind="occ" data-recid="${t.recId}" data-date="${t.date}"`
    : `data-kind="tx" data-id="${t.id}"`;
  return `<button class="tx-edit" ${attrs} title="Edit">&#9998;</button>`;
}

function wireEditButtons(rootEl) {
  rootEl.querySelectorAll('.tx-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.kind === 'occ') {
        openEditor({ kind: 'occ', recId: btn.dataset.recid, occDate: btn.dataset.date, scope: 'series' });
      } else {
        openEditor({ kind: 'tx', id: btn.dataset.id });
      }
    });
  });
}

function openEditor(ctx) {
  editCtx = ctx;
  const isSeries = ctx.kind === 'rec' || (ctx.kind === 'occ' && ctx.scope === 'series');
  document.getElementById('modal-title').textContent =
    (ctx.kind === 'tx') ? 'Edit Transaction' : 'Edit Recurring Transaction';
  showEl(document.getElementById('modal-scope'), ctx.kind === 'occ');
  if (ctx.kind === 'occ') {
    document.getElementById('scope-series').classList.toggle('active', ctx.scope === 'series');
    document.getElementById('scope-one').classList.toggle('active', ctx.scope === 'one');
  }
  showEl(document.getElementById('md-name-wrap'), isSeries);
  showEl(document.getElementById('md-freq-wrap'), isSeries);
  showEl(document.getElementById('md-end-wrap'), isSeries);
  showEl(document.getElementById('md-desc-wrap'), !isSeries);
  document.getElementById('md-date-label').textContent = isSeries ? 'First occurrence' : 'Date';

  const typeSel = document.getElementById('md-type');
  const catSel = document.getElementById('md-cat');

  if (ctx.kind === 'tx') {
    const t = DATA.transactions.find(x => x.id === ctx.id);
    if (!t) return;
    typeSel.value = t.type;
    populateCatSelect(catSel, t.type);
    catSel.value = t.category;
    document.getElementById('md-amount').value = t.amount;
    document.getElementById('md-date').value = t.date;
    document.getElementById('md-desc').value = t.description || '';
  } else {
    const rec = DATA.recurring.find(r => r.id === ctx.recId);
    if (!rec) return;
    const recType = rec.type || 'expense';
    typeSel.value = recType;
    populateCatSelect(catSel, recType);
    catSel.value = rec.category;
    document.getElementById('md-amount').value = rec.amount;
    if (isSeries) {
      document.getElementById('md-name').value = rec.name;
      document.getElementById('md-freq').value = rec.frequency;
      document.getElementById('md-date').value = rec.startDate;
      document.getElementById('md-end').value = rec.endDate || '';
    } else {
      document.getElementById('md-date').value = ctx.occDate;
      document.getElementById('md-desc').value = rec.name;
    }
  }
  document.getElementById('modal-backdrop').classList.add('open');
}

function closeEditor() {
  document.getElementById('modal-backdrop').classList.remove('open');
  editCtx = null;
}

async function saveEditor() {
  if (!editCtx) return;
  const amount = parseFloat(document.getElementById('md-amount').value);
  const date = document.getElementById('md-date').value;
  if (!amount || amount <= 0) { toast('Enter a valid amount'); return; }
  if (!date) { toast('Pick a date'); return; }
  const type = document.getElementById('md-type').value;
  const category = document.getElementById('md-cat').value;

  if (editCtx.kind === 'tx') {
    const t = DATA.transactions.find(x => x.id === editCtx.id);
    if (t) {
      t.type = type; t.category = category; t.amount = amount; t.date = date;
      const desc = document.getElementById('md-desc').value.trim();
      if (desc) t.description = desc;
    }
  } else if (editCtx.kind === 'rec' || editCtx.scope === 'series') {
    const rec = DATA.recurring.find(r => r.id === editCtx.recId);
    if (rec) {
      const name = document.getElementById('md-name').value.trim();
      if (!name) { toast('Enter a name'); return; }
      const endDate = document.getElementById('md-end').value;
      if (endDate && endDate < date) { toast('End date must be after the start date'); return; }
      rec.name = name; rec.type = type; rec.category = category;
      rec.amount = amount;
      rec.frequency = document.getElementById('md-freq').value;
      rec.startDate = date;
      if (endDate) rec.endDate = endDate; else delete rec.endDate;
    }
  } else {
    // Just this one: detach this occurrence from the series as a one-off
    const occId = `rec-${editCtx.recId}-${editCtx.occDate}`;
    if (!DATA.suppressedRecurring) DATA.suppressedRecurring = [];
    if (!DATA.suppressedRecurring.includes(occId)) DATA.suppressedRecurring.push(occId);
    DATA.transactions.push({
      id: 'tx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type, category, amount, date,
      description: document.getElementById('md-desc').value.trim() ||
        (type === 'income' ? INCOME_LABELS[category] : EXPENSE_LABELS[category]),
    });
  }
  await save();
  closeEditor();
  renderAll();
}

// ── Category selects ───────────────────────────────────────────────────────
function populateCatSelect(selectEl, type) {
  const cats = type === 'income' ? INCOME_CATS : EXPENSE_CATS;
  const labels = type === 'income' ? INCOME_LABELS : EXPENSE_LABELS;
  selectEl.innerHTML = cats.map(c => `<option value="${c}">${labels[c]}</option>`).join('');
}

// ── Dashboard ──────────────────────────────────────────────────────────────
function renderDashboard() {
  const fnStart = addDays(getFortnightStart(TODAY), currentFnOffset * 14);
  const fnEnd = addDays(fnStart, 13);
  const isCurrent = fnStart === getFortnightStart(TODAY);
  const txs = allTxs().filter(t => t.date >= fnStart && t.date <= fnEnd);

  // Header labels
  const fnNum = getFnNumber(fnStart);
  document.getElementById('fn-num-label').textContent = `Fortnight ${String(fnNum).padStart(2, '0')}`;
  document.getElementById('fn-range-label').innerHTML =
    `${fmtDateShort(fnStart)} &mdash; ${fmtDateShort(fnEnd)}` +
    (isCurrent ? ' <span class="fn-cur-badge">CURRENT</span>' : '');

  // Totals
  const incomeTxs = txs.filter(t => t.type === 'income');
  const expenseTxs = txs.filter(t => t.type === 'expense');
  const bankBal = DATA.bankBalance || 0;
  // Cleared (paid) items are already reflected in the bank balance, so they
  // stay visible but are excluded from the totals to avoid double-counting.
  const totalIn = bankBal + incomeTxs.filter(t => !isCleared(t)).reduce((s, t) => s + t.amount, 0);
  const totalOut = expenseTxs.filter(t => !isCleared(t)).reduce((s, t) => s + t.amount, 0);
  const pool = totalIn - totalOut;

  // Money In rows
  const bankRow = `<div class="ov-row">
    <span class="ov-lbl">Bank Balance</span>
    <span class="ov-sub">${DATA.balanceDate ? 'as of ' + fmtDate(DATA.balanceDate) : 'not set'}</span>
    <span class="ov-amt inc">${fmtMoney(bankBal)}</span>
  </div>`;

  const incomeRows = incomeTxs.map(t => `<div class="ov-row ${isCleared(t) ? 'cleared' : ''}">
    ${clearBtnHtml(t)}
    <span class="ov-lbl">${t.description || INCOME_LABELS[t.category] || t.category}${t.isRecurring ? '<span class="ov-rec-tag">recurring</span>' : ''}</span>
    <span class="ov-sub">${fmtDate(t.date)}</span>
    <span class="ov-amt inc">${fmtMoney(t.amount)}</span>
    ${editBtnHtml(t)}
    <button class="tx-del" data-id="${t.id}" data-rec="${!!t.isRecurring}" title="Remove">&#x2715;</button>
  </div>`).join('');

  // Money Out rows
  const expenseRows = expenseTxs.length
    ? expenseTxs.map(t => `<div class="ov-row ${isCleared(t) ? 'cleared' : ''}">
        ${clearBtnHtml(t)}
        <span class="ov-lbl">${t.description || EXPENSE_LABELS[t.category] || t.category}${t.isRecurring ? '<span class="ov-rec-tag">recurring</span>' : ''}</span>
        <span class="ov-sub">${fmtDate(t.date)}</span>
        <span class="ov-amt exp">${fmtMoney(t.amount)}</span>
        ${editBtnHtml(t)}
        <button class="tx-del" data-id="${t.id}" data-rec="${!!t.isRecurring}" title="Remove">&#x2715;</button>
      </div>`).join('')
    : `<div class="ov-row"><span class="ov-lbl" style="color:#444;font-style:italic">No expenses this fortnight</span></div>`;

  document.getElementById('fn-overview').innerHTML = `
    <div class="ov-wrap">
      <div class="ov-head income">&#9660;&nbsp; Money In</div>
      ${bankRow}${incomeRows}
      <div class="ov-total income"><span>Total In</span><span class="ov-total-val">${fmtMoney(totalIn)}</span></div>
    </div>
    <div class="ov-wrap">
      <div class="ov-head expense">&#9660;&nbsp; Money Out</div>
      ${expenseRows}
      <div class="ov-total expense"><span>Total Out</span><span class="ov-total-val">${fmtMoney(totalOut)}</span></div>
    </div>
    <div class="pool-block">
      <div class="pool-lbl">
        <div class="pool-lbl-title">Pool</div>
        <div class="pool-lbl-sub">${pool >= 0 ? 'Surplus this fortnight' : 'Overspent this fortnight'}</div>
      </div>
      <span class="pool-val ${pool >= 0 ? 'pos' : 'neg'}">${fmtMoney(pool)}</span>
    </div>
  `;

  // Wire delete buttons in overview
  document.getElementById('fn-overview').querySelectorAll('.tx-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (btn.dataset.rec === 'true') {
        if (!DATA.suppressedRecurring) DATA.suppressedRecurring = [];
        DATA.suppressedRecurring.push(id);
      } else {
        DATA.transactions = DATA.transactions.filter(t => t.id !== id);
      }
      await save();
      renderDashboard();
    });
  });
  wireEditButtons(document.getElementById('fn-overview'));
  const txById = {};
  txs.forEach(t => { txById[t.id] = t; });
  wireClearButtons(document.getElementById('fn-overview'), txById);

  renderFnChart();
}

function renderFnChart() {
  const txs = allTxs();
  if (!txs.length) return;

  // collect unique fortnights
  const fnMap = {};
  for (const t of txs) {
    const fs = getFortnightStart(t.date);
    if (!fnMap[fs]) fnMap[fs] = { income: 0, expenses: 0 };
    if (t.type === 'income') fnMap[fs].income += t.amount;
    else fnMap[fs].expenses += t.amount;
  }
  // Show up to the current fortnight plus the next planned one, last 12 total
  const curFn = getFortnightStart(TODAY);
  const nextFn = addDays(curFn, 14);
  const keys = Object.keys(fnMap).sort().filter(k => k <= nextFn).slice(-12);
  const labels = keys.map(k => fnLabel(k) + (k === curFn ? ' •NOW' : (k === nextFn ? ' (next)' : '')));
  const incomeData = keys.map(k => fnMap[k].income);
  const expData = keys.map(k => fnMap[k].expenses);
  const netData = keys.map(k => fnMap[k].income - fnMap[k].expenses);

  const ctx = document.getElementById('fn-chart').getContext('2d');
  if (fnChart) fnChart.destroy();
  fnChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Money In', data: incomeData, backgroundColor: '#c8f04a88', borderColor: '#c8f04a', borderWidth: 2, borderRadius: 4, order: 2 },
        { label: 'Money Out', data: expData, backgroundColor: '#f04a4a55', borderColor: '#f04a4a', borderWidth: 2, borderRadius: 4, order: 2 },
        { type: 'line', label: 'Net (In − Out)', data: netData, borderColor: '#e0e0e0', backgroundColor: '#e0e0e0', borderWidth: 2, tension: 0.3, pointRadius: 3, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { labels: { color: '#888', font: { size: 12 } } } },
      scales: {
        x: { ticks: { color: '#555', maxRotation: 30 }, grid: { color: '#1e1e1e' } },
        y: { ticks: { color: '#555', callback: v => fmtMoney(v) }, grid: { color: '#1e1e1e' } },
      },
    },
  });
}

// ── Transactions tab ───────────────────────────────────────────────────────
function renderTransactions() {
  const txType = document.getElementById('tx-type');
  populateCatSelect(document.getElementById('tx-cat'), txType.value);

  let txs = allTxs();
  if (txFilter !== 'all') txs = txs.filter(t => t.type === txFilter);
  if (!sortNewest) txs = txs.slice().reverse();

  // group
  const groups = {};
  for (const t of txs) {
    const key = txView === 'fn' ? getFortnightStart(t.date) : t.date.slice(0, 7) + '-W' + getWeekNum(t.date);
    const label = txView === 'fn' ? fnLabel(getFortnightStart(t.date)) : weekLabel(t.date);
    if (!groups[key]) groups[key] = { label, items: [] };
    groups[key].items.push(t);
  }

  const sortedKeys = Object.keys(groups).sort((a, b) => sortNewest ? b.localeCompare(a) : a.localeCompare(b));

  const el = document.getElementById('tx-list');
  if (!sortedKeys.length) { el.innerHTML = '<div class="empty">No transactions yet.</div>'; return; }

  el.innerHTML = sortedKeys.map(key => {
    const g = groups[key];
    const groupIncome = g.items.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const groupExp = g.items.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const rows = g.items.map(t => {
      const isRec = t.isRecurring;
      const dotClass = isRec ? 'recurring' : t.type;
      const amtClass = t.type === 'income' ? 'income' : 'expense';
      const sign = t.type === 'income' ? '+' : '-';
      const catLabel = t.type === 'income' ? (INCOME_LABELS[t.category] || t.category) : (EXPENSE_LABELS[t.category] || t.category);
      const delBtn = `${editBtnHtml(t)}<button class="tx-del" data-id="${t.id}" data-rec="${isRec}" title="Delete">&#x2715;</button>`;
      return `<div class="tx-row ${isCleared(t) ? 'cleared' : ''}">
        ${clearBtnHtml(t)}
        <div class="tx-dot ${dotClass}"></div>
        <div class="tx-info">
          <div class="tx-desc">${t.description || '-'}</div>
          <div class="tx-meta">${fmtDate(t.date)}${isRec ? ' · <span style="color:#a78bfa">Recurring</span>' : ''}${isCleared(t) ? ' · <span style="color:#c8f04a">Paid</span>' : ''}</div>
        </div>
        <span class="tx-cat">${catLabel}</span>
        <span class="tx-amount ${amtClass}">${sign}${fmtMoney(t.amount)}</span>
        ${delBtn}
      </div>`;
    }).join('');

    const summaryBits = [];
    if (groupIncome) summaryBits.push(`<span style="color:#c8f04a">+${fmtMoney(groupIncome)}</span>`);
    if (groupExp) summaryBits.push(`<span style="color:#f04a4a">-${fmtMoney(groupExp)}</span>`);

    return `<div class="tx-group">
      <div class="tx-group-header">${g.label} &nbsp;${summaryBits.join(' &nbsp; ')}</div>
      ${rows}
    </div>`;
  }).join('');

  // delete handlers
  el.querySelectorAll('.tx-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (btn.dataset.rec === 'true') {
        if (!DATA.suppressedRecurring) DATA.suppressedRecurring = [];
        DATA.suppressedRecurring.push(id);
      } else {
        DATA.transactions = DATA.transactions.filter(t => t.id !== id);
      }
      await save();
      renderAll();
    });
  });
  wireEditButtons(el);
  const txById = {};
  txs.forEach(t => { txById[t.id] = t; });
  wireClearButtons(el, txById);
}

function getWeekNum(dateStr) {
  const d = new Date(dateStr);
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7);
}
function weekLabel(dateStr) {
  const d = new Date(dateStr);
  const mon = new Date(d);
  mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const fmt = s => s.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  return `${fmt(mon)} - ${fmt(sun)}`;
}

// ── Recurring tab ──────────────────────────────────────────────────────────
function renderRecurring() {
  populateCatSelect(document.getElementById('rec-cat'), 'expense');

  const el = document.getElementById('rec-list');
  if (!DATA.recurring.length) { el.innerHTML = '<div class="empty">No recurring expenses set up yet.</div>'; return; }
  el.innerHTML = DATA.recurring.map(r => {
    const isIncome = (r.type || 'expense') === 'income';
    const catLabel = isIncome ? (INCOME_LABELS[r.category] || r.category) : (EXPENSE_LABELS[r.category] || r.category);
    const freqLabel = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly' }[r.frequency];
    const amtColor = isIncome ? '#c8f04a' : '#a78bfa';
    const typeTag = isIncome
      ? `<span style="font-size:10px;background:#c8f04a22;color:#c8f04a;border:1px solid #c8f04a44;border-radius:6px;padding:1px 7px;margin-right:6px">income</span>`
      : `<span style="font-size:10px;background:#a78bfa22;color:#a78bfa;border:1px solid #a78bfa44;border-radius:6px;padding:1px 7px;margin-right:6px">expense</span>`;
    const pausedTag = r.paused
      ? `<span style="font-size:10px;background:#e0a84022;color:#e0a840;border:1px solid #e0a84044;border-radius:6px;padding:1px 7px;margin-left:6px">paused</span>`
      : '';
    const untilTxt = r.endDate ? ` · until ${fmtDate(r.endDate)}` : '';
    return `<div class="rec-row">
      <div class="rec-info">
        <div class="rec-name">${typeTag}${r.name}${pausedTag}</div>
        <div class="rec-meta">${catLabel} · ${freqLabel} · from ${fmtDate(r.startDate)}${untilTxt}</div>
      </div>
      <span class="rec-amount" style="color:${amtColor}">${fmtMoney(r.amount)}</span>
      <button class="rec-pause ${r.paused ? 'on' : ''}" data-id="${r.id}" title="${r.paused ? 'Resume — occurrences start generating again' : 'Pause — stops future occurrences, keeps history'}">${r.paused ? '&#9654;' : '&#10074;&#10074;'}</button>
      <button class="rec-edit" data-id="${r.id}" title="Edit (applies to all occurrences)">&#9998;</button>
      <button class="rec-del" data-id="${r.id}" title="Delete">&#x2715;</button>
    </div>`;
  }).join('');

  el.querySelectorAll('.rec-pause').forEach(btn => {
    btn.addEventListener('click', async () => {
      const rec = DATA.recurring.find(r => r.id === btn.dataset.id);
      if (!rec) return;
      rec.paused = !rec.paused;
      if (!rec.paused) delete rec.paused;
      await save();
      renderAll();
      toast(rec.paused ? 'Paused — no new occurrences' : 'Resumed');
    });
  });

  el.querySelectorAll('.rec-edit').forEach(btn => {
    btn.addEventListener('click', () => openEditor({ kind: 'rec', recId: btn.dataset.id }));
  });

  el.querySelectorAll('.rec-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      DATA.recurring = DATA.recurring.filter(r => r.id !== btn.dataset.id);
      await save();
      renderAll();
    });
  });
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
}

// ── Goals ──────────────────────────────────────────────────────────────────
function armDelete(btn, label, onConfirm) {
  if (btn.dataset.armed === '1') { onConfirm(); return; }
  btn.dataset.armed = '1';
  const original = btn.textContent;
  btn.textContent = label;
  btn.classList.add('armed');
  setTimeout(() => {
    if (btn.dataset.armed === '1') { btn.dataset.armed = '0'; btn.textContent = original; btn.classList.remove('armed'); }
  }, 4000);
}

function goalSaved(g) { return (g.contributions || []).reduce((s, c) => s + c.amount, 0); }

function goalStats(g) {
  const saved = goalSaved(g);
  const target = +g.target || 0;
  const out = [];
  if (target > 0) {
    const remaining = Math.max(0, target - saved);
    out.push(`<span class="goal-stat">${Math.min(100, Math.round(saved / target * 100))}% there</span>`);
    if (remaining === 0) {
      out.push(`<span class="goal-stat" style="color:#c8f04a;border-color:#c8f04a55">GOAL REACHED! &#127881;</span>`);
    } else {
      if (g.targetDate && g.targetDate > TODAY) {
        const fnLeft = Math.max(1, Math.ceil(daysBetween(TODAY, g.targetDate) / 14));
        out.push(`<span class="goal-stat" style="color:${g.color}">Put away ${fmtMoney(remaining / fnLeft)}/fortnight to hit it by ${fmtDate(g.targetDate)}</span>`);
      }
      const cons = (g.contributions || []).slice().sort((a, b) => a.date.localeCompare(b.date));
      if (cons.length >= 2) {
        const spanDays = Math.max(14, daysBetween(cons[0].date, TODAY));
        const perFn = saved / (spanDays / 14);
        if (perFn > 0) {
          const fnNeeded = Math.ceil(remaining / perFn);
          out.push(`<span class="goal-stat">At your current pace (${fmtMoney(perFn)}/fn) you'll get there ~${fmtDate(addDays(TODAY, fnNeeded * 14))}</span>`);
        }
      }
    }
  } else {
    out.push(`<span class="goal-stat">Set a target below to unlock the "per fortnight" plan</span>`);
  }
  return out.join('');
}

function renderGoals() {
  const el = document.getElementById('goals-list');
  if (!el) return;
  const goals = DATA.goals || [];
  el.innerHTML = goals.length ? goals.map(g => {
    const saved = goalSaved(g);
    const target = +g.target || 0;
    const pct = target > 0 ? Math.min(100, saved / target * 100) : 0;
    const cons = (g.contributions || []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    return `<div class="goal-card" data-gid="${g.id}">
      <div class="goal-head">
        <span style="font-size:22px">${g.emoji || '⭐'}</span>
        <span class="goal-name">${g.name}</span>
        <button class="icon-btn g-edit" title="Edit target/date">&#9998;</button>
        <button class="mng-del g-del">Delete</button>
      </div>
      <div class="goal-amounts" style="color:${g.color || '#c8f04a'}">${fmtMoney(saved)} <span class="of">${target > 0 ? 'of ' + fmtMoney(target) : '— no target set yet'}${g.targetDate ? ' by ' + fmtDate(g.targetDate) : ''}</span></div>
      <div class="goal-track"><div class="goal-fill" style="width:${pct}%;background:${g.color || '#c8f04a'}"></div></div>
      <div class="goal-stats">${goalStats(g)}</div>
      <div class="goal-edit-row" style="display:none">
        <input type="number" class="g-target" placeholder="Target $" value="${target || ''}" step="0.01" min="0"/>
        <input type="date" class="g-date" value="${g.targetDate || ''}"/>
        <button class="btn-save g-save">Save</button>
      </div>
      <div class="goal-add">
        <input type="number" class="g-amt" placeholder="Amount $" step="0.01" min="0"/>
        <input type="text" class="g-note" placeholder="Note (optional)"/>
        <label><input type="checkbox" class="g-frombal" checked/> take from bank balance</label>
        <button class="btn-add" style="margin-top:0" data-gadd>+ Put Away</button>
      </div>
      <div class="goal-contribs">${cons.map(c => `
        <div class="gc-row"><span class="amt">+${fmtMoney(c.amount)}</span><span class="d">${fmtDate(c.date)}</span><span class="n">${c.note || ''}</span>
        <button class="icon-btn gc-del" data-cid="${c.id}" title="Remove (reverses balance if it was deducted)">&#x2715;</button></div>`).join('')}
        ${(g.contributions || []).length > 5 ? `<div class="gc-row" style="color:#555">… ${(g.contributions).length - 5} earlier</div>` : ''}
      </div>
    </div>`;
  }).join('') : '<div class="empty">No goals yet — add your first below.</div>';

  el.querySelectorAll('.goal-card').forEach(card => {
    const g = (DATA.goals || []).find(x => x.id === card.dataset.gid);
    if (!g) return;
    card.querySelector('.g-edit').addEventListener('click', () => {
      const row = card.querySelector('.goal-edit-row');
      row.style.display = row.style.display === 'none' ? 'flex' : 'none';
    });
    card.querySelector('.g-save').addEventListener('click', async () => {
      g.target = parseFloat(card.querySelector('.g-target').value) || 0;
      const dt = card.querySelector('.g-date').value;
      if (dt) g.targetDate = dt; else delete g.targetDate;
      await save(); renderGoals();
    });
    card.querySelector('.g-del').addEventListener('click', (e) => {
      armDelete(e.target, 'Tap again to delete', async () => {
        DATA.goals = (DATA.goals || []).filter(x => x.id !== g.id);
        await save(); renderGoals();
        toast(`Goal "${g.name}" deleted`);
      });
    });
    card.querySelector('[data-gadd]').addEventListener('click', async () => {
      const amount = parseFloat(card.querySelector('.g-amt').value);
      if (!amount || amount <= 0) { toast('Enter an amount first'); return; }
      const fromBal = card.querySelector('.g-frombal').checked;
      if (!g.contributions) g.contributions = [];
      g.contributions.push({ id: 'gc-' + Date.now(), date: TODAY, amount, note: card.querySelector('.g-note').value.trim(), fromBalance: fromBal });
      if (fromBal) {
        DATA.bankBalance = Math.round(((DATA.bankBalance || 0) - amount) * 100) / 100;
        DATA.balanceDate = TODAY;
        document.getElementById('bank-balance').value = DATA.bankBalance;
      }
      await save(); renderGoals(); renderDashboard();
      toast(`${fmtMoney(amount)} put towards ${g.name}!`);
    });
    card.querySelectorAll('.gc-del').forEach(btn => btn.addEventListener('click', async () => {
      const c = (g.contributions || []).find(x => x.id === btn.dataset.cid);
      if (!c) return;
      g.contributions = g.contributions.filter(x => x.id !== c.id);
      if (c.fromBalance) {
        DATA.bankBalance = Math.round(((DATA.bankBalance || 0) + c.amount) * 100) / 100;
        DATA.balanceDate = TODAY;
        document.getElementById('bank-balance').value = DATA.bankBalance;
      }
      await save(); renderGoals(); renderDashboard();
    }));
  });
}

// ── Render all ─────────────────────────────────────────────────────────────
function renderAll() {
  renderDashboard();
  renderTransactions();
  renderRecurring();
  renderGoals();
}

// ── Event wiring ───────────────────────────────────────────────────────────
function wireEvents() {
  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'transactions') renderTransactions();
      if (btn.dataset.tab === 'recurring') renderRecurring();
      if (btn.dataset.tab === 'dashboard') renderDashboard();
    });
  });

  // Fortnight navigation
  document.getElementById('fn-prev').addEventListener('click', () => { currentFnOffset--; renderDashboard(); });
  document.getElementById('fn-next').addEventListener('click', () => { currentFnOffset++; renderDashboard(); });

  // Bank balance
  document.getElementById('save-balance-btn').addEventListener('click', async () => {
    DATA.bankBalance = parseFloat(document.getElementById('bank-balance').value) || 0;
    DATA.balanceDate = TODAY;
    document.getElementById('balance-updated').textContent = 'Updated ' + fmtDate(TODAY);
    await save();
    renderDashboard();
  });

  // Tx type change -> update categories
  document.getElementById('tx-type').addEventListener('change', e => {
    populateCatSelect(document.getElementById('tx-cat'), e.target.value);
  });

  // Set default tx date
  document.getElementById('tx-date').value = TODAY;
  document.getElementById('rec-start').value = TODAY;

  // Add transaction
  document.getElementById('add-tx-btn').addEventListener('click', async () => {
    const type = document.getElementById('tx-type').value;
    const cat = document.getElementById('tx-cat').value;
    const amount = parseFloat(document.getElementById('tx-amount').value);
    const date = document.getElementById('tx-date').value;
    const desc = document.getElementById('tx-desc').value.trim();
    if (!amount || amount <= 0) { toast('Enter a valid amount'); return; }
    if (!date) { toast('Pick a date'); return; }
    DATA.transactions.push({
      id: 'tx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      type, category: cat, amount, date,
      description: desc || (type === 'income' ? INCOME_LABELS[cat] : EXPENSE_LABELS[cat]),
    });
    document.getElementById('tx-amount').value = '';
    document.getElementById('tx-desc').value = '';
    await save();
    renderAll();
  });

  // Tx filters
  document.querySelectorAll('[data-txf]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-txf]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      txFilter = btn.dataset.txf;
      renderTransactions();
    });
  });

  // View toggle (fortnightly / weekly)
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-view]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      txView = btn.dataset.view;
      renderTransactions();
    });
  });

  // Sort toggle
  document.getElementById('sort-toggle').addEventListener('click', e => {
    sortNewest = !sortNewest;
    e.target.textContent = sortNewest ? 'Oldest first' : 'Newest first';
    e.target.classList.toggle('active', sortNewest);
    renderTransactions();
  });

  // Recurring type change -> update categories
  document.getElementById('rec-type').addEventListener('change', e => {
    populateCatSelect(document.getElementById('rec-cat'), e.target.value);
  });

  // Add goal
  document.getElementById('add-goal-btn').addEventListener('click', async () => {
    const name = document.getElementById('goal-name').value.trim();
    if (!name) { toast('Give the goal a name'); return; }
    if (!DATA.goals) DATA.goals = [];
    const PALETTE = ['#c8f04a', '#f472b6', '#34d399', '#60a5fa', '#fbbf24', '#a78bfa'];
    DATA.goals.push({
      id: 'goal-' + Date.now(),
      name,
      emoji: '⭐',
      color: PALETTE[DATA.goals.length % PALETTE.length],
      target: parseFloat(document.getElementById('goal-target').value) || 0,
      targetDate: document.getElementById('goal-date').value || undefined,
      contributions: [],
    });
    document.getElementById('goal-name').value = '';
    document.getElementById('goal-target').value = '';
    document.getElementById('goal-date').value = '';
    await save(); renderGoals();
    toast('Goal added!');
  });

  // Add recurring
  document.getElementById('add-rec-btn').addEventListener('click', async () => {
    const name = document.getElementById('rec-name').value.trim();
    const type = document.getElementById('rec-type').value;
    const cat = document.getElementById('rec-cat').value;
    const amount = parseFloat(document.getElementById('rec-amount').value);
    const freq = document.getElementById('rec-freq').value;
    const startDate = document.getElementById('rec-start').value;
    if (!name) { toast('Enter a name'); return; }
    if (!amount || amount <= 0) { toast('Enter a valid amount'); return; }
    if (!startDate) { toast('Pick a start date'); return; }
    DATA.recurring.push({
      id: 'rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      name, type, category: cat, amount, frequency: freq, startDate,
    });
    document.getElementById('rec-name').value = '';
    document.getElementById('rec-amount').value = '';
    await save();
    renderAll();
  });

  // Cloud sync
  document.getElementById('save-sync-btn').addEventListener('click', async () => {
    const url = document.getElementById('sync-url').value;
    const banner = document.getElementById('setup-banner');
    const firstRun = banner.style.display !== 'none';
    const r = await window.api.setSyncUrl(url);
    if (!r.ok) { toast(r.error || 'Invalid sync code'); return; }
    if (!url.trim()) {
      toast('Sync turned off');
      renderSyncStatus({ configured: false });
      return;
    }
    banner.style.display = 'none';
    if (IS_WEB) {
      try {
        const remote = await window.api.loadData();
        if (remote && !remote._needsSetup) applyRemote(remote);
        toast('Connected!');
        if (firstRun) switchTab('dashboard');
      } catch (e) {
        toast('Could not reach the cloud — double-check the code');
      }
    } else {
      toast('Connected!');
      if (firstRun) switchTab('dashboard');
    }
    renderSyncStatus(await window.api.getSyncStatus());
  });

  // Backup download
  document.getElementById('backup-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'personal-finance-backup-' + TODAY + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Backup downloaded');
  });

  // Edit modal
  document.getElementById('md-cancel').addEventListener('click', closeEditor);
  document.getElementById('md-save').addEventListener('click', saveEditor);
  document.getElementById('modal-backdrop').addEventListener('click', e => {
    if (e.target.id === 'modal-backdrop') closeEditor();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && editCtx) closeEditor();
  });
  document.getElementById('md-type').addEventListener('change', e => {
    populateCatSelect(document.getElementById('md-cat'), e.target.value);
  });
  document.getElementById('scope-series').addEventListener('click', () => {
    if (editCtx && editCtx.kind === 'occ') openEditor({ ...editCtx, scope: 'series' });
  });
  document.getElementById('scope-one').addEventListener('click', () => {
    if (editCtx && editCtx.kind === 'occ') openEditor({ ...editCtx, scope: 'one' });
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────
(async function init() {
  try {
    DATA = await window.api.loadData();
  } catch (e) {
    DATA = { transactions: [], recurring: [], bankBalance: 0 };
    toast('Could not load from the cloud — check your connection');
  }
  const needsSetup = DATA._needsSetup;
  delete DATA._needsSetup;
  ensureDefaults(DATA);
  if (needsSetup) {
    document.getElementById('setup-banner').style.display = '';
    switchTab('sync'); // first run on a new device: land on the Sync tab
  }

  // Populate initial category selects
  populateCatSelect(document.getElementById('tx-cat'), 'income');
  populateCatSelect(document.getElementById('rec-cat'), document.getElementById('rec-type').value || 'expense');

  // Set bank balance input
  document.getElementById('bank-balance').value = DATA.bankBalance || '';

  // Show when balance was last updated
  if (DATA.balanceDate) {
    document.getElementById('balance-updated').textContent = 'Updated ' + fmtDate(DATA.balanceDate);
  }

  // Cloud sync wiring
  document.getElementById('sync-url').value = await window.api.getSyncUrl();
  renderSyncStatus(await window.api.getSyncStatus());
  window.api.onSyncStatus(renderSyncStatus);
  window.api.onRemoteUpdate(applyRemote);
  if (IS_WEB) {
    setInterval(webRefresh, 30000);
    window.addEventListener('focus', webRefresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) webRefresh(); });
  }

  wireEvents();
  renderAll();
})();
