/**
 * Odex Mirror — Web Terminal client (copies real Solana wallets)
 */

let engineState = null;
let lastWalletReport = null;




// ============================================================================
// Initialization & SSE Live Stream
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  await refreshEngineState();
  connectSseStream();
});

function connectSseStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    sseDown = false;
    renderStatusBar();
  };
  es.onerror = () => {
    sseDown = es.readyState !== EventSource.OPEN;
    renderStatusBar();
  };
  es.onmessage = (evt) => {
    try {
      const payload = JSON.parse(evt.data);
      if (handleLiveSse(payload)) return;
      if (payload.event === 'position_sold' || payload.event === 'records_pruned' || payload.event === 'state_reset' || payload.event === 'history_cleared' || payload.event === 'follow_added' || payload.event === 'follow_removed' || payload.event === 'follows_updated') pnlSummary.at = 0; // refetch totals
      // real trade closed/opened: the bot wallet balance changed on-chain — show it right away
      if (payload.event === 'bot_balance' && payload.data) {
        window.__botStatus = { ...(window.__botStatus || {}), balance: payload.data };
        if (botCardStatus) botCardStatus.balance = payload.data;
        try {
          renderBotWalletCard(true);
          renderBalancesEverywhereLite();
          renderKpiStrip();
        } catch {
          // page still loading
        }
        return;
      }
      if (payload.state) {
        engineState = payload.state;
        renderTerminalAll();
      } else if (payload.patch && engineState) {
        // price tick: only open positions changed
        Object.assign(engineState, payload.patch);
        renderTerminalAll();
      }
      const nt = uiPrefs().notify || {};
      if (payload.event === 'position_opened' && payload.data?.receipt) {
        const r = payload.data.receipt;
        if (nt.copies !== false) showToast(`Copied @${r.traderHandle}: Bought $${r.symbol} ($${r.amountUsd.toFixed(2)})`, 'good');
        if (nt.sound) playChime();
      } else if (payload.event === 'position_sold' && payload.data?.receipt) {
        const r = payload.data.receipt;
        const sign = r.pnlUsd >= 0 ? '+' : '';
        if (nt.sound) playChime(false, r.pnlUsd >= 0);
        if (document.getElementById('modal-pnl-calendar')?.classList.contains('open')) loadPnlCalendar();
        if (nt.sells !== false) showToast(
          `Sold $${r.symbol} (${r.cause}): ${sign}$${r.pnlUsd.toFixed(2)} (${sign}${r.pnlPct.toFixed(1)}%)`,
          r.pnlUsd >= 0 ? 'good' : 'warn'
        );
      } else if (payload.event === 'copy_skipped' && payload.data) {
        const s = payload.data;
        // expected skips (e.g. trader sells in Auto-Exit mode) stay in History without a popup
        if (nt.skips !== false && !NORMAL_SKIP_RE.test(s.reason || '')) showToast(`Skipped $${s.symbol} (@${s.traderHandle}): ${s.reason}`, 'warn');
      }
    } catch {
      // Ignore parse error
    }
  };
}

async function refreshEngineState() {
  const res = await fetch('/api/state');
  const data = await res.json();
  if (data.ok && data.state) {
    engineState = data.state;
    renderTerminalAll();
    populateSettingsInputs();
  }
}

function showToast(msg, level = 'good') {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const kind = level === 'warn' ? 'warn' : level === 'danger' ? 'danger' : 'good';
  const icons = {
    good: '<polyline points="20 6 9 17 4 12"/>',
    warn: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    danger: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  };
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="toast-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${icons[kind]}</svg></span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = msg;
  const dismiss = () => {
    if (el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  el.addEventListener('click', dismiss);
  stack.appendChild(el);
  // Keep at most 4 toasts on screen
  while (stack.children.length > 4) stack.firstElementChild.remove();
  setTimeout(dismiss, 4200);
}

// ============================================================================
// Navigation & Modals
// ============================================================================

window.switchMainView = function switchMainView(viewId) {
  document.querySelectorAll('.page-view').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.nav-tab[data-view]').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-view') === viewId);
  });
  if (viewId === 'terminal' && SIDEBAR_PANELS.includes(currentTermTab) && !switchMainView.keepPanel) switchTermTab('positions');
  const target = document.getElementById(`view-${viewId}`);
  if (target) target.classList.add('active');
  syncSideSubnav();
  if (typeof syncUrl === 'function') syncUrl();
  if (typeof toggleSidebar === 'function') toggleSidebar(false);
};

let currentTermTab = 'positions';
window.switchTermTab = function switchTermTab(tabId) {
  // Copytrades and Settings & Risk now live in the Settings page
  if (tabId === 'follows' || tabId === 'settings') {
    const section = tabId === 'follows' ? 'copytrades' : 'trading';
    tabId = 'config';
    setTimeout(() => openSettingsSection(section), 0);
  }
  currentTermTab = tabId;
  document.querySelectorAll('.term-panel').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.term-tab').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-term') === tabId);
  });
  const panel = document.getElementById(`term-${tabId}`);
  if (panel) panel.classList.add('active');
  syncSideSubnav();
  if (typeof syncUrl === 'function') syncUrl();
};

window.openQuickCopyModal = function openQuickCopyModal(prefillAddress = '') {
  const modal = document.getElementById('modal-copy');
  modal.classList.add('open');
  const input = document.getElementById('copy-wallet-input');
  if (typeof prefillAddress === 'string' && prefillAddress) {
    input.value = prefillAddress;
    checkCopyWallet();
  } else {
    setTimeout(() => input.focus(), 50);
  }
};

window.closeModal = function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
};

// ---------------------------------------------------------------------------
// Header notifications: the engine's alerts (copies, sells, problems), newest first
// ---------------------------------------------------------------------------
const NOTIF_SEEN_KEY = 'odex.notifSeenAt';
let notifFilter = 'all';
let notifRenderedKey = '';
function notifSeenAt() {
  try {
    return Number(localStorage.getItem(NOTIF_SEEN_KEY)) || 0;
  } catch {
    return notifSeenAt.mem || 0;
  }
}
function setNotifSeenAt(t) {
  notifSeenAt.mem = t;
  try {
    localStorage.setItem(NOTIF_SEEN_KEY, String(t));
  } catch {
    // private window: remember for this visit only
  }
}
function notifTimeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
function notifKind(a) {
  if (a.level === 'danger') return 'problems';
  if (a.level === 'warning' && !/^Exit filled/i.test(a.title || '')) return 'problems';
  return 'trades';
}
function renderNotifications(force = false) {
  const alerts = Array.isArray(engineState?.alerts) ? engineState.alerts : [];
  const seen = notifSeenAt();
  const unread = alerts.filter((a) => a.timestamp > seen).length;
  const badge = document.getElementById('notif-badge');
  if (badge) {
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
  }
  const list = document.getElementById('notif-list');
  const open = document.getElementById('notif-dropdown')?.classList.contains('open');
  const key = `${alerts[0]?.id || ''}|${alerts.length}|${notifFilter}|${seen}|${open}`;
  if (!list || (!force && key === notifRenderedKey)) return;
  notifRenderedKey = key;
  const shown = alerts.filter((a) => notifFilter === 'all' || notifKind(a) === notifFilter);
  if (!shown.length) {
    list.innerHTML = `<div class="notif-empty">${alerts.length ? 'Nothing in this filter.' : 'No notifications yet. Copies, sells and problems show up here.'}</div>`;
    return;
  }
  list.innerHTML = shown
    .map((a) => {
      const lvl = ['success', 'warning', 'danger'].includes(a.level) ? a.level : 'info';
      return `<div class="notif-item lvl-${lvl}${a.timestamp > seen ? ' unread' : ''}"><span class="notif-dot"></span><div class="notif-body"><div class="notif-title">${esc(a.title || '')}</div>${a.message ? `<div class="notif-msg">${esc(a.message)}</div>` : ''}<div class="notif-time" title="${esc(new Date(a.timestamp).toLocaleString())}">${notifTimeAgo(a.timestamp)}</div></div></div>`;
    })
    .join('');
}
window.toggleNotifDropdown = function toggleNotifDropdown(e) {
  if (e) e.stopPropagation();
  const dd = document.getElementById('notif-dropdown');
  if (!dd) return;
  const open = dd.classList.toggle('open');
  document.getElementById('header-notif-btn')?.setAttribute('aria-expanded', String(open));
  document.getElementById('header-wallet-dropdown')?.classList.remove('open');
  renderNotifications(true);
};
window.markNotifsRead = function markNotifsRead() {
  const alerts = engineState?.alerts || [];
  setNotifSeenAt(Math.max(Date.now(), ...alerts.map((a) => a.timestamp || 0)));
  renderNotifications(true);
};
window.setNotifFilter = function setNotifFilter(f) {
  notifFilter = f;
  document.querySelectorAll('#notif-filters .notif-filter').forEach((b) => b.classList.toggle('active', b.dataset.f === f));
  renderNotifications(true);
};
document.addEventListener('click', (e) => {
  const dd = document.getElementById('notif-dropdown');
  if (dd?.classList.contains('open') && !e.target.closest('.header-notif-wrapper')) {
    dd.classList.remove('open');
    document.getElementById('header-notif-btn')?.setAttribute('aria-expanded', 'false');
    markNotifsRead(); // closing the panel = you've seen them
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('notif-dropdown')?.classList.contains('open')) document.getElementById('notif-dropdown').classList.remove('open');
});
// state arrives over the live stream and many API calls: keep the bell in sync
setInterval(() => renderNotifications(false), 1000);
setInterval(() => renderNotifications(true), 30_000); // refresh "x minutes ago"

window.toggleHeaderWalletDropdown = function toggleHeaderWalletDropdown(e) {
  if (e) e.stopPropagation();
  const dropdown = document.getElementById('header-wallet-dropdown');
  if (dropdown) dropdown.classList.toggle('open');
};

// ============================================================================
// DATE FILTER SYSTEM FOR KPI ANALYTICS CARDS
// ============================================================================
let dateFilterState = {
  preset: 'today', // default view: today's activity (range is recomputed live, so it rolls over at midnight)
  startDate: null,
  endDate: null,
  lastNum: 7,
  lastUnit: 'days',
  includeToday: true,
  viewYear: new Date().getFullYear(),
  viewMonth: new Date().getMonth(),
};

let tempDateFilter = {
  preset: 'today',
  startDate: null,
  endDate: null,
  lastNum: 7,
  lastUnit: 'days',
  includeToday: true,
  viewYear: new Date().getFullYear(),
  viewMonth: new Date().getMonth(),
  pickStep: 'start',
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function calculatePresetRange(preset, lastNum = 7, lastUnit = 'days', includeToday = true) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

  if (preset === 'today') {
    return { startDate: todayStart, endDate: todayEnd };
  }
  if (preset === 'yesterday') {
    const yStart = todayStart - 86400000;
    const yEnd = todayStart - 1;
    return { startDate: yStart, endDate: yEnd };
  }
  if (preset === 'last7') {
    const start = todayStart - 6 * 86400000;
    return { startDate: start, endDate: todayEnd };
  }
  if (preset === 'last30') {
    return { startDate: todayStart - 29 * 86400000, endDate: todayEnd };
  }
  if (preset === 'ptd') {
    const ptdStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
    return { startDate: ptdStart, endDate: todayEnd };
  }
  if (preset === 'quarters') {
    const currentQMonth = Math.floor(now.getMonth() / 3) * 3;
    const qStart = new Date(now.getFullYear(), currentQMonth, 1, 0, 0, 0, 0).getTime();
    return { startDate: qStart, endDate: todayEnd };
  }
  if (preset === 'all') {
    return { startDate: null, endDate: null };
  }

  let end = includeToday ? todayEnd : todayStart - 1;
  let mult = 86400000;
  if (lastUnit === 'weeks') mult = 7 * 86400000;
  else if (lastUnit === 'months') mult = 30 * 86400000;

  const count = Math.max(1, parseInt(lastNum, 10) || 1);
  let start = end - (count * mult) + 1;
  return { startDate: start, endDate: end };
}

/** The active range right now: named presets (Today, Last 7 days…) are recomputed on every use
 *  so they stay correct after midnight; custom ranges are used as picked. */
function activeDateRange() {
  const st = dateFilterState;
  if (st.preset === 'custom') return { startDate: st.startDate, endDate: st.endDate };
  return calculatePresetRange(st.preset, st.lastNum, st.lastUnit, st.includeToday);
}

/** Is a timestamp inside the date filter? All time always matches. */
function inDateFilter(ts) {
  if (dateFilterState.preset === 'all') return true;
  const r = activeDateRange();
  if (!r.startDate && !r.endDate) return true;
  if (!ts) return false;
  return (!r.startDate || ts >= r.startDate) && (!r.endDate || ts <= r.endDate);
}
function dateFilterText() {
  const r = activeDateRange();
  return formatDateRangeLabel(dateFilterState.preset, r.startDate, r.endDate);
}
/** "today", "in the last 7 days"… for empty-state messages */
function dateFilterPhrase() {
  const t = dateFilterText();
  return /^(today|yesterday)$/i.test(t) ? t.toLowerCase() : `in ${t.replace(/^Last/, 'the last').replace(/^This/, 'this')}`;
}

function formatDateRangeLabel(preset, startDate, endDate) {
  if (preset === 'all' || (!startDate && !endDate)) return 'All time';
  if (preset === 'today') return 'Today';
  if (preset === 'yesterday') return 'Yesterday';
  if (preset === 'last7') return 'Last 7 days';
  if (preset === 'last30') return 'Last 30 days';
  if (preset === 'ptd') return 'This month';
  if (preset === 'quarters') return 'This quarter';

  if (!startDate) return 'Up to ' + new Date(endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (!endDate) return 'From ' + new Date(startDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  const d1 = new Date(startDate);
  const d2 = new Date(endDate);
  const s1 = d1.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const s2 = d2.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${s1} – ${s2}`;
}

window.openDateFilterModal = function openDateFilterModal() {
  tempDateFilter = { ...dateFilterState, ...activeDateRange(), pickStep: 'start' };
  const now = new Date();
  if (tempDateFilter.startDate) {
    // keep the end of the range in view: its month sits in the right-hand calendar
    const d = new Date(tempDateFilter.endDate || tempDateFilter.startDate);
    const startD = new Date(tempDateFilter.startDate);
    const sameMonth = startD.getFullYear() === d.getFullYear() && startD.getMonth() === d.getMonth();
    const left = sameMonth ? new Date(d.getFullYear(), d.getMonth() - 1, 1) : startD;
    tempDateFilter.viewYear = left.getFullYear();
    tempDateFilter.viewMonth = left.getMonth();
  } else {
    tempDateFilter.viewYear = now.getFullYear();
    tempDateFilter.viewMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    if (now.getMonth() === 0) tempDateFilter.viewYear -= 1;
  }

  updateDateFilterPresetUI();
  renderDualCalendars();
  updateDateFilterFooterLabel();

  const modal = document.getElementById('modal-date-filter');
  if (modal) modal.classList.add('open');
};

function updateDateFilterPresetUI() {
  document.querySelectorAll('.df-preset-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-preset') === tempDateFilter.preset);
  });
}

function updateDateFilterFooterLabel() {
  const lbl = document.getElementById('df-selected-range-label');
  if (lbl) {
    lbl.textContent = formatDateRangeLabel(tempDateFilter.preset, tempDateFilter.startDate, tempDateFilter.endDate);
  }
}

window.selectDatePreset = function selectDatePreset(preset) {
  tempDateFilter.preset = preset;
  if (preset !== 'custom') {
    const range = calculatePresetRange(preset, tempDateFilter.lastNum, tempDateFilter.lastUnit, tempDateFilter.includeToday);
    tempDateFilter.startDate = range.startDate;
    tempDateFilter.endDate = range.endDate;
  }
  updateDateFilterPresetUI();
  renderDualCalendars();
  updateDateFilterFooterLabel();
  if (preset !== 'custom') applyDateFilter(); // one click: pick a preset and you're done
};

window.navDateFilterMonth = function navDateFilterMonth(delta) {
  tempDateFilter.viewMonth += delta;
  if (tempDateFilter.viewMonth < 0) {
    tempDateFilter.viewMonth = 11;
    tempDateFilter.viewYear -= 1;
  } else if (tempDateFilter.viewMonth > 11) {
    tempDateFilter.viewMonth = 0;
    tempDateFilter.viewYear += 1;
  }
  renderDualCalendars();
};

window.onDateCellClick = function onDateCellClick(year, month, day) {
  const clickedStart = new Date(year, month, day, 0, 0, 0, 0).getTime();
  const clickedEnd = new Date(year, month, day, 23, 59, 59, 999).getTime();

  if (tempDateFilter.pickStep === 'start' || (tempDateFilter.startDate && tempDateFilter.endDate)) {
    tempDateFilter.startDate = clickedStart;
    tempDateFilter.endDate = null;
    tempDateFilter.pickStep = 'end';
  } else {
    if (clickedStart < tempDateFilter.startDate) {
      tempDateFilter.endDate = new Date(tempDateFilter.startDate).setHours(23, 59, 59, 999);
      tempDateFilter.startDate = clickedStart;
    } else {
      tempDateFilter.endDate = clickedEnd;
    }
    tempDateFilter.pickStep = 'start';
  }

  tempDateFilter.preset = 'custom';
  updateDateFilterPresetUI();
  renderDualCalendars();
  updateDateFilterFooterLabel();
};

function renderCalendarMonth(gridEl, titleEl, year, month) {
  if (!gridEl || !titleEl) return;
  titleEl.textContent = `${MONTH_NAMES[month]} ${year}`;

  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const now = new Date();
  const isCurrentMonthYear = now.getFullYear() === year && now.getMonth() === month;
  const todayDate = now.getDate();

  let html = '';

  for (let i = firstDayOfWeek - 1; i >= 0; i--) {
    const padDay = daysInPrevMonth - i;
    html += `<div class="df-day-cell pad">${padDay}</div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dayStart = new Date(year, month, day, 0, 0, 0, 0).getTime();
    const dayEnd = new Date(year, month, day, 23, 59, 59, 999).getTime();

    let classes = ['df-day-cell'];
    if (isCurrentMonthYear && day === todayDate) {
      classes.push('today');
    }

    const { startDate, endDate } = tempDateFilter;
    if (startDate && !endDate) {
      if (dayStart === startDate) classes.push('selected');
    } else if (startDate && endDate) {
      const isStart = startDate >= dayStart && startDate <= dayEnd;
      const isEnd = endDate >= dayStart && endDate <= dayEnd;

      if (isStart && isEnd) {
        classes.push('selected');
      } else if (isStart) {
        classes.push('range-start');
      } else if (isEnd) {
        classes.push('range-end');
      } else if (dayStart > startDate && dayEnd < endDate) {
        classes.push('range-in');
      }
    }

    html += `<div class="${classes.join(' ')}" onclick="onDateCellClick(${year}, ${month}, ${day})">${day}</div>`;
  }

  const totalCells = firstDayOfWeek + daysInMonth;
  const remainder = totalCells % 7;
  if (remainder !== 0) {
    const trailingCount = 7 - remainder;
    for (let t = 1; t <= trailingCount; t++) {
      html += `<div class="df-day-cell pad">${t}</div>`;
    }
  }

  gridEl.innerHTML = html;
}

function renderDualCalendars() {
  const y1 = tempDateFilter.viewYear;
  const m1 = tempDateFilter.viewMonth;

  let y2 = y1;
  let m2 = m1 + 1;
  if (m2 > 11) {
    m2 = 0;
    y2 += 1;
  }

  renderCalendarMonth(
    document.getElementById('df-days-grid-1'),
    document.getElementById('df-cal-title-1'),
    y1,
    m1
  );

  renderCalendarMonth(
    document.getElementById('df-days-grid-2'),
    document.getElementById('df-cal-title-2'),
    y2,
    m2
  );
}

window.applyDateFilter = function applyDateFilter() {
  dateFilterState = { ...tempDateFilter };
  const labelText = formatDateRangeLabel(dateFilterState.preset, dateFilterState.startDate, dateFilterState.endDate);
  const btnLabel = document.getElementById('date-filter-label');
  if (btnLabel) btnLabel.textContent = labelText;
  const followsBtnLabel = document.getElementById('follows-date-filter-label');
  if (followsBtnLabel) followsBtnLabel.textContent = labelText;

  closeModal('modal-date-filter');
  renderKpiStrip();
  renderFollowsList();
  renderClosedPositions();
  renderHistoryTable();
  renderLiveSignals();
};

window.openDepositModal = function openDepositModal(tab = 'deposit') {
  if (tab === 'convert') {
    // Swaps happen in your own wallet on Jupiter (Odex Mirror never holds funds)
    window.open('https://jup.ag/swap/SOL-USDC', '_blank', 'noopener');
    return;
  }
  const modal = document.getElementById('modal-deposit');
  if (modal) modal.classList.add('open');
  renderDepositPane();
};

/** Header avatar: straight to Settings › Profile (no account pop-up). */
window.openUserProfileModal = function openUserProfileModal() {
  goTerminalTab('config');
  openSettingsSection('profile');
};

window.copyActiveWalletAddress = function copyActiveWalletAddress() {
  const wallets = engineState?.wallets?.filter((w) => !w.archived) || [];
  const activeWallet = wallets.find((w) => w.active) || wallets[0];
  const addr = botWalletBalance()?.address || walletChainAddress(activeWallet);
  if (!isRealSolanaAddress(addr)) {
    showToast('This paper wallet has no on-chain address to copy', 'warn');
    return;
  }
  navigator.clipboard?.writeText(addr);
  showToast('Copied active Solana address to clipboard!', 'good');
};

window.copyDepositAddress = function copyDepositAddress() {
  const input = document.getElementById('deposit-sol-addr');
  const value = input?.value || '';
  if (!value) {
    showToast('No on-chain deposit address for this paper wallet', 'warn');
    return;
  }
  navigator.clipboard?.writeText(value);
  showToast('Deposit address copied', 'good');
};


window.resetTerminalData = async function resetTerminalData() {
  const res = await fetch('/api/engine/reset', { method: 'POST' });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
    showToast('Cleared all test data. Terminal reset to clean 0 baseline.', 'good');
  }
};

window.togglePaperModeClick = function togglePaperModeClick() {
  const chk = document.getElementById('toggle-paper-mode');
  if (chk) {
    chk.checked = !chk.checked;
    window.onPaperModeToggle(chk.checked);
  }
};

window.onPaperModeToggle = async function onPaperModeToggle(isChecked) {
  const capsule = document.getElementById('pm-switch-capsule');
  const statusText = document.getElementById('pm-status-text');
  if (capsule) capsule.classList.toggle('active', isChecked);
  if (statusText) statusText.textContent = isChecked ? 'ON' : 'OFF';

  if (engineState && engineState.settings) {
    engineState.settings.paperTrading = isChecked;
  }

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperTrading: isChecked }),
    });
    const data = await res.json();
    if (data.state) {
      engineState = data.state;
    }
  } catch (err) {
    console.error('Failed to update paper trading mode:', err);
  }
  // Paper OFF = real trading when a bot wallet key is set
  try {
    const rs = await (await fetch('/api/real/status')).json();
    if (!isChecked) {
      if (rs.ready) showToast(`REAL TRADING ON — copies now spend real SOL from ${String(rs.address).slice(0, 4)}…${String(rs.address).slice(-4)}`, 'danger');
      else showToast('Paper Trading is OFF but no bot wallet key is set (ODEX_TRADER_KEY in .env) — nothing will be copied', 'warn');
    } else if (rs.ready) showToast('Paper Trading ON — real trading stopped', 'good');
    renderRealPanel(rs);
  } catch {
    // status is shown again when Settings opens
  }

  if (isChecked) {
    showToast('Paper Trading on: followed wallets are copied with live prices, no real funds.', 'good');
  } else {
    showToast('Paper Trading off: copying is paused (live trading isn\'t available yet). Signals still show.', 'warn');
  }
};

document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('header-wallet-dropdown');
  if (dropdown && dropdown.classList.contains('open')) {
    if (!e.target.closest('.header-wallet-pill-wrapper')) {
      dropdown.classList.remove('open');
    }
  }
  // Click on the dimmed backdrop (outside the dialog) closes the modal
  if (e.target.classList && e.target.classList.contains('modal-backdrop') && e.target.id !== 'modal-confirm') {
    e.target.classList.remove('open');
  }
});

// Esc closes the top-most open modal / dropdown
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal-backdrop.open')];
  if (open.length) {
    const top = open[open.length - 1];
    if (top.id === 'modal-confirm') document.getElementById('confirm-cancel')?.click();
    else top.classList.remove('open');
    return;
  }
  document.getElementById('header-wallet-dropdown')?.classList.remove('open');
});

// Promise-based confirm dialog (replaces one-click destructive actions)
function confirmAction({ title, message, confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    if (!modal) return resolve(true);
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-msg').textContent = message;
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    ok.textContent = confirmLabel;
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    document.getElementById('confirm-icon').classList.toggle('is-danger', danger);
    const done = (val) => {
      modal.classList.remove('open');
      ok.onclick = null;
      cancel.onclick = null;
      resolve(val);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    modal.classList.add('open');
    setTimeout(() => cancel.focus(), 30);
  });
}

// ============================================================================
// Terminal Rendering
// ============================================================================

function formatUsd(val) {
  const num = Number(val || 0);
  if (num < 0) {
    return `-$${Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatMc(val) {
  const n = Number(val || 0);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function chainBadgeHtml(chainId) {
  const labels = { solana: 'SOL', bsc: 'BSC', robinhood: 'RH', arc: 'ARC' };
  const icon =
    chainId === 'solana'
      ? '<svg class="chain-icon" aria-hidden="true"><use href="#sol-mark"/></svg>'
      : chainId === 'bsc'
        ? '<svg class="chain-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#bnb-mark"/></svg>'
        : '<span class="chain-dot"></span>';
  return `<span class="chain-badge chain-${chainId}">${icon}${labels[chainId] || chainId}</span>`;
}

function signedPct(n, digits = 1) {
  const v = Number(n || 0);
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`;
}

function signedUsd(n) {
  const v = Number(n || 0);
  return `${v >= 0 ? '+' : '−'}${formatUsd(Math.abs(v))}`;
}

function emptyRowHtml(colspan, title, desc, actionHtml = '') {
  return `<tr class="empty-row"><td colspan="${colspan}">
    <div class="table-empty">
      <div class="table-empty-title">${title}</div>
      <div class="table-empty-desc">${desc}</div>
      ${actionHtml}
    </div>
  </td></tr>`;
}

// A redraw between mouse-down and mouse-up replaces the button under the pointer and the
// click is lost. While a button is held, redraws wait until it is released.
let pointerHeld = false;
let redrawPending = false;
document.addEventListener('pointerdown', () => {
  pointerHeld = true;
}, true);
const releasePointer = () => {
  pointerHeld = false;
  if (redrawPending) {
    redrawPending = false;
    setTimeout(() => renderTerminalAll(), 60); // after the click handler has run
  }
};
document.addEventListener('pointerup', releasePointer, true);
document.addEventListener('pointercancel', releasePointer, true);

/** Replace an element's HTML only when it actually changed (keeps buttons alive between ticks). */
function setHtml(el, html) {
  if (!el) return;
  if (el.__lastHtml === html) return;
  el.__lastHtml = html;
  el.innerHTML = html;
}

function renderTerminalAll() {
  setTimeout(renderStatusBar, 0);
  if (!engineState) return;
  if (pointerHeld) {
    redrawPending = true;
    return;
  }
  applyUiSettings();

  // Sync Paper Trading Mode toggle switch
  const paperOn = engineState?.settings?.paperTrading !== false;
  const pmChk = document.getElementById('toggle-paper-mode');
  if (pmChk) pmChk.checked = paperOn;
  const pmCapsule = document.getElementById('pm-switch-capsule');
  if (pmCapsule) pmCapsule.classList.toggle('active', paperOn);
  const pmStatus = document.getElementById('pm-status-text');
  if (pmStatus) pmStatus.textContent = paperOn ? 'ON' : 'OFF';

  renderKpiStrip();
  renderPositionsList();
  renderFollowsList();
  renderWalletsList();
  renderHistoryTable();
  renderClosedPositions();
  renderTraderFilterBar();
  renderDocsView();
}

// ---------------------------------------------------------------------------
// "How the engine works" page: the six copy steps, exit rules and protections with live values
// ---------------------------------------------------------------------------
const DOC_ICONS = {
  watch: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  size: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  verify: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  execute: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  exit: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  initials: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  trail: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  floor: '<line x1="3" y1="20" x2="21" y2="20"/><polyline points="3 6 9 12 13 9 21 16"/>',
  wave: '<path d="M2 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  cap: '<circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/>',
  one: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  radar: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
};
const docIcon = (k, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DOC_ICONS[k] || ''}</svg>`;

function renderDocsView() {
  const root = document.getElementById('docs-live');
  if (!root || !engineState) return;
  const st = engineState.settings || {};
  const paper = st.paperTrading !== false;
  const follows = engineState.follows || [];
  const f = follows.find((x) => x.status === 'copying') || follows[0] || null;
  const R = (f?.exitRules && typeof f.exitRules === 'object' ? f.exitRules : null) || {};
  const rule = (k, d) => ({ ...d, ...(R[k] || {}) });
  const ti = rule('takeInitials', { enabled: false, takeAtPct: 25, sellSizePct: 75 });
  const mt = rule('moonbagTrail', { enabled: false, trailPct: 25, armsAtPct: 10 });
  const fl = rule('floor', { enabled: false, openingFloorPct: 45, tightensAfterSec: 50, tightFloorPct: 20 });
  const wc = rule('waveCut', { enabled: false, afterSec: 90, needsPeakPct: 5 });
  const tc = rule('hardTimeCap', { enabled: false, timeCapSec: 300 });
  const autoExit = f?.mode === 'auto-exit';
  const stream = liveWatch?.status?.stream || {};
  const provider = stream.provider === 'helius' ? 'Helius' : stream.provider === 'alchemy' ? 'Alchemy' : stream.provider === 'public' ? 'public RPC' : 'RPC';
  const scores = f ? engineState.traderScores?.[f.id] : null;
  const bot = window.__botStatus || null;
  const sc = { autoPause: true, minTrades: 10, maxSlipPct: 20, maxLagSec: 10, ...(st.scorecard || {}) };
  const sizing = f ? (f.sizing.type === 'fixed' ? `$${f.sizing.amount} per trade` : f.sizing.type === 'percent' ? `${f.sizing.amount}% of balance` : `1:1, cap $${f.sizing.amount}`) : 'Set when you copy a trader';
  const capSol = bot?.caps?.maxSolPerTrade;
  const chip = (text, tone = '') => `<span class="dx-chip ${tone}">${text}</span>`;
  const onOff = (on) => (on ? chip('ON', 'is-on') : chip('OFF', 'is-off'));

  const steps = [
    ['watch', 'Watch', 'Every swap of the wallets you follow, pushed live from the blockchain.', `${chip(`${provider} live`, stream.connected ? 'is-on' : 'is-off')} ${chip(`${follows.filter((x) => x.status === 'copying').length} copying`)}`],
    ['filter', 'Filter', 'Your entry filters plus the token safety audit.', `${chip(`Safety ${st.safety?.blockRiskyCoins ? 'ON' : 'OFF'}`, st.safety?.blockRiskyCoins ? 'is-on' : 'is-off')} ${st.filters?.pumpOnly ? chip('Pump-only') : ''}`],
    ['size', 'Size', 'Fixed $, % of balance, or the trader’s own size with a cap.', `${chip(esc(sizing))}${!paper && capSol ? ` ${chip(`max ${capSol} SOL`)}` : ''}`],
    ['verify', 'Verify', 'Price check against the trader’s fill and your slippage.', `${chip(`Max chase ${st.maxChasePct ?? 25}%`)} ${chip(`Buy slip ${st.buySlippagePct?.solana ?? 15}%`)}`],
    ['execute', 'Execute', paper ? 'Paper fill at the live price, with real fees modelled.' : 'Real swap through Jupiter, signed by the bot wallet.', paper ? chip('Paper', 'is-paper') : chip('<span class="dx-dot"></span>Real SOL', 'is-live')],
    ['exit', 'Exit', autoExit ? `Hand-off to your auto-exit rules${f?.mirrorSells ? ', plus a sell the moment the trader sells' : ''}; checked every 0.5 s while a real trade is open (2 s otherwise).` : f?.mode === 'mirror' ? 'Sells when the trader sells (Mirror).' : 'Held until take-profit / stop-loss.', chip(autoExit ? `${[ti, mt, fl, wc, tc].filter((r) => r.enabled).length}/5 rules on` : f?.mode === 'mirror' ? 'Mirror' : 'Buy & Hold')],
  ];

  const rules = [
    ['initials', 'Take Initials', `At <b>+${ti.takeAtPct}%</b> sell <b>${ti.sellSizePct}%</b>, keep a moonbag.`, ti.enabled],
    ['trail', 'Moonbag Trail', `Trailing stop <b>${mt.trailPct}%</b> off the peak, armed at <b>+${mt.armsAtPct}%</b>.`, mt.enabled],
    ['floor', 'Two-Stage Floor', `Stop at <b>−${fl.openingFloorPct}%</b>, tightening to <b>−${fl.tightFloorPct}%</b> after <b>${fl.tightensAfterSec}s</b>.`, fl.enabled],
    ['wave', 'Wave-Cut', `Exit after <b>${wc.afterSec}s</b> if the peak never reached <b>+${wc.needsPeakPct}%</b>.`, wc.enabled],
    ['clock', 'Hard Time Cap', `Close the main position after <b>${tc.timeCapSec}s</b>.`, tc.enabled],
  ];

  const prot = [
    ['verify', 'Max chase', `Skips a copy if the price already ran more than <b>${st.maxChasePct ?? 25}%</b> past the trader’s fill.`, true],
    ['shield', 'Honeypot block', 'Never buys tokens flagged as unsellable.', true],
    ['lock', 'Freeze / mint authority', 'Skips Solana tokens whose freeze authority is still active.', Boolean(st.safety?.blockRiskyCoins)],
    ['pause', 'Auto-pause slow traders', `Pauses a trader after ${sc.minTrades} copies if total slip &gt; ${sc.maxSlipPct}% or delay &gt; ${sc.maxLagSec}s.`, Boolean(sc.autoPause)],
    ['cap', 'Real SOL limits', bot?.configured ? `Max <b>${bot.caps?.maxSolPerTrade} SOL</b> per buy, <b>${bot.caps?.maxSolPerDay} SOL</b> per day, ${bot.caps?.reserveSol} SOL kept for fees.` : 'Per-buy and daily SOL caps apply once the bot wallet is set up.', Boolean(bot?.configured)],
    ['one', 'One bot at a time', 'A second running copy on the same account can’t trade real SOL.', true],
  ];

  const stats = [
    ['execute', 'Mode', paper ? 'Paper' : 'Real SOL', paper ? '' : 'is-live'],
    ['radar', 'Detect delay', scores?.avgLagSec != null ? `${Number(scores.avgLagSec).toFixed(1)}s` : '—', scores?.avgLagSec != null && scores.avgLagSec <= sc.maxLagSec ? 'is-good' : ''],
    ['clock', 'Exit checks', 'every 2s', ''],
    ['initials', 'Win rate', scores?.winRatePct != null ? `${scores.winRatePct.toFixed(0)}%` : '—', scores?.winRatePct >= 50 ? 'is-good' : ''],
  ];

  const html = `
    <div class="dx-stats">${stats.map(([ic, k, v, tone]) => `<div class="dx-stat"><span class="dx-stat-ic">${docIcon(ic, 16)}</span><div><span class="dx-stat-k">${k}</span><strong class="dx-stat-v ${tone}">${v}</strong></div></div>`).join('')}</div>

    <div class="dx-card dx-glow">
      <div class="dx-head"><span class="dx-head-ic">${docIcon('radar', 16)}</span><h3>Copy pipeline</h3><span class="dx-head-sub">every trade, in order</span></div>
      <ol class="dx-pipe">${steps.map(([ic, t, d, live], i) => `
        <li class="dx-step">
          <div class="dx-step-top"><span class="dx-step-ic">${docIcon(ic)}</span><span class="dx-step-n">${String(i + 1).padStart(2, '0')}</span></div>
          <strong>${t}</strong>
          <p>${d}</p>
          <div class="dx-step-live">${live}</div>
        </li>`).join('')}
      </ol>
    </div>

    <div class="dx-grid">
      <div class="dx-card">
        <div class="dx-head"><span class="dx-head-ic">${docIcon('exit', 16)}</span><h3>Auto-exit rules</h3><span class="dx-head-sub">${f ? `${esc(f.name || f.handle)} · ${autoExit ? 'auto-exit' : esc(f.mode)}` : 'no trader yet'}</span>${f ? `<button class="btn btn-sm dx-head-btn" onclick="openExitRulesModal('${f.id}')">Edit rules</button>` : ''}</div>
        ${!autoExit && f ? `<div class="dx-note">This trader is in ${esc(f.mode.replace(/-/g, ' '))} mode, so these rules are not used.</div>` : ''}
        <div class="dx-list">${rules.map(([ic, t, d, on]) => `
          <div class="dx-row ${on ? '' : 'is-muted'}"><span class="dx-row-ic">${docIcon(ic, 16)}</span><div class="dx-row-main"><strong>${t}</strong><p>${d}</p></div>${onOff(on)}</div>`).join('')}
        </div>
      </div>
      <div class="dx-card">
        <div class="dx-head"><span class="dx-head-ic">${docIcon('shield', 16)}</span><h3>Protection</h3><span class="dx-head-sub">checked on every copy</span></div>
        <div class="dx-list">${prot.map(([ic, t, d, on]) => `
          <div class="dx-row ${on ? '' : 'is-muted'}"><span class="dx-row-ic">${docIcon(ic, 16)}</span><div class="dx-row-main"><strong>${t}</strong><p>${d}</p></div>${onOff(on)}</div>`).join('')}
        </div>
      </div>
    </div>`;
  if (root.__lastHtml !== html) {
    root.__lastHtml = html;
    root.innerHTML = html;
  }
}

function durationShort(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d`;
}

function fmtSol(n) {
  const a = Math.abs(n);
  return a >= 100 ? a.toFixed(1) : a >= 1 ? a.toFixed(2) : a >= 0.01 ? a.toFixed(3) : a.toFixed(4);
}
function signedSol(n) {
  return `${n < 0 ? '\u2212' : '+'}${fmtSol(n)} SOL`;
}
/** Small "5.38 SOL" chip next to a dollar amount; ≈ when estimated with today's SOL price. */
function solChip(sol, exact, what) {
  if (sol == null) return '';
  const tip = exact ? `SOL ${what}, at the SOL price of the trade` : `SOL ${what}, estimated with today's SOL price (older trade)`;
  return `<span class="closed-sol" title="${tip}"><svg width="11" height="9" aria-hidden="true"><use href="#sol-mark"/></svg>${exact ? '' : '≈'}${fmtSol(sol)} SOL</span>`;
}

// Closed trades: 15 per page; page goes back to 1 when the date / trader filter changes
const CLOSED_PAGE_SIZE = 15;
let closedPage = 1;
let closedFilterKey = '';
window.setClosedPage = function setClosedPage(n) {
  closedPage = Math.max(1, Number(n) || 1);
  renderClosedPositions();
  document.getElementById('closed-tbody')?.closest('.card, section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
function renderClosedPager(total) {
  const el = document.getElementById('closed-pager');
  if (!el) return;
  const pages = Math.ceil(total / CLOSED_PAGE_SIZE);
  if (pages <= 1) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  // 1 … 4 5 [6] 7 8 … 20
  const nums = [];
  for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - closedPage) <= 2) nums.push(i);
  const parts = [];
  nums.forEach((n, i) => {
    if (i && n - nums[i - 1] > 1) parts.push('<span class="cp-gap">…</span>');
    parts.push(`<button type="button" class="cp-btn${n === closedPage ? ' active' : ''}" onclick="setClosedPage(${n})" ${n === closedPage ? 'aria-current="page"' : ''}>${n}</button>`);
  });
  const from = (closedPage - 1) * CLOSED_PAGE_SIZE + 1;
  const to = Math.min(total, closedPage * CLOSED_PAGE_SIZE);
  el.hidden = false;
  el.innerHTML = `<span class="cp-info">${from}–${to} of ${total}</span><div class="cp-nums"><button type="button" class="cp-btn cp-nav" onclick="setClosedPage(${closedPage - 1})" ${closedPage === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>${parts.join('')}<button type="button" class="cp-btn cp-nav" onclick="setClosedPage(${closedPage + 1})" ${closedPage === pages ? 'disabled' : ''} aria-label="Next page">›</button></div>`;
}

// Closed trades filter: all / real SOL only / paper only (remembered in this browser)
let closedKind = 'all';
try {
  const k = localStorage.getItem('odex.closedKind');
  if (k === 'real' || k === 'paper' || k === 'all') closedKind = k;
} catch {
  // storage unavailable: default
}
const isRealClosed = (r) => r.isPaper === false;
window.setClosedKind = function setClosedKind(kind) {
  closedKind = kind === 'real' || kind === 'paper' ? kind : 'all';
  try {
    localStorage.setItem('odex.closedKind', closedKind);
  } catch {
    // ignore
  }
  closedPage = 1;
  renderClosedPositions();
};
// Totals for the Closed card from the PnL log, for real, paper or both (all = real + paper)
const closedSummaries = new Map(); // key → { data, at, loading }
function closedSummary(kind) {
  const k = pnlSummaryKey();
  const get = (mode) => {
    const key = `${k.from}|${k.to}|${mode}`;
    const c = closedSummaries.get(key);
    if (!c || (Date.now() - c.at > 15_000 && !c.loading)) {
      const entry = c || { data: null, at: 0, loading: false };
      entry.loading = true;
      closedSummaries.set(key, entry);
      fetch(`/api/pnl/summary?${new URLSearchParams({ from: String(k.from), to: String(k.to), mode })}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) Object.assign(entry, { data: d, at: Date.now() });
          if (engineState) renderClosedPositions();
        })
        .catch(() => {})
        .finally(() => {
          entry.loading = false;
        });
    }
    return c?.data || null;
  };
  if (kind !== 'all') return get(kind);
  const a = get('real');
  const b = get('paper');
  if (!a || !b) return null;
  return { trades: a.trades + b.trades, wins: a.wins + b.wins, realized: a.realized + b.realized, realizedSol: (a.realizedSol || 0) + (b.realizedSol || 0), solExact: a.solExact && b.solExact };
}

function renderClosedPositions() {
  const tbody = document.getElementById('closed-tbody');
  const all = engineState?.closedPositions || [];
  const badge = document.getElementById('badge-closed-count');
  if (badge) badge.textContent = String(all.filter((r) => inDateFilter(r.closedAt || r.openedAt)).length);
  if (!tbody) return;
  const dated = all.filter(matchesTraderFilter).filter((r) => inDateFilter(r.closedAt || r.openedAt));
  const rows = closedKind === 'all' ? dated : dated.filter((r) => (closedKind === 'real' ? isRealClosed(r) : !isRealClosed(r)));
  // filter buttons with how many trades each holds
  const kindEl = document.getElementById('closed-kind');
  if (kindEl) {
    const n = { all: dated.length, real: dated.filter(isRealClosed).length, paper: dated.filter((r) => !isRealClosed(r)).length };
    kindEl.querySelectorAll('.seg-btn').forEach((b) => {
      const kd = b.dataset.kind;
      b.classList.toggle('active', kd === closedKind);
      b.setAttribute('aria-pressed', kd === closedKind ? 'true' : 'false');
      b.innerHTML = `${kd === 'all' ? 'All' : kd === 'real' ? 'Real SOL' : 'Paper'}<span class="ck-n">${n[kd]}</span>`;
    });
  }
  const totals = document.getElementById('closed-totals');
  if (totals) {
    // Totals come from the PnL log (same as the cards and the calendar) for the chosen kind; with a
    // trader filter the listed rows are summed instead
    const S = !traderFilter ? closedSummary(closedKind) : null;
    const count = S ? S.trades : rows.length;
    const pnl = S ? S.realized : rows.reduce((a, r) => a + r.pnlUsd, 0);
    const wins = S ? S.wins : rows.filter((r) => r.pnlUsd > 0).length;
    const solRows = S ? [1] : rows.filter((r) => r.pnlSol != null);
    const pnlSol = S ? S.realizedSol : solRows.reduce((a, r) => a + r.pnlSol, 0);
    const solExact = S ? S.solExact : solRows.every((r) => r.solExact);
    totals.title = S ? 'All trades closed in this period (the list below keeps the last 2 days)' : '';
    totals.innerHTML = count
      ? `<span class="closed-stat">${count} trade${count === 1 ? '' : 's'}</span><span class="closed-stat">Win rate <strong>${Math.round((wins / count) * 100)}%</strong></span><span class="closed-stat">Realized <strong class="${pnl >= 0 ? 'pos-up' : 'pos-down'}">${signedUsd(pnl)}</strong>${solRows.length ? `<span class="closed-stat-sol ${pnlSol >= 0 ? 'pos-up' : 'pos-down'}">${solExact ? '' : '≈'}${signedSol(pnlSol)}</span>` : ''}</span>`
      : '';
  }
  const fk = `${dateFilterState.preset}|${traderFilter?.label || ''}|${JSON.stringify(activeDateRange())}|${closedKind}`;
  if (fk !== closedFilterKey) {
    closedFilterKey = fk;
    closedPage = 1;
  }
  closedPage = Math.min(closedPage, Math.max(1, Math.ceil(rows.length / CLOSED_PAGE_SIZE)));
  renderClosedPager(rows.length);
  if (!rows.length) {
    tbody.__lastHtml = null;
    const kindWord = closedKind === 'real' ? 'real SOL ' : closedKind === 'paper' ? 'paper ' : '';
    if (kindWord && dated.length) {
      tbody.innerHTML = emptyRowHtml(6, `No ${kindWord}trades closed${dateFilterState.preset !== 'all' ? ` ${dateFilterPhrase()}` : ''}${traderFilter ? ` from ${esc(traderFilter.label)}` : ''}`, `Switch to "All" to see the ${dated.length} other closed trade${dated.length === 1 ? '' : 's'}.`);
      return;
    }
    tbody.innerHTML = emptyRowHtml(6, traderFilter ? `No closed trades from ${esc(traderFilter.label)}${dateFilterState.preset !== 'all' ? ` ${dateFilterPhrase()}` : ''}` : dateFilterState.preset !== 'all' && all.length ? `No closed trades ${dateFilterPhrase()}` : 'No closed trades yet', 'When a copied position is fully sold (by your exit rules, a mirror sell or by hand) it shows up here with what you paid, what came back and the result.');
    return;
  }
  setHtml(tbody, rows
    .slice((closedPage - 1) * CLOSED_PAGE_SIZE, closedPage * CLOSED_PAGE_SIZE)
    .map((r) => {
      const up = r.pnlUsd >= 0;
      const held = r.closedAt ? durationShort(r.closedAt - r.openedAt) : '—';
      return `
        <tr class="closed-row">
          <td>
            <div class="closed-token">
              ${tokenAvatar(r.imageUrl, r.symbol, 62, r.tokenAddress)}
              <div class="closed-token-main">
                <div class="closed-sym">${tokenLinkHtml(r.symbol, r.tokenAddress)}${isRealClosed(r) ? '<span class="sig-pill sp-real" title="Real SOL trade from the bot wallet">real</span>' : '<span class="sig-pill sp-dex">paper</span>'}</div>
                <div class="closed-meta"><span class="closed-held" title="Held for ${held}">${held}</span><span class="muted">${esc(r.name && r.name !== r.symbol ? r.name : '')}</span> ${traderLinkHtml(r.traderHandle, r.traderWallet)}</div>
              </div>
            </div>
          </td>
          <td><div class="closed-amt"><span class="mono closed-buy">${formatUsd(r.boughtUsd)}</span>${solChip(r.boughtSol, r.solExact, 'invested')}</div><div class="mono muted closed-sub">${formatQty(r.boughtTokens)} ${esc(r.symbol)}</div></td>
          <td><div class="closed-amt"><span class="mono closed-sell">${formatUsd(r.soldUsd)}</span>${solChip(r.soldSol, r.solExact, 'returned')}</div><div class="mono muted closed-sub">${formatQty(r.soldTokens)} ${esc(r.symbol)}</div></td>
          <td><span class="mono closed-pnl ${up ? 'pos-up' : 'pos-down'}">${signedUsd(r.pnlUsd)} (${signedPct(r.pnlPct)})</span><div class="muted closed-sub">${r.pnlSol != null ? `<span class="mono closed-pnl-sol ${r.pnlSol >= 0 ? 'pos-up' : 'pos-down'}" title="${r.solExact ? 'Exact: SOL price recorded at the buy and each sell' : 'Estimated with today\'s SOL price (older trade)'}">${r.solExact ? '' : '≈'}${signedSol(r.pnlSol)}</span>` : ''}${r.pnlSol != null && r.closeCause ? ' · ' : ''}${r.closeCause ? esc(r.closeCause) : ''}</div></td>
          <td><div class="closed-when" title="${fmtDateTime(r.openedAt)}">${timeAgo(r.openedAt)}</div>${r.closedAt ? `<div class="muted closed-sub" title="${fmtDateTime(r.closedAt)}">closed ${timeAgo(r.closedAt)}</div>` : ''}</td>
          <td class="right"><div class="sig-actions"><a class="ext-ico" href="https://dexscreener.com/solana/${encodeURIComponent(r.tokenAddress || '')}" target="_blank" rel="noopener" title="Open ${esc(r.symbol)} on DexScreener" aria-label="Open token on DexScreener"><img src="/icons/dexscreener.png" alt="" width="20" height="17" /></a><button type="button" class="sig-more-btn" onclick="openPnlCard('${r.id}', true)" title="Share PnL card" aria-label="Share PnL card"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><polyline points="7 8 12 3 17 8"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg></button></div></td>
        </tr>`;
    })
    .join(''));
}

// PnL card unit: USD or SOL (remembered on this browser)
let pnlUnit = (() => {
  try {
    return localStorage.getItem('odex.pnlUnit') === 'sol' ? 'sol' : 'usd';
  } catch {
    return 'usd';
  }
})();
window.setPnlUnit = function setPnlUnit(unit) {
  pnlUnit = unit === 'sol' ? 'sol' : 'usd';
  try {
    localStorage.setItem('odex.pnlUnit', pnlUnit);
  } catch {
    // ignore
  }
  if (engineState) renderKpiStrip();
};
/** A signed amount in the PnL card's unit; SOL uses the live SOL price. */
function pnlAmount(usd) {
  if (pnlUnit === 'sol') {
    const px = Number(engineState?.chains?.solana?.nativePriceUsd) || 0;
    return px > 0 ? signedSol(usd / px) : signedUsd(usd);
  }
  return signedUsd(usd);
}

// ---------------------------------------------------------------------------
// One source for every PnL figure: the server's permanent PnL log (same as the calendar).
// Cards ask for the totals of the selected period + mode; refreshed after each sell.
// ---------------------------------------------------------------------------
let pnlSummary = { key: '', data: null, at: 0, loading: '' };
function pnlSummaryKey() {
  const r = activeDateRange();
  const all = dateFilterState.preset === 'all';
  const from = all ? 0 : Number(r.startDate) || 0;
  const to = all ? 0 : Number(r.endDate) || 0;
  const mode = engineState?.settings?.paperTrading === false ? 'real' : 'paper';
  return { key: `${from}|${to}|${mode}`, from, to, mode };
}
function currentPnlSummary() {
  const k = pnlSummaryKey();
  if (pnlSummary.key === k.key && pnlSummary.data) {
    if (Date.now() - pnlSummary.at > 15_000) refreshPnlSummary();
    return pnlSummary.data;
  }
  refreshPnlSummary();
  return null;
}
async function refreshPnlSummary() {
  const k = pnlSummaryKey();
  if (pnlSummary.loading === k.key) return;
  pnlSummary.loading = k.key;
  try {
    const q = new URLSearchParams({ from: String(k.from), to: String(k.to), mode: k.mode });
    const d = await (await fetch(`/api/pnl/summary?${q}`)).json();
    if (d.ok && pnlSummaryKey().key === k.key) {
      pnlSummary = { key: k.key, data: d, at: Date.now(), loading: '' };
      if (engineState) {
        renderKpiStrip();
        renderClosedPositions();
        renderFollowsList();
      }
    }
  } catch {
    // keep the last figures; retried on the next render
  } finally {
    if (pnlSummary.loading === k.key) pnlSummary.loading = '';
  }
}

function renderKpiStrip() {
  const wallets = engineState.wallets.filter((w) => !w.archived);
  const activeWallet = wallets.find((w) => w.active) || wallets[0];
  const chains = engineState.chains;

  // Real balance = what the wallet's Solana address actually holds on-chain (never an internal number)
  const onChain = botWalletBalance() || balanceFor(activeWallet);
  const totalPortfolioUsd = onChain ? onChain.usd : 0;
  const activeWalletUsd = totalPortfolioUsd;
  void chains;

  const ps = engineState.positionsSummary;

  const range = activeDateRange();
  const hasDateFilter = dateFilterState.preset !== 'all' && (range.startDate || range.endDate);
  const filterStart = range.startDate || 0;
  const filterEnd = range.endDate || Infinity;
  const filterLabel = formatDateRangeLabel(dateFilterState.preset, range.startDate, range.endDate);

  // Card 1: Total Portfolio Balance
  const paperMode = Boolean(engineState.settings?.paperTrading);
  const paperCash = Number(activeWallet.paperBalanceUsd ?? 10000);
  const totalBalEl = document.getElementById('kpi-total-balance');
  if (totalBalEl) totalBalEl.textContent = formatUsd((paperMode ? paperCash : totalPortfolioUsd) + ps.totalValueUsd);
  const actWalletSubEl = document.getElementById('kpi-active-wallet-sub');
  if (actWalletSubEl) {
    if (hasDateFilter) {
      const S = currentPnlSummary();
      const periodRealized = S ? S.realized : 0;
      actWalletSubEl.textContent = `${!paperMode && onChain?.bot ? 'Bot wallet' : activeWallet.name} · ${filterLabel}: ${signedUsd(periodRealized)} realized`;
    } else {
      actWalletSubEl.textContent = paperMode
        ? `Paper balance · ${formatUsd(paperCash)} cash`
        : onChain ? `${onChain.bot ? 'Bot wallet' : 'On-chain'} · ${onChain.sol.toFixed(3)} SOL · ${onChain.usdc.toFixed(2)} USDC` : 'Link Phantom or add your address to see your real balance';
    }
  }

  // Card 2: Open Positions Value
  const openValEl = document.getElementById('kpi-open-value');
  const openCountEl = document.getElementById('kpi-open-count');
  if (hasDateFilter) {
    const periodPositions = engineState.positions.filter(
      (p) => p.openedAt >= filterStart && p.openedAt <= filterEnd && p.remainingTokens > 0
    );
    const pVal = periodPositions.reduce(
      (acc, p) => acc + (p.currentValueUsd || p.remainingTokens * (p.currentPriceUsd || p.entryPriceUsd)),
      0
    );
    const pCost = periodPositions.reduce(
      (acc, p) => acc + (p.totalCostUsd || p.remainingTokens * p.entryPriceUsd),
      0
    );
    if (openValEl) openValEl.textContent = formatUsd(pVal);
    if (openCountEl) openCountEl.textContent = `${periodPositions.length} opened · cost ${formatUsd(pCost)}`;
  } else {
    if (openValEl) openValEl.textContent = formatUsd(ps.totalValueUsd);
    if (openCountEl) openCountEl.textContent = `${ps.openCount} open · cost basis ${formatUsd(ps.totalCostUsd)}`;
  }

  // Card 3: Unrealized / Period PnL
  const pnlEl = document.getElementById('kpi-unrealized-pnl');
  const pnlLabelEl = document.getElementById('kpi-pnl-label');
  const pnlSubEl = document.getElementById('kpi-pnl-sub');
  if (hasDateFilter) {
    if (pnlLabelEl) pnlLabelEl.textContent = 'Period PnL';
    // realized: the permanent PnL log (exactly what the calendar shows for these days)
    const S = currentPnlSummary();
    const periodRealized = S ? S.realized : 0;

    const periodPositions = engineState.positions.filter(
      (p) => p.openedAt >= filterStart && p.openedAt <= filterEnd && p.remainingTokens > 0
    );
    const periodUnrealized = periodPositions.reduce((sum, p) => sum + (p.unrealizedPnlUsd || 0), 0);
    const totalPeriodPnl = periodRealized + periodUnrealized;

    // % of the money behind it: cost of what was sold in the period + cost of what is still open
    const periodCost = (S ? S.costSold : 0) + periodPositions.reduce((sum, p) => sum + (p.remainingCostUsd || 0), 0);
    const pct = periodCost > 0 ? (totalPeriodPnl / periodCost) * 100 : 0;
    const sign = totalPeriodPnl >= 0 ? '+' : '';

    if (pnlEl) {
      pnlEl.innerHTML = `${pnlAmount(totalPeriodPnl)}${periodCost > 0 ? ` <span class="kpi-pct">${trendCircle(pct)}${signedPct(pct)}</span>` : ''}`;
      pnlEl.className = `kpi-value ${totalPeriodPnl >= 0 ? 'pos-up' : 'pos-down'}`;
    }
    if (pnlSubEl) {
      pnlSubEl.textContent = pnlUnit === 'sol' && pnlAmount(periodRealized).endsWith(' SOL')
        ? `Realized ${pnlAmount(periodRealized).replace(' SOL', '')} · Open ${pnlAmount(periodUnrealized)}`
        : `Realized ${pnlAmount(periodRealized)} · Open ${pnlAmount(periodUnrealized)}`;
      pnlSubEl.title = `Realized and open PnL for ${filterLabel}`;
    }
  } else {
    if (pnlLabelEl) pnlLabelEl.textContent = 'Unrealized PnL';
    if (pnlEl) {
      const sign = ps.unrealizedPnlUsd >= 0 ? '+' : '';
      pnlEl.innerHTML = `${pnlAmount(ps.unrealizedPnlUsd)} <span class="kpi-pct">${trendCircle(ps.unrealizedPnlPct)}${signedPct(ps.unrealizedPnlPct)}</span>`;
      pnlEl.className = `kpi-value ${ps.unrealizedPnlUsd >= 0 ? 'pos-up' : 'pos-down'}`;
    }
    if (pnlSubEl) {
      pnlSubEl.textContent = ps.openCount ? `Across ${ps.openCount} open position${ps.openCount === 1 ? '' : 's'} · updates live` : 'No open positions yet';
    }
  }

  document.querySelectorAll('.kpi-unit button').forEach((b) => b.classList.toggle('active', b.dataset.unit === pnlUnit));
  if (pnlEl) pnlEl.title = pnlUnit === 'sol' ? 'In SOL at the live SOL price · click for USD' : 'Click to show in SOL';

  // Card 5: win rate of the trades closed in the date filter's period (All time = historical)
  // from the PnL log too: every trade closed in the period, also those older than the 2-day list
  const WS = currentPnlSummary();
  const closedAll = WS ? { length: WS.trades } : (engineState.closedPositions || []).filter((c) => inDateFilter(c.closedAt || c.openedAt));
  const wrLabel = document.getElementById('kpi-winrate-label');
  if (wrLabel) wrLabel.textContent = dateFilterState.preset === 'all' ? 'Historical win rate' : 'Win rate';
  const winsAll = WS ? WS.wins : closedAll.filter((c) => c.pnlUsd > 0).length;
  const lossesAll = WS ? WS.losses : closedAll.filter((c) => c.pnlUsd < 0).length;
  const wrEl = document.getElementById('kpi-winrate');
  const wrSub = document.getElementById('kpi-winrate-sub');
  if (wrEl) {
    const rate = closedAll.length ? (winsAll / closedAll.length) * 100 : null;
    wrEl.textContent = rate == null ? '--%' : `${rate.toFixed(rate % 1 ? 1 : 0)}%`;
    wrEl.className = 'kpi-value'; // plain white figure
  }
  if (wrSub) wrSub.textContent = closedAll.length ? `${closedAll.length} closed trade${closedAll.length === 1 ? '' : 's'} · ${winsAll} won · ${lossesAll} lost` : `No closed trades ${dateFilterState.preset === 'all' ? 'yet' : dateFilterPhrase()}`;

  // Card 4: Traders You Copy
  const totalFollows = engineState.follows.length;
  const copyingFollows = engineState.follows.filter((f) => f.status === 'copying').length;
  const folCountEl = document.getElementById('kpi-follows-count');
  const pumpOn = engineState.settings.filters.pumpOnly;
  const pumpBadgeEl = document.getElementById('kpi-pump-only-badge');

  if (hasDateFilter) {
    const CS = currentPnlSummary();
    const copied = CS ? CS.copiedBuys : engineState.history.filter((h) => h.side === 'buy' && h.status === 'filled' && h.timestamp >= filterStart && h.timestamp <= filterEnd).length;
    if (folCountEl) folCountEl.textContent = String(totalFollows);
    if (pumpBadgeEl) {
      pumpBadgeEl.textContent = `${copyingFollows} copying · ${copied} copied buy${copied === 1 ? '' : 's'} in ${filterLabel}`;
    }
  } else {
    if (folCountEl) folCountEl.textContent = String(totalFollows);
    if (pumpBadgeEl) {
      pumpBadgeEl.textContent = `${copyingFollows} copying · pump-only ${pumpOn ? 'on' : 'off'} · max chase ${engineState.settings.maxChasePct}%`;
    }
  }

  document.getElementById('badge-pos-count').textContent = String(ps.openCount);
  const folBadge = document.getElementById('badge-fol-count');
  if (folBadge) folBadge.textContent = String(totalFollows);
  const folSum = document.getElementById('follows-header-summary');
  if (folSum) folSum.textContent = `${totalFollows} trader${totalFollows === 1 ? '' : 's'} · ${copyingFollows} copying`;
  const cfgFol = document.querySelector('.cfg-nav-btn[data-cfg="copytrades"] small');
  if (cfgFol) cfgFol.textContent = totalFollows ? `${totalFollows} trader${totalFollows === 1 ? '' : 's'} · ${copyingFollows} copying` : 'Traders you copy & exit rules';
  const pumpBtn = document.getElementById('btn-toggle-pump-only');
  if (pumpBtn) {
    pumpBtn.textContent = `Pump-Only: ${pumpOn ? 'ON' : 'OFF'}`;
  }

  const hwdNameEl = document.getElementById('hwd-wallet-name');
  const botBal = botWalletBalance();
  if (hwdNameEl) hwdNameEl.textContent = botBal ? 'Bot Wallet' : activeWallet.name === 'Main' ? 'Solana Wallet' : activeWallet.name;
  const hwdAddr = botBal?.address || walletChainAddress(activeWallet);
  const hwdAddrEl = document.getElementById('hwd-wallet-addr');
  if (hwdAddrEl) {
    hwdAddrEl.textContent = hwdAddr ? `${hwdAddr.slice(0, 4)}…${hwdAddr.slice(-4)}` : 'No address linked';
    hwdAddrEl.title = hwdAddr || '';
  }
  const hwdCopy = document.getElementById('hwd-copy');
  if (hwdCopy) hwdCopy.style.display = hwdAddr ? '' : 'none';
  renderBalancesEverywhereLite();


  if (document.getElementById('modal-deposit')?.classList.contains('open')) renderDepositPane();
}

// Preserve in-progress input values (armed-order fields) across live SSE re-renders
function snapshotInputs(container) {
  const snap = {};
  container.querySelectorAll('input[id], select[id]').forEach((el) => {
    snap[el.id] = el.value;
  });
  const active = document.activeElement;
  return { snap, focusId: active && container.contains(active) ? active.id : null };
}

function restoreInputs(container, { snap, focusId }) {
  for (const [id, val] of Object.entries(snap)) {
    const el = document.getElementById(id);
    if (el && container.contains(el)) el.value = val;
  }
  if (focusId) document.getElementById(focusId)?.focus();
}

function renderPositionsList() {
  const container = document.getElementById('positions-list');
  if (!container) return;

  renderTraderFilterBar();
  const positions = engineState.positions.filter(matchesTraderFilter);
  if (!positions.length && traderFilter) {
    container.innerHTML = `<div class="empty-inline"><div class="empty-inline-title">No open positions from ${esc(traderFilter.label)}</div><div class="empty-inline-actions"><button class="btn btn-sm" onclick="clearTraderFilter()">Show all traders</button></div></div>`;
    return;
  }
  if (!positions.length) {
    container.innerHTML = `
      <div class="empty-state-card">
        <div class="empty-icon-shield">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>
        <h3 class="empty-title">No open positions</h3>
        <p class="empty-desc">
          Add a trader's Solana wallet and every buy it makes on-chain is copied here, protected by your exit rules.
        </p>
        <div class="empty-cta-action-row">
          <button class="btn-cta-copy" onclick="openQuickCopyModal()">
            <svg class="btn-cta-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span>Copy a wallet</span>
          </button>
        </div>
      </div>
    `;
    return;
  }

  const state = snapshotInputs(container);

  container.innerHTML = positions
    .map((p) => {
      const up = p.unrealizedPnlUsd >= 0;
      const pnlClass = up ? 'pos-up' : 'pos-down';
      const follow = engineState.follows.find((f) => f.id === p.followId);
      const modeLabel = (follow ? follow.mode : 'auto-exit').replace(/-/g, ' ');
      const armedOrders = p.armedOrders || [];
      const pnlPct = Number(p.unrealizedPnlPct || 0);

      return `
        <article class="position-card ${up ? 'is-up' : 'is-down'}">
          <div class="pos-top-row">
            <div class="pos-identity">
              ${tokenAvatar(p.imageUrl, p.symbol, 42, p.tokenAddress)}
              ${chainBadgeHtml(p.chainId)}
              <span class="pos-symbol">${tokenLinkHtml(p.symbol, p.tokenAddress)}</span>
              <span class="pos-name-leader">${esc(p.name)} <span class="sep">·</span> copied ${walletAvatar(traderWalletOf(p), p.traderHandle, 16, 'w-avatar-xs')} ${traderLinkHtml(p.traderHandle, traderWalletOf(p))}</span>
              <span class="pos-tags">
                ${p.isPaper ? '<span class="tag tag-paper">Paper</span>' : ''}
                ${p.renounced ? '<span class="tag tag-green">Renounced</span>' : ''}
                <span class="tag tag-blue">${modeLabel}</span>
              </span>
            </div>
            <div class="pos-quick-actions">
              <button class="btn btn-sm" onclick="openPnlCard('${p.id}')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                Share
              </button>
            </div>
          </div>

          <div class="pos-metrics-grid">
            <div class="pos-metric-item">
              <span>Value</span>
              <strong class="mono">${formatUsd(p.valueUsd)}</strong>
            </div>
            <div class="pos-metric-item">
              <span>Unrealized PnL</span>
              <strong class="mono ${pnlClass}">${signedUsd(p.unrealizedPnlUsd)} <em>${signedPct(pnlPct)}</em></strong>
            </div>
            <div class="pos-metric-item">
              <span>Entry MC → now</span>
              <strong class="mono">${formatMc(p.entryMarketCapUsd)} <span class="arrow">→</span> ${formatMc(p.currentMarketCapUsd)}</strong>
            </div>
            <div class="pos-metric-item">
              <span>Liquidity</span>
              <strong class="mono">${Number(p.liquidityUsd) > 0 ? formatMc(p.liquidityUsd) : '<span class="muted" title="No liquidity figure available yet">—</span>'}</strong>
              ${p.priceUpdatedAt ? `<em class="pos-fresh" title="Price, market cap and liquidity source">${p.priceSource === 'pump-curve' ? 'pump.fun curve' : p.priceSource === 'dexscreener' ? 'DexScreener' : 'last trade'} · ${Math.max(0, Math.round((Date.now() - p.priceUpdatedAt) / 1000))}s ago</em>` : ''}
            </div>
            <div class="pos-metric-item">
              <span>Exit state</span>
              <strong class="exit-state">
                <span class="state-chip ${p.initialsTaken ? 'on' : ''}">${p.initialsTaken ? 'Initials taken' : 'Full bag'}</span>
                <span class="state-chip ${p.trailArmed ? 'on' : ''}">${p.trailArmed ? 'Trail armed' : 'Watching'}</span>
                <span class="age mono">${p.ageSec}s</span>
              </strong>
            </div>
          </div>

          <div class="pos-action-row">
            <div class="instant-sell-group">
              <span class="instant-sell-label">Sell</span>
              <button class="btn btn-sm" onclick="sellPosition('${p.id}', 'initials')" title="Sell enough to recover your cost">Initials</button>
              <button class="btn btn-sm" onclick="sellPosition('${p.id}', 50)">50%</button>
              <button class="btn btn-danger-soft btn-sm" onclick="sellPosition('${p.id}', 100)">100%</button>
              ${p.isPaper === false && (p.realTokensMissing || p.realMissingChecks > 0) ? `<button class="btn btn-sm" onclick="closePositionRecord('${p.id}')" title="The coins are no longer in the bot wallet: check on-chain and close this record with the real result">Close record</button>` : ''}
            </div>

            <div class="armed-order-group">
              <span class="armed-order-label">Limit orders <span class="mono">${armedOrders.length}/5</span></span>
              <select id="lim-type-${p.id}" class="input input-compact" aria-label="Order type">
                <option value="take-profit">TP at %</option>
                <option value="take-profit-mc">TP at $MC</option>
                <option value="stop-loss">SL at %</option>
                <option value="sell-initials">Sell initials</option>
              </select>
              <label class="input-affix"><input type="number" id="lim-val-${p.id}" class="input input-compact mono" value="80" aria-label="Trigger value" /><span>trigger</span></label>
              <label class="input-affix"><input type="number" id="lim-size-${p.id}" class="input input-compact mono" value="50" min="1" max="100" aria-label="Size percent" /><span>% size</span></label>
              <button class="btn btn-primary btn-sm" onclick="armOrderForPosition('${p.id}')" ${armedOrders.length >= 5 ? 'disabled' : ''}>Arm</button>
            </div>
          </div>

          ${
            armedOrders.length > 0
              ? `<div class="armed-list">
                  ${armedOrders
                    .map(
                      (o) => `
                    <div class="armed-pill-tag mono">
                      <span>${o.type.replace(/-/g, ' ')} @ ${o.triggerType === 'mc' ? formatMc(o.triggerValue) : `${o.triggerValue}%`} · ${o.type === 'sell-initials' ? 'initials' : `${o.sizePct}%`}</span>
                      <button onclick="cancelArmedOrder('${p.id}', '${o.id}')" aria-label="Cancel order">✕</button>
                    </div>`
                    )
                    .join('')}
                </div>`
              : ''
          }
        </article>
      `;
    })
    .join('');

  restoreInputs(container, state);
}

function fmtHold(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/** Filtered scorecard for a trader wallet in the active date range (All time uses the live scorecard). */
function traderScoreForFilter(f) {
  if (!f || !engineState) return null;
  if (dateFilterState.preset === 'all') {
    return engineState.traderScores?.[f.id] || null;
  }
  const S = currentPnlSummary();
  if (S?.traderScores?.[f.id]) return S.traderScores[f.id];
  // Synchronous fallback while /api/pnl/summary is loading so the UI never flickers
  const paper = Boolean(engineState.settings?.paperTrading);
  const closed = (engineState.closedPositions || [])
    .filter((c) => (c.followId === f.id || (f.traderWallet && c.traderWallet === f.traderWallet)) && Boolean(c.isPaper) === paper && inDateFilter(c.closedAt || c.openedAt))
    .sort((a, b) => (a.closedAt || a.openedAt || 0) - (b.closedAt || b.openedAt || 0));
  const pnls = closed.map((c) => Number(c.pnlUsd)).filter(Number.isFinite);
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p < 0).length;
  let losingStreak = 0;
  for (let i = pnls.length - 1; i >= 0; i--) {
    if (pnls[i] < 0) losingStreak += 1;
    else if (pnls[i] > 0) break;
  }
  const held = closed
    .map((c) => (c.closedAt && c.openedAt ? Math.max(0, Math.round((c.closedAt - c.openedAt) / 1000)) : null))
    .filter(Number.isFinite);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    followId: f.id,
    paper,
    trades: closed.length,
    wins,
    losses,
    losingStreak,
    winRatePct: wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : null,
    pnlUsd: Number(pnls.reduce((a, b) => a + b, 0).toFixed(2)),
    avgHoldSec: held.length ? Math.round(avg(held)) : null,
    avgEntrySlipPct: null,
    avgExitSlipPct: null,
    roundTripSlipPct: null,
    avgLagSec: null,
    measuredSlip: 0,
    measuredExits: 0,
  };
}

/** Scorecard strip on a trader card: real results of the copies and how far they slip behind. */
function traderScoreHtml(f) {
  const sc = traderScoreForFilter(f);
  if (!sc) return '';
  const cfg = { autoPause: true, minTrades: 10, maxSlipPct: 20, maxLagSec: 10, ...(engineState.settings.scorecard || {}) };
  const pct = (v, signed = true) => (v === null || v === undefined ? '—' : `${signed && v > 0 ? '+' : ''}${Number(v).toFixed(1)}%`);
  const slipBad = sc.roundTripSlipPct !== null && sc.roundTripSlipPct > cfg.maxSlipPct;
  const lagBad = sc.avgLagSec !== null && sc.avgLagSec > cfg.maxLagSec;
  const pnlCls = sc.pnlUsd > 0 ? 'pos-up' : sc.pnlUsd < 0 ? 'pos-down' : '';
  const judged = sc.trades >= cfg.minTrades;
  const periodLabel = dateFilterText();
  const verdict = f.pauseReason === 'slow'
    ? `<span class="score-verdict is-bad">Paused: ${esc(f.pauseDetail || "the bot can't keep up")}</span>`
    : !sc.trades
      ? `<span class="score-verdict">No closed copies ${dateFilterState.preset === 'all' ? 'yet' : dateFilterPhrase()}</span>`
      : !judged
        ? `<span class="score-verdict">${sc.trades}/${cfg.minTrades} copies before ${cfg.autoPause ? 'auto-pause can judge' : 'the score is reliable'}</span>`
        : slipBad || lagBad
          ? `<span class="score-verdict is-bad">Falling behind this trader${cfg.autoPause ? '' : ' (auto-pause is off)'}</span>`
          : '<span class="score-verdict is-good">Keeping up</span>';
  return `
          <div class="trader-score">
            <div class="score-head"><span>Copy scorecard · ${esc(periodLabel)} · ${engineState.settings.paperTrading ? 'paper' : 'real'}</span>${verdict}</div>
            <div class="score-grid">
              <div class="score-item"><span>Win rate</span><strong class="mono">${sc.winRatePct === null ? '—' : `${sc.winRatePct.toFixed(0)}%`}</strong><em>${sc.wins}W · ${sc.losses}L</em></div>
              <div class="score-item"><span>Copy PnL</span><strong class="mono ${pnlCls}">${sc.trades ? `${sc.pnlUsd >= 0 ? '+' : '−'}$${Math.abs(sc.pnlUsd).toFixed(2)}` : '—'}</strong><em>${sc.trades} trade${sc.trades === 1 ? '' : 's'}</em></div>
              <div class="score-item"><span>Avg hold</span><strong class="mono">${fmtHold(sc.avgHoldSec)}</strong><em>per trade</em></div>
              <div class="score-item" title="How much higher our copies bought than the trader did"><span>Entry slip</span><strong class="mono">${pct(sc.avgEntrySlipPct)}</strong><em>vs trader buy</em></div>
              <div class="score-item" title="Mirror sells: our sell price vs the trader's (negative = we sold lower)"><span>Exit slip</span><strong class="mono">${pct(sc.avgExitSlipPct)}</strong><em>${sc.measuredExits ? `${sc.measuredExits} mirror sell${sc.measuredExits === 1 ? '' : 's'}` : 'no mirror sells'}</em></div>
              <div class="score-item ${slipBad ? 'is-bad' : ''}" title="Entry slip minus exit slip: what copying this trader costs per trade"><span>Total slip</span><strong class="mono">${pct(sc.roundTripSlipPct)}</strong><em>limit ${cfg.maxSlipPct}%</em></div>
              <div class="score-item ${lagBad ? 'is-bad' : ''}" title="Seconds between the trader's trade landing and our copy"><span>Detect delay</span><strong class="mono">${sc.avgLagSec === null ? '—' : `${sc.avgLagSec.toFixed(1)}s`}</strong><em>limit ${cfg.maxLagSec}s</em></div>
            </div>
          </div>`;
}

/** Small green circle with an up arrow (gain) or red circle with a down arrow (loss). */
function trendCircle(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  const up = n > 0;
  return `<span class="trend-circle ${up ? 'is-up' : 'is-down'}" aria-label="${up ? 'up' : 'down'}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${up ? '<path d="M12 19V5M5 12l7-7 7 7"/>' : '<path d="M12 5v14M19 12l-7 7-7-7"/>'}</svg></span>`;
}

function renderFollowsList() {
  const followsDateLabel = document.getElementById('follows-date-filter-label');
  if (followsDateLabel) followsDateLabel.textContent = dateFilterText();
  const mainDateLabel = document.getElementById('date-filter-label');
  if (mainDateLabel) mainDateLabel.textContent = dateFilterText();

  const container = document.getElementById('follows-list');
  if (!container) return;

  if (!engineState.follows.length) {
    container.__lastHtml = null;
    container.innerHTML = `
      <div class="empty-inline">
        <div class="empty-inline-title">You aren't copying anyone yet</div>
        <div class="empty-inline-desc">Paste a trader's Solana wallet address. Their real on-chain buys and sells are copied with your settings.</div>
        <div class="empty-inline-actions">
          <button class="btn btn-primary btn-sm" onclick="openQuickCopyModal()">Copy a wallet</button>
        </div>
      </div>`;
    return;
  }

  setHtml(container, engineState.follows
    .map((f) => {
      const isCopying = f.status === 'copying';
      const sizeText =
        f.sizing.type === 'fixed'
          ? `$${f.sizing.amount} per trade`
          : f.sizing.type === 'percent'
            ? `${f.sizing.amount}% of balance`
            : `1:1 proportional (cap $${f.sizing.amount})`;
      const tpslText = `${f.tpPct ? `TP +${f.tpPct}%` : 'No TP'} · ${f.slPct ? `SL −${f.slPct}%` : 'No SL'}`;
      const activeExitCount = Object.values(f.exitRules || {}).filter((r) => r && r.enabled).length;
      const openCount = engineState.positions.filter((p) => (p.followId === f.id || (f.traderWallet && p.traderWallet === f.traderWallet)) && p.remainingTokens > 0 && (dateFilterState.preset === 'all' || inDateFilter(p.openedAt))).length;
      const histCount = engineState.history.filter((h) => (h.followId === f.id || traderWalletOf(h) === f.traderWallet) && inDateFilter(h.timestamp)).length;
      const sigCount = (liveWatch?.signals || []).filter((x) => x.wallet === f.traderWallet && !x.backfill && inDateFilter(x.blockTime || x.detectedAt)).length;
      const sc = traderScoreForFilter(f);
      const streakVal = dateFilterState.preset === 'all' ? (f.consecutiveLosses || 0) : (sc?.losingStreak ?? 0);
      const slow = f.pauseReason === 'slow';

      return `
        <div class="follow-card ${isCopying ? '' : 'is-paused'}" data-follow="${f.id}">
          <div class="follow-head">
            <div class="follow-identity">
              ${walletAvatar(f.traderWallet, f.name || f.handle, 44)}
              <div>
                <div class="follow-name-row">
                  <strong class="follow-name">${esc(f.name)}</strong>
                  <span class="status-pill ${isCopying ? 'status-copying' : 'status-paused'}">${isCopying ? 'Copying' : slow ? "Paused · can't keep up" : 'Paused'}</span>${f.copyTopUps === true && Number(f.maxChasePct) >= 1000 ? '<span class="status-pill status-copyall" title="No price-chase limit, top-ups copied">Copy every trade</span>' : ''}
                  ${chainBadgeHtml(f.chainId)}
                </div>
                <div class="follow-sub mono"><a href="https://solscan.io/account/${encodeURIComponent(f.traderWallet)}" target="_blank" rel="noopener" title="${f.traderWallet}">${f.traderWallet.slice(0, 6)}…${f.traderWallet.slice(-6)}</a> · copies real swaps</div>
              </div>
            </div>
            <div class="card-actions">
              <button class="btn btn-sm" onclick="toggleFollowStatus('${f.id}', '${isCopying ? 'paused' : 'copying'}')">${isCopying ? 'Pause' : 'Resume'}</button>
              <button class="btn btn-sm" onclick="openEditFollowModal('${f.id}')">Settings</button>
              <button class="btn btn-indigo-soft btn-sm" onclick="openExitRulesModal('${f.id}')">Exit rules <span class="mono rule-count">${activeExitCount}/5</span></button>
              <button class="btn btn-ghost-danger btn-sm" onclick="removeFollow('${f.id}')">Remove</button>
            </div>
          </div>

          <div class="follow-meta-grid">
            <div class="meta-item"><span>Exit mode</span><strong>${f.mode.replace(/-/g, ' ')}</strong></div>
            <div class="meta-item"><span>Sizing</span><strong class="mono">${sizeText}</strong></div>
            <div class="meta-item"><span>TP / SL</span><strong class="mono">${tpslText}</strong></div>
            <div class="meta-item"><span>Limits</span><strong class="mono">${[f.minTradeUsd != null ? `Min $${f.minTradeUsd}` : '', f.maxOpenPositions != null ? `${f.maxOpenPositions} open max` : '', f.maxAtRiskUsd != null ? `$${Number(f.maxAtRiskUsd).toLocaleString()} at risk` : ''].filter(Boolean).join(' · ') || 'None set'}</strong></div>
            <div class="meta-item"><span>Losing streak</span><strong class="mono ${streakVal > 0 ? 'pos-down' : ''}">${streakVal}</strong></div>
          </div>
          ${traderScoreHtml(f)}
          ${f.mode === 'auto-exit' && activeExitCount === 0 ? `<div class="follow-warn">
            <span><strong>No exit rules are on.</strong> In Auto-Exit mode nothing sells automatically, and the trader's sells aren't copied either.</span>
            <button type="button" class="btn btn-sm btn-primary" onclick="useRecommendedExits('${f.id}')">Turn on recommended exits</button>
          </div>` : ''}
          <div class="follow-links">
            <button type="button" class="link-chip" onclick="filterByTrader('${f.traderWallet}', 'positions')">Positions <span class="mono">${openCount}</span></button>
            <button type="button" class="link-chip" onclick="filterByTrader('${f.traderWallet}', 'signals')">Live signals <span class="mono">${sigCount}</span></button>
            <button type="button" class="link-chip" onclick="filterByTrader('${f.traderWallet}', 'history')">Trade history <span class="mono">${histCount}</span></button>
          </div>
        </div>
      `;
    })
    .join(''));
}

function renderWalletsList() {
  const container = document.getElementById('wallets-list');
  if (!container) return;

  const solPrice = engineState.chains?.solana?.nativePriceUsd || 0;
  const wallets = engineState.wallets.filter((w) => !w.archived);
  const headStatus = document.getElementById('wallet-head-status');
  if (headStatus) headStatus.style.display = wallets.some((w) => w.active) ? '' : 'none';
  setHtml(container, wallets
    .map((w) => {
      const chainAddr = walletChainAddress(w);
      const addr = chainAddr;
      const viaPhantom = chainAddr && !isRealSolanaAddress(w.solanaAddress);
      const b = balanceFor(w);
      return `
        <div class="sol-wallet ${w.active ? 'is-active' : ''}">
          <svg class="sw-watermark" viewBox="0 0 397.7 311.7" aria-hidden="true"><use href="#sol-mark"/></svg>
          <div class="sw-top">
            <div class="sw-id">
              <span class="sw-logo"><svg viewBox="0 0 397.7 311.7" aria-hidden="true"><use href="#sol-mark"/></svg></span>
              <div>
                <div class="sw-name">${esc(w.name === 'Main' ? 'Solana Wallet' : w.name)}${wallets.length > 1 ? ` <span class="wallet-index mono">#${w.index}</span>` : ''}${w.isDefault ? ' <span class="sw-default" title="Default wallet: can\'t be deleted, takes over if the active wallet is deleted">Default</span>' : ''}${!w.active ? ' <span class="sw-inactive">Inactive</span>' : ''}</div>
                <div class="sw-addr mono">
                  ${addr ? `<span title="${addr}">${addr.slice(0, 4)}…${addr.slice(-4)}</span>
                  <button class="sw-copy" onclick="copyWalletAddress('${addr}')" title="Copy address" aria-label="Copy address"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`
                  : '<span class="sw-muted">No address yet · link Phantom or add yours in Receive</span>'}
                  ${viaPhantom ? '<span class="sw-muted">· Phantom</span>' : ''}
                </div>
              </div>
            </div>
            <div class="sw-top-right">
              ${!w.isDefault ? `<button type="button" class="sw-icon-btn" onclick="setDefaultWallet('${w.id}')" title="Make this the default wallet" aria-label="Make default wallet"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>
              <button type="button" class="sw-icon-btn is-danger" onclick="deleteWallet('${w.id}')" title="Delete wallet" aria-label="Delete wallet"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>` : ''}
              <span class="sw-chain"><svg width="16" height="13" viewBox="0 0 397.7 311.7" aria-hidden="true"><use href="#sol-mark"/></svg>Solana</span>
            </div>
          </div>
          <div class="sw-bottom">
            <div class="sw-bal">
              ${b
                ? `<div><strong class="mono">${b.sol.toFixed(3)}</strong> <span>SOL</span> <span class="sw-muted mono">· ${b.usdc.toFixed(2)} USDC</span></div>
              <div class="sw-usd mono">≈ ${formatUsd(b.usd)} on-chain</div>`
                : `<div><strong class="mono">—</strong> <span>SOL</span></div>
              <div class="sw-usd mono">${chainAddr ? (chainBalance?.error ? esc(chainBalance.error) : 'Reading on-chain balance…') : 'Add an address to see your real balance'}</div>`}
              ${engineState.settings?.paperTrading !== false ? `<div class="sw-paper"><span class="sw-paper-k">Paper balance</span><span class="mono">${formatUsd(Number(w.paperBalanceUsd ?? 10000))}</span>${solPrice > 0 ? `<span class="sw-muted mono">≈ ${fmtSol(Number(w.paperBalanceUsd ?? 10000) / solPrice)} SOL</span>` : ''}<button type="button" class="sw-paper-edit" onclick="openPaperBalance('${w.id}')">Set amount</button></div>` : ''}
            </div>
            <div class="sw-actions">
              ${!w.active ? `<button class="btn" onclick="switchActiveWallet('${w.id}')">Make active</button>` : ''}
              <button class="btn" onclick="openDepositModal('deposit')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>Receive</button>
              ${chainAddr ? `<a class="btn" href="https://solscan.io/account/${chainAddr}" target="_blank" rel="noopener"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Explorer</a>` : ''}
              <button class="btn btn-primary" onclick="openPaperBalance('${w.id}')" title="Control paper wallet balance"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>Paper balance</button>
            </div>
          </div>
        </div>
      `;
    })
    .join(''));
  renderBotWalletCard();
}

// ---------------------------------------------------------------------------
// Bot wallet card (Wallets section): the wallet real trades spend from (ODEX_TRADER_KEY)
// ---------------------------------------------------------------------------
let botCardStatus = null; // last /api/real/status
let botCardLoadedAt = 0;
let botCardLoading = false;
async function loadBotCardStatus(force = false) {
  if (botCardLoading || (!force && Date.now() - botCardLoadedAt < 20_000)) return;
  botCardLoading = true;
  try {
    botCardStatus = await (await fetch('/api/real/status')).json();
    window.__botStatus = botCardStatus;
  } catch {
    botCardStatus = botCardStatus || { error: true };
  } finally {
    botCardLoadedAt = Date.now();
    botCardLoading = false;
  }
  renderBotWalletCard(true);
  // real mode: the top cards and header show this balance
  if (engineState?.settings?.paperTrading === false) {
    try {
      renderBalancesEverywhereLite();
      renderKpiStrip();
    } catch {
      // page still loading
    }
  }
}
// Real mode: keep the bot wallet balance fresh everywhere (every 20 s), whichever tab is open
setInterval(() => {
  if (engineState?.settings?.paperTrading === false && document.visibilityState !== 'hidden') loadBotCardStatus(true);
}, 20_000);
window.addEventListener('DOMContentLoaded', () => setTimeout(() => loadBotCardStatus(true), 1500));

function renderBotWalletCard(fromLoad = false) {
  const el = document.getElementById('bot-wallet-card');
  if (!el) return;
  if (!fromLoad) loadBotCardStatus();
  const s = botCardStatus;
  if (!s) {
    el.innerHTML = '<div class="sol-wallet bot-wallet"><div class="sw-muted">Loading bot wallet…</div></div>';
    return;
  }
  const solPx = engineState?.chains?.solana?.nativePriceUsd || 0;
  let pill;
  let note;
  if (s.error) {
    pill = '<span class="bw-pill is-bad">Unavailable</span>';
    note = 'Could not load the bot wallet status.';
  } else if (s.keyError) {
    pill = '<span class="bw-pill is-bad">Key problem</span>';
    note = esc(s.keyError);
  } else if (!s.configured) {
    pill = '<span class="bw-pill">Not set up</span>';
    note = `Real trades spend from a separate bot wallet. Add its key as <code>ODEX_TRADER_KEY</code> in ${s.onRailway ? 'Railway → Variables' : '<code>.env</code>'} (plus <code>ODEX_PASSWORD</code> on Railway), then restart. Your bot wallet key is in <code>data/bot-wallet-KEEP-SECRET.txt</code> on your PC.`;
  } else if (s.blocked) {
    pill = '<span class="bw-pill is-bad">Blocked</span>';
    note = `Real trading is off: ${esc(s.blocked)}.`;
  } else if (s.active) {
    pill = '<span class="bw-pill is-live"><span class="dot"></span>Live</span>';
    note = `Paper Trading is OFF — copies spend real SOL from this wallet.${s.solPriceLive ? '' : ' Waiting for the live SOL price before ordering.'}`;
  } else {
    pill = '<span class="bw-pill is-ready">Ready</span>';
    note = 'Real trading starts when you switch Paper Trading OFF.';
  }
  const addr = s.address || '';
  const b = s.balance;
  const caps = s.caps || {};
  const spent = Number(s.spent24hSol || 0);
  const lowFunds = b && b.sol < Number(caps.reserveSol || 0.02) + 0.05;
  window.__botWallet = s;
  el.innerHTML = `
    <div class="sol-wallet bot-wallet">
      <div class="sw-top">
        <div class="sw-id">
          <span class="sw-logo bw-logo"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="14" r="1.3" fill="currentColor"/><circle cx="15" cy="14" r="1.3" fill="currentColor"/><path d="M2 13v3M22 13v3"/></svg></span>
          <div>
            <div class="sw-name">Bot Wallet <span class="bw-tag">Real trading</span> ${pill}</div>
            <div class="sw-addr mono">
              ${addr ? `<span title="${esc(addr)}">${esc(addr.slice(0, 4))}…${esc(addr.slice(-4))}</span>
              <button class="sw-copy" onclick="copyWalletAddress('${esc(addr)}')" title="Copy address" aria-label="Copy address"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` : '<span class="sw-muted">No bot wallet key yet</span>'}
            </div>
          </div>
        </div>
        <div class="sw-top-right"><span class="sw-chain"><svg width="16" height="13" viewBox="0 0 397.7 311.7" aria-hidden="true"><use href="#sol-mark"/></svg>Solana</span></div>
      </div>
      <div class="sw-bottom">
        <div class="sw-bal">
          ${b
            ? `<div><strong class="mono">${Number(b.sol).toFixed(3)}</strong> <span>SOL</span> <span class="sw-muted mono">· ${Number(b.usdc || 0).toFixed(2)} USDC</span></div>
          <div class="sw-usd mono">≈ ${formatUsd(Number(b.sol) * solPx + Number(b.usdc || 0))} on-chain${lowFunds ? ' · <span class="bw-warn">add SOL to trade</span>' : ''}</div>`
            : `<div><strong class="mono">—</strong> <span>SOL</span></div><div class="sw-usd mono">${addr ? 'Reading balance…' : 'Balance shows once the key is set'}</div>`}
          ${s.configured ? `<div class="bw-limits mono">Max ${caps.maxSolPerTrade} SOL per buy · ${caps.maxSolPerDay > 0 ? `${spent.toFixed(3)} / ${caps.maxSolPerDay} SOL used today` : 'no daily cap'} · ${caps.reserveSol} SOL kept for fees</div>` : ''}
          <div class="bw-note">${note}</div>
          ${s.configured ? `<div class="bw-rent mono" id="bw-rent">${rentLineHtml()}</div>` : ''}
        </div>
        <div class="sw-actions">
          ${s.configured ? `<button class="btn" id="bw-rent-btn" onclick="reclaimRentNow()" title="Close the bot wallet's empty token accounts and get their rent back (≈0.002 SOL per coin traded)">Reclaim rent</button>` : ''}
          ${s.configured ? `<button class="btn" onclick="openBotSendModal()" title="Send SOL from the bot wallet to another wallet">Send</button>` : ''}
          ${addr ? `<button class="btn" onclick="openDepositModal('deposit')" title="Send SOL to the bot wallet from Phantom or MetaMask">Fund</button>
          <a class="btn" href="https://solscan.io/account/${encodeURIComponent(addr)}" target="_blank" rel="noopener">Explorer</a>
          <button class="btn btn-primary" id="bw-test-btn" onclick="botWalletSelfTest()" title="Checks the key and simulates a tiny swap — nothing is sent">Self-test</button>` : ''}
        </div>
      </div>
    </div>`;
}

// ---------- Bot Wallet → Send ----------
const botSend = { reviewed: null };
window.openBotSendModal = function openBotSendModal() {
  const s = window.__botWallet || {};
  const m = document.getElementById('modal-bot-send');
  if (!m) return;
  botSend.reviewed = null;
  document.getElementById('bs-to').value = '';
  document.getElementById('bs-amount').value = '';
  document.getElementById('bs-max').checked = false;
  document.getElementById('bs-amount').disabled = false;
  const pw = document.getElementById('bs-pass');
  pw.value = '';
  document.getElementById('bs-pass-label').textContent = s.sendNeedsPassword ? 'Site password (asked for every send)' : 'Type SEND to confirm';
  pw.type = s.sendNeedsPassword ? 'password' : 'text';
  pw.placeholder = s.sendNeedsPassword ? 'Your Odex site password' : 'SEND';
  const bal = s.balance ? `${Number(s.balance.sol).toFixed(4)} SOL in the bot wallet` : 'Balance not read yet';
  document.getElementById('bs-balance').textContent = bal;
  botSendStatus('', '');
  const go = document.getElementById('bs-go');
  go.textContent = 'Review';
  go.disabled = false;
  m.classList.add('open');
  setTimeout(() => document.getElementById('bs-to').focus(), 50);
};
function botSendStatus(html, kind) {
  const el = document.getElementById('bs-status');
  el.className = `bs-status ${kind || ''}`;
  el.innerHTML = html;
}
window.botSendInputChanged = function botSendInputChanged() {
  // any change after a review needs a new review
  if (botSend.reviewed) {
    botSend.reviewed = null;
    document.getElementById('bs-go').textContent = 'Review';
    botSendStatus('', '');
  }
  document.getElementById('bs-amount').disabled = document.getElementById('bs-max').checked;
};
window.submitBotSend = async function submitBotSend() {
  const to = document.getElementById('bs-to').value.trim();
  const max = document.getElementById('bs-max').checked;
  const amountSol = Number(document.getElementById('bs-amount').value);
  const pass = document.getElementById('bs-pass').value;
  const s = window.__botWallet || {};
  if (!to) return botSendStatus('Paste the wallet address to send to.', 'bad');
  if (!max && !(amountSol > 0)) return botSendStatus('Enter an amount, or tick Max.', 'bad');
  if (!pass) return botSendStatus(s.sendNeedsPassword ? 'Enter your site password.' : 'Type SEND to confirm.', 'bad');
  const go = document.getElementById('bs-go');
  const body = { to, max, amountSol: max ? undefined : amountSol, password: pass, confirm: pass };
  go.disabled = true;
  try {
    if (!botSend.reviewed) {
      // step 1: test run on the network — nothing is sent
      botSendStatus('Checking the address and testing the transfer…', '');
      const r = await (await fetch('/api/real/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, dryRun: true }) })).json();
      if (!r.ok) return botSendStatus(esc(r.error || 'could not check the transfer'), 'bad');
      botSend.reviewed = { to, max, amountSol };
      botSendStatus(`You are sending <strong>${Number(r.sentSol).toFixed(6)} SOL</strong> to <span class="mono">${esc(to.slice(0, 6))}…${esc(to.slice(-6))}</span>. Network fee ≈ ${Number(r.feeSol || 0.000005).toFixed(6)} SOL.${r.keptReserve ? ' Some SOL stays to sell your open real positions.' : ''}<br>Check the address — a transfer can’t be undone.`, 'warn');
      go.textContent = 'Confirm send';
      return;
    }
    botSendStatus('Sending…', '');
    const r = await (await fetch('/api/real/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    if (r.ok) {
      botSendStatus(`Sent ${Number(r.sentSol).toFixed(6)} SOL. <a href="https://solscan.io/tx/${encodeURIComponent(r.signature)}" target="_blank" rel="noopener">View on Solscan ↗</a>`, 'good');
      showToast(`Sent ${Number(r.sentSol).toFixed(4)} SOL from the bot wallet`, 'good');
      go.textContent = 'Done';
      go.onclick = () => {
        go.onclick = submitBotSend;
        closeModal('modal-bot-send');
      };
      loadBotCardStatus(true);
    } else {
      botSend.reviewed = null;
      go.textContent = 'Review';
      botSendStatus(`${esc(r.error || 'send failed')}${r.signature ? ` <a href="https://solscan.io/tx/${encodeURIComponent(r.signature)}" target="_blank" rel="noopener">Solscan ↗</a>` : ''}`, 'bad');
    }
  } catch (err) {
    botSendStatus(`Could not reach the server: ${esc(err.message)}`, 'bad');
  } finally {
    go.disabled = false;
  }
};

window.botWalletSelfTest = async function botWalletSelfTest() {
  const btn = document.getElementById('bw-test-btn');
  if (btn) btn.disabled = true;
  showToast('Testing the bot wallet (nothing is sent)…', 'good');
  try {
    const r = await (await fetch('/api/real/test', { method: 'POST' })).json();
    showToast(r.ok ? (r.warning ? `Key works — ${r.warning}` : 'Self-test passed: key signs correctly and a swap simulation succeeded.') : `Self-test failed: ${r.error || 'unknown error'}`, r.ok ? 'good' : 'danger');
  } catch {
    showToast('Could not run the self-test.', 'danger');
  } finally {
    if (btn) btn.disabled = false;
    loadBotCardStatus(true);
  }
};

window.renderHistoryTable = function renderHistoryTable() {
  const tbody = document.getElementById('history-tbody');
  if (!tbody || !engineState) return;

  const filter = document.getElementById('history-filter')?.value || 'all';
  const rows = engineState.history.filter((h) => (filter === 'all' || h.status === filter) && matchesTraderFilter(h) && inDateFilter(h.timestamp));

  if (!rows.length) {
    tbody.__lastHtml = null;
    tbody.innerHTML = emptyRowHtml(
      8,
      `${filter === 'all' ? 'No activity' : `No ${filter} events`}${dateFilterState.preset !== 'all' ? ` ${dateFilterPhrase()}` : ' yet'}`,
      'Fills and skipped copies from the last 7 days show up here, with the reason for every skip.'
    );
    return;
  }

  setHtml(tbody, rows
    .map((h) => {
      const statusClass =
        h.status === 'filled' ? 'status-filled' : h.status === 'skipped' ? 'status-skipped' : 'status-failed';

      let metricHtml = '<span class="muted">—</span>';
      if (h.side === 'sell' && h.pnlUsd !== null) {
        metricHtml = `<span class="mono ${h.pnlUsd >= 0 ? 'pos-up' : 'pos-down'}">${signedUsd(h.pnlUsd)} <small>${signedPct(h.pnlPct)}</small></span>`;
      } else if (h.chaseGapPct !== null && h.chaseGapPct !== undefined) {
        metricHtml = `<span class="mono ${h.chaseGapPct > 25 ? 'pos-warn' : 'muted'}">${signedPct(h.chaseGapPct, 0)} vs leader</span>`;
      }

      const diag =
        h.status === 'skipped'
          ? `<span class="diag diag-warn">${esc(h.reason)}</span>`
          : h.explorerUrl
            ? `<a class="diag mono link" href="${esc(h.explorerUrl)}" target="_blank" rel="noopener">view tx ↗</a>`
            : `<span class="diag mono muted">paper fill</span>`;

      return `
        <tr>
          <td><span class="status-pill ${statusClass}">${h.status}</span></td>
          <td><span class="side side-${h.side}">${h.side}</span> <span class="muted">${h.cause}</span></td>
          <td>${chainBadgeHtml(h.chainId)}</td>
          <td class="mono">${tokenLinkHtml(h.symbol, h.tokenAddress)}</td>
          <td class="mono">${traderLinkHtml(h.traderHandle, h.traderWallet)}</td>
          <td class="mono num">${h.amountUsd > 0 ? formatUsd(h.amountUsd) : '<span class="muted">—</span>'}</td>
          <td class="num">${metricHtml}</td>
          <td>${diag}</td>
        </tr>
      `;
    })
    .join(''));
};

// ============================================================================
// Terminal Interactive Actions
// ============================================================================

window.sellPosition = async function sellPosition(posId, modeOrPct) {
  const pos = engineState?.positions?.find((p) => p.id === posId);
  const isReal = pos && pos.isPaper === false;
  const what = modeOrPct === 'initials' ? 'enough to recover your cost (initials)' : `${Number(modeOrPct)}%`;
  if (uiPrefs().confirmSells) {
    const ok = await confirmAction({ title: `Sell ${what} of $${pos?.symbol || 'this position'}?`, message: `Sold at the current market price (${isReal ? 'real SOL — sent on-chain' : 'paper trade'}). You can turn this question off in Settings → Security.`, confirmLabel: 'Sell', danger: true });
    if (!ok) return;
  }
  if (!window.__sellsInFlight) window.__sellsInFlight = new Set();
  if (window.__sellsInFlight.has(posId)) return showToast('This sell is still going through…', 'warn');
  window.__sellsInFlight.add(posId);
  if (isReal) showToast(`Selling ${what} of $${pos?.symbol || ''}… (a real sell takes a few seconds)`, 'good');
  const payload = modeOrPct === 'initials' ? { mode: 'initials' } : { sellPct: Number(modeOrPct) };
  try {
    const res = await fetch(`/api/positions/${posId}/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = { ok: false, error: `the server answered ${res.status} — it may be restarting, try again in a moment` };
    }
    if (!data.ok) showToast(`Sell failed: ${data.error || 'refused'}${/holds none of this token/i.test(data.error || '') ? ' — press “Close record” to fix the record' : ''}`, 'danger');
    else showToast(`Sold ${what} of $${pos?.symbol || ''}`, 'good');
    if (data.state) {
      engineState = data.state;
      renderTerminalAll();
    }
  } catch {
    showToast('Sell failed: could not reach the Odex server (it may be restarting after an update) — try again in a moment', 'danger');
  } finally {
    window.__sellsInFlight.delete(posId);
  }
};

window.closePositionRecord = async function closePositionRecord(posId) {
  const pos = engineState?.positions?.find((p) => p.id === posId);
  const ok = await confirmAction({ title: `Close the $${pos?.symbol || ''} record?`, message: 'Odex checks on-chain that the bot wallet no longer holds this coin, finds the transaction that took it out, and books what you really got back. Nothing is sold or sent.', confirmLabel: 'Check & close' });
  if (!ok) return;
  showToast('Checking the bot wallet on-chain…', 'good');
  try {
    const res = await fetch(`/api/positions/${posId}/close-record`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({ ok: false, error: `server answered ${res.status}` }));
    if (!data.ok) showToast(`Not closed: ${data.error || 'refused'}`, 'danger');
    else showToast(data.onchain ? `Closed. Real on-chain result for this coin: ${data.onchain.netSol >= 0 ? '+' : ''}${Number(data.onchain.netSol).toFixed(4)} SOL (${data.onchain.txCount} transactions) — the record now matches it.` : data.sale ? `Closed: the coins left for ${Number(data.sale.receivedSol).toFixed(4)} SOL — booked.` : 'Closed: no sale found on-chain, booked at $0.', 'good');
    if (data.state) {
      engineState = data.state;
      renderTerminalAll();
    }
  } catch {
    showToast('Could not reach the Odex server — try again in a moment', 'danger');
  }
};

window.sellAllPositions = async function sellAllPositions(panic) {
  const openCount = engineState?.positionsSummary?.openCount ?? 0;
  if (!openCount && !panic) {
    showToast('No open positions to sell', 'warn');
    return;
  }
  const ok = await confirmAction(
    panic
      ? {
          title: 'Panic sell everything?',
          message: `This pauses every follow on all chains and market-sells ${openCount} open position${openCount === 1 ? '' : 's'}. Copying stays paused until you resume it.`,
          confirmLabel: 'Pause all & sell',
          danger: true,
        }
      : {
          title: `Sell ${openCount} position${openCount === 1 ? '' : 's'}?`,
          message: 'All open positions are sold at market. Your follows keep copying new buys.',
          confirmLabel: 'Sell all',
          danger: true,
        }
  );
  if (!ok) return;
  const res = await fetch('/api/positions/sell-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chainId: 'all', panic }),
  });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
    const failed = (data.results || []).filter((r) => r && !r.ok);
    const why = failed.length ? ` ${failed.length} failed: ${[...new Set(failed.map((r) => r.error || 'refused'))].slice(0, 2).join(' · ')}` : '';
    showToast(
      panic
        ? `Panic sell: paused all follows, sold ${data.soldCount} position${data.soldCount === 1 ? '' : 's'}.${why}`
        : `Sold ${data.soldCount} position${data.soldCount === 1 ? '' : 's'}.${why}`,
      failed.length ? 'danger' : panic ? 'warn' : 'good'
    );
  }
};

window.armOrderForPosition = async function armOrderForPosition(posId) {
  const rawType = document.getElementById(`lim-type-${posId}`).value;
  const val = Number(document.getElementById(`lim-val-${posId}`).value || 50);
  const sizePct = Number(document.getElementById(`lim-size-${posId}`).value || 50);

  let type = rawType;
  let triggerType = 'pct';
  if (rawType === 'take-profit-mc') {
    type = 'take-profit';
    triggerType = 'mc';
  }

  const res = await fetch(`/api/positions/${posId}/limit-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, triggerType, triggerValue: val, sizePct }),
  });
  const data = await res.json();
  if (!data.ok) {
    showToast(data.error || 'Could not arm limit order', 'danger');
    return;
  }
  engineState = data.state;
  renderTerminalAll();
  showToast('Armed limit order on position', 'good');
};

window.cancelArmedOrder = async function cancelArmedOrder(posId, orderId) {
  const res = await fetch(`/api/positions/${posId}/limit-orders/${orderId}`, {
    method: 'DELETE',
  });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
  }
};

// ============================================================================
// Follows & 5-Rule Auto-Exit Modal
// ============================================================================

const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

window.onCopyWalletInput = function onCopyWalletInput() {
  lastWalletReport = null;
  const card = document.getElementById('copy-wallet-report');
  if (card) card.style.display = 'none';
};

window.onCopySizingType = function onCopySizingType() {
  const t = document.getElementById('copy-sizing-type').value;
  const label = document.getElementById('copy-sizing-label');
  const amt = document.getElementById('copy-sizing-amount');
  if (t === 'percent') {
    label.textContent = '% of balance';
    if (Number(amt.value) > 100 || !amt.value) amt.value = 5;
  } else if (t === 'proportional') {
    label.textContent = 'Cap per trade ($)';
  } else {
    label.textContent = 'Amount ($)';
  }
};

function walletReportHtml(r) {
  const short = `${r.address.slice(0, 6)}…${r.address.slice(-6)}`;
  const ignoredList = Object.entries(r.ignored || {})
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `<li>${n}× ${esc(why)}</li>`)
    .join('');
  if (r.verdict === 'busy') {
    return `
    <div class="wr-head wr-good">
      <span class="wr-dot"></span>
      <div class="wr-text"><strong>Very busy wallet: copied by watching its balances</strong><span>About ${Number(r.txPerMinute || 0).toLocaleString()} transactions a minute mention this wallet (mostly other bots' failed trades), so its own trades are buried in its history. Odex Mirror tracks its token and SOL balances every poll instead: a token going up while SOL goes down is copied as a buy, and the reverse as a sell. It holds ${Number(r.solBalance || 0).toFixed(2)} SOL and ${r.tokensHeld} token${r.tokensHeld === 1 ? '' : 's'} right now.</span></div>
      <a class="wr-link mono" href="https://solscan.io/account/${encodeURIComponent(r.address)}" target="_blank" rel="noopener" title="${esc(r.address)}">${short}</a>
    </div>`;
  }
  const tone = r.verdict === 'copyable' ? 'good' : 'warn';
  const headline =
    r.verdict === 'copyable'
      ? `${r.swapCount} copyable trade${r.swapCount === 1 ? '' : 's'} in the last ${r.checked} transactions`
      : r.verdict === 'inactive'
        ? 'No transactions found for this wallet'
        : `No buys or sells in the last ${r.checked} transactions`;
  const sub =
    r.verdict === 'copyable'
      ? `${r.buys} buy${r.buys === 1 ? '' : 's'} · ${r.sells} sell${r.sells === 1 ? '' : 's'}${r.lastSwapAt ? ` · last trade ${timeAgo(r.lastSwapAt)}` : ''}`
      : r.verdict === 'inactive'
        ? 'Check the address. A new or empty wallet has nothing to copy yet.'
        : 'This wallet may trade through an app or exchange account instead of swapping itself, so there may be nothing to copy. You can still follow it and copies start when it swaps.';
  const recent = (r.swaps || [])
    .slice(0, 4)
    .map((x) => `<span class="wr-chip ${x.side === 'buy' ? 'pos-up' : 'pos-down'}">${x.side} ${x.quoteAmount.toFixed(x.quoteSymbol === 'SOL' ? 2 : 0)} ${esc(x.quoteSymbol)}</span>`)
    .join('');
  return `
    <div class="wr-head wr-${tone}">
      <span class="wr-dot"></span>
      <div class="wr-text"><strong>${headline}</strong><span>${sub}</span></div>
      <a class="wr-link mono" href="https://solscan.io/account/${encodeURIComponent(r.address)}" target="_blank" rel="noopener" title="${esc(r.address)}">${short}</a>
    </div>
    ${recent ? `<div class="wr-chips">${recent}</div>` : ''}
    ${ignoredList ? `<details class="wr-ignored"><summary>Ignored transactions</summary><ul>${ignoredList}</ul></details>` : ''}`;
}

window.checkCopyWallet = async function checkCopyWallet() {
  const address = document.getElementById('copy-wallet-input').value.trim();
  const card = document.getElementById('copy-wallet-report');
  const btn = document.getElementById('copy-check-btn');
  card.style.display = 'block';
  if (!SOL_ADDRESS_RE.test(address)) {
    lastWalletReport = null;
    card.className = 'lookup-card is-error';
    card.textContent = 'That is not a valid Solana wallet address.';
    return null;
  }
  card.className = 'lookup-card is-loading';
  card.textContent = 'Reading this wallet\'s recent transactions…';
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/traders/check?address=${encodeURIComponent(address)}`);
    const data = res.status === 404 ? { ok: false, error: 'Restart the server to enable wallet checks.' } : await res.json();
    if (!data.ok) {
      card.className = 'lookup-card is-error';
      card.textContent = data.error || 'Could not read this wallet.';
      lastWalletReport = null;
      return null;
    }
    lastWalletReport = data;
    card.className = 'lookup-card wallet-report';
    card.innerHTML = walletReportHtml(data);
    return data;
  } catch (err) {
    card.className = 'lookup-card is-error';
    card.textContent = `Could not read this wallet: ${err.message}`;
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.submitCreateFollow = async function submitCreateFollow() {
  const address = document.getElementById('copy-wallet-input').value.trim();
  if (!SOL_ADDRESS_RE.test(address)) {
    showToast('Paste the trader\'s Solana wallet address first.', 'danger');
    document.getElementById('copy-wallet-input').focus();
    return;
  }
  const val = (id) => document.getElementById(id).value;
  const payload = {
    traderWallet: address,
    name: val('copy-name').trim(),
    mode: val('copy-mode'),
    sizing: { type: val('copy-sizing-type'), amount: Number(val('copy-sizing-amount')) },
    tpPct: val('copy-tp'),
    slPct: val('copy-sl'),
    minTradeUsd: val('copy-min-trade'),
    maxOpenPositions: val('copy-max-open'),
    maxAtRiskUsd: val('copy-max-risk'),
  };
  const res = await fetch('/api/follows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    showToast(data.error || 'Could not start copying', 'danger');
    return;
  }
  engineState = data.state;
  renderTerminalAll();
  closeModal('modal-copy');
  document.getElementById('copy-wallet-input').value = '';
  document.getElementById('copy-name').value = '';
  onCopyWalletInput();
  switchMainView('terminal');
  switchTermTab('follows');
  const f = data.created[0];
  const paperOn = engineState?.settings?.paperTrading;
  showToast(
    paperOn
      ? `Copying ${f.name}. Their next on-chain buy or sell is copied with these settings.`
      : `Following ${f.name}. Turn on Paper Trading to copy their trades.`,
    paperOn ? 'good' : 'warn'
  );
};

window.toggleFollowStatus = async function toggleFollowStatus(followId, status) {
  const res = await fetch(`/api/follows/${followId}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
  }
};

window.pauseAllFollows = async function pauseAllFollows() {
  const res = await fetch('/api/follows/pause-all', { method: 'POST' });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
    showToast('Paused new buys on all follows. Open positions continue selling normally.', 'warn');
  }
};

window.resumeAllFollows = async function resumeAllFollows() {
  const res = await fetch('/api/follows/resume-all', { method: 'POST' });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
    showToast('Resumed all follows.', 'good');
  }
};

window.removeFollow = async function removeFollow(followId) {
  const res = await fetch(`/api/follows/${followId}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
    showToast('Removed follow. Existing positions keep their TP/SL and Exit Rules.', 'warn');
  }
};

window.openExitRulesModal = function openExitRulesModal(followId) {
  const f = engineState.follows.find((x) => x.id === followId);
  if (!f) return;

  document.getElementById('edit-follow-id').value = f.id;
  document.getElementById('exit-modal-title').textContent = `Exit rules · @${f.handle}`;
  document.getElementById('edit-follow-mode').value = f.mode;
  document.getElementById('edit-follow-size').value = f.sizing.amount;
  document.getElementById('edit-follow-tp').value = f.tpPct ?? '';
  document.getElementById('edit-follow-sl').value = f.slPct ?? '';

  const r = f.exitRules;
  document.getElementById('rule-ti-at').value = r.takeInitials.takeAtPct;
  document.getElementById('rule-ti-size').value = r.takeInitials.sellSizePct;
  document.getElementById('rule-ti-on').checked = Boolean(r.takeInitials.enabled);

  document.getElementById('rule-mt-trail').value = r.moonbagTrail.trailPct;
  document.getElementById('rule-mt-arms').value = r.moonbagTrail.armsAtPct;
  document.getElementById('rule-mt-on').checked = Boolean(r.moonbagTrail.enabled);

  document.getElementById('rule-fl-open').value = r.floor.openingFloorPct;
  document.getElementById('rule-fl-sec').value = r.floor.tightensAfterSec;
  document.getElementById('rule-fl-tight').value = r.floor.tightFloorPct;
  document.getElementById('rule-fl-on').checked = Boolean(r.floor.enabled);

  document.getElementById('rule-wc-sec').value = r.waveCut.afterSec;
  document.getElementById('rule-wc-peak').value = r.waveCut.needsPeakPct;
  document.getElementById('rule-wc-on').checked = Boolean(r.waveCut.enabled);

  document.getElementById('rule-tc-sec').value = r.hardTimeCap.timeCapSec;
  document.getElementById('rule-tc-on').checked = Boolean(r.hardTimeCap.enabled);

  document.getElementById('modal-exit-rules').classList.add('open');
};

window.resetExitRuleNumbersToSuggested = function resetExitRuleNumbersToSuggested() {
  document.getElementById('rule-ti-at').value = 25;
  document.getElementById('rule-ti-size').value = 75;
  document.getElementById('rule-mt-trail').value = 25;
  document.getElementById('rule-mt-arms').value = 10;
  document.getElementById('rule-fl-open').value = 45;
  document.getElementById('rule-fl-sec').value = 50;
  document.getElementById('rule-fl-tight').value = 20;
  document.getElementById('rule-wc-sec').value = 90;
  document.getElementById('rule-wc-peak').value = 5;
  document.getElementById('rule-tc-sec').value = 300;
  showToast('Reset exit rule numbers to suggested defaults (on/off switches unchanged).', 'good');
};

window.saveFollowExitRules = async function saveFollowExitRules() {
  const followId = document.getElementById('edit-follow-id').value;
  const payload = {
    mode: document.getElementById('edit-follow-mode').value,
    sizing: { amount: Number(document.getElementById('edit-follow-size').value || 50) },
    tpPct: document.getElementById('edit-follow-tp').value,
    slPct: document.getElementById('edit-follow-sl').value,
    exitRules: {
      takeInitials: {
        enabled: document.getElementById('rule-ti-on').checked,
        takeAtPct: Number(document.getElementById('rule-ti-at').value),
        sellSizePct: Number(document.getElementById('rule-ti-size').value),
      },
      moonbagTrail: {
        enabled: document.getElementById('rule-mt-on').checked,
        trailPct: Number(document.getElementById('rule-mt-trail').value),
        armsAtPct: Number(document.getElementById('rule-mt-arms').value),
      },
      floor: {
        enabled: document.getElementById('rule-fl-on').checked,
        openingFloorPct: Number(document.getElementById('rule-fl-open').value),
        tightensAfterSec: Number(document.getElementById('rule-fl-sec').value),
        tightFloorPct: Number(document.getElementById('rule-fl-tight').value),
      },
      waveCut: {
        enabled: document.getElementById('rule-wc-on').checked,
        afterSec: Number(document.getElementById('rule-wc-sec').value),
        needsPeakPct: Number(document.getElementById('rule-wc-peak').value),
      },
      hardTimeCap: {
        enabled: document.getElementById('rule-tc-on').checked,
        timeCapSec: Number(document.getElementById('rule-tc-sec').value),
      },
    },
  };

  const res = await fetch(`/api/follows/${followId}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
    closeModal('modal-exit-rules');
    showToast('Updated follow & 5-rule Auto-Exit engine settings.', 'good');
  }
};

// ============================================================================
// Settings, Filters, Risk Limits & Wallets Actions
// ============================================================================

function populateSettingsInputs() {
  if (!engineState) return;
  const s = engineState.settings;
  document.getElementById('set-buy-slip-sol').value = s.buySlippagePct.solana ?? 15;
  document.getElementById('set-buy-slip-evm').value = s.buySlippagePct.evm ?? '';
  document.getElementById('set-sell-slip').value = s.sellSlippagePct ?? '';
  document.getElementById('set-max-chase').value = s.maxChasePct ?? 25;
  document.getElementById('set-priority-mode').value = s.priorityFee.mode || 'normal';
  document.getElementById('set-retry-buys').value = String(Boolean(s.retryBuys));
  document.getElementById('set-trading-asset').value = s.tradingAsset.solana || 'stable';
  const routeEl = document.getElementById('set-swap-route');
  if (routeEl) routeEl.value = s.swapRoute === 'direct' ? 'direct' : 'jupiter';
  const fastEl = document.getElementById('set-fast-detect');
  if (fastEl) fastEl.value = s.fastDetect === true ? 'true' : 'false';
  const topUpsEl = document.getElementById('set-copy-topups');
  if (topUpsEl) topUpsEl.value = s.copyTopUps ? 'true' : 'false';
  const scs = { autoPause: true, minTrades: 10, maxSlipPct: 20, maxLagSec: 10, ...(s.scorecard || {}) };
  const scEl = (id) => document.getElementById(id);
  if (scEl('set-sc-autopause')) {
    scEl('set-sc-autopause').value = scs.autoPause ? 'true' : 'false';
    scEl('set-sc-min-trades').value = scs.minTrades;
    scEl('set-sc-max-slip').value = scs.maxSlipPct;
    scEl('set-sc-max-lag').value = scs.maxLagSec;
  }

  document.getElementById('set-min-mc').value = s.filters.minMarketCapUsd ?? '';
  document.getElementById('set-max-mc').value = s.filters.maxMarketCapUsd ?? '';
  document.getElementById('set-min-buy-size').value = s.filters.minTraderBuyNative ?? '';
  document.getElementById('set-max-buy-size').value = s.filters.maxTraderBuyNative ?? '';
  document.getElementById('set-stage').value = s.filters.stage || 'any';
  document.getElementById('set-pump-only').value = String(Boolean(s.filters.pumpOnly));

  document.getElementById('set-safe-risky').value = String(Boolean(s.safety.blockRiskyCoins));
  document.getElementById('set-safe-mint').value = String(Boolean(s.safety.blockMintableSupply));
  document.getElementById('set-safe-strict').value = String(Boolean(s.safety.strictNonPump));

  document.getElementById('set-risk-daily').value = s.risk.dailyLossLimitUsd ?? '';
  document.getElementById('set-risk-streak').value = s.risk.streakLimit ?? '';
  document.getElementById('set-risk-exposure').value = s.risk.exposureLimitUsd ?? '';
}

window.saveExecutionSettings = async function saveExecutionSettings() {
  const cdVal = document.getElementById('set-cooldown-mode').value;
  const cooldown =
    cdVal === 'off'
      ? { enabled: false, mode: 'duration', durationSec: 600 }
      : cdVal === 'holding'
        ? { enabled: true, mode: 'while_holding', durationSec: 600 }
        : cdVal === '60s'
          ? { enabled: true, mode: 'duration', durationSec: 60 }
          : { enabled: true, mode: 'duration', durationSec: 600 };

  const assetMode = document.getElementById('set-trading-asset').value;
  const evmSlipRaw = document.getElementById('set-buy-slip-evm').value;

  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      buySlippagePct: {
        solana: Number(document.getElementById('set-buy-slip-sol').value || 15),
        evm: evmSlipRaw === '' ? null : Number(evmSlipRaw),
      },
      sellSlippagePct: document.getElementById('set-sell-slip').value,
      maxChasePct: Number(document.getElementById('set-max-chase').value || 25),
      priorityFee: { mode: document.getElementById('set-priority-mode').value },
      cooldown,
      retryBuys: document.getElementById('set-retry-buys').value === 'true',
      tradingAsset: { solana: assetMode, bsc: assetMode, robinhood: assetMode, arc: 'stable' },
      copyTopUps: document.getElementById('set-copy-topups')?.value === 'true',
      swapRoute: document.getElementById('set-swap-route')?.value === 'direct' ? 'direct' : 'jupiter',
      fastDetect: document.getElementById('set-fast-detect')?.value === 'true',
      ...(document.getElementById('set-sc-autopause')
        ? {
            scorecard: {
              autoPause: document.getElementById('set-sc-autopause').value === 'true',
              minTrades: Number(document.getElementById('set-sc-min-trades').value || 10),
              maxSlipPct: Number(document.getElementById('set-sc-max-slip').value || 20),
              maxLagSec: Number(document.getElementById('set-sc-max-lag').value || 10),
            },
          }
        : {}),
    }),
  });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
    showToast('Saved execution, slippage, and Max Chase settings.', 'good');
  }
};

window.saveFilterAndRiskSettings = async function saveFilterAndRiskSettings() {
  const minMc = document.getElementById('set-min-mc').value;
  const maxMc = document.getElementById('set-max-mc').value;
  if (minMc !== '' && maxMc !== '' && Number(minMc) >= Number(maxMc)) {
    showToast('Minimum Market Cap must be strictly below Maximum Market Cap.', 'danger');
    return;
  }

  const minBuy = document.getElementById('set-min-buy-size').value;
  const maxBuy = document.getElementById('set-max-buy-size').value;
  if (minBuy !== '' && maxBuy !== '' && Number(minBuy) > Number(maxBuy)) {
    showToast('Minimum Trader Buy Size cannot exceed Maximum Trader Buy Size.', 'danger');
    return;
  }

  const daily = document.getElementById('set-risk-daily').value;
  const streak = document.getElementById('set-risk-streak').value;
  const exposure = document.getElementById('set-risk-exposure').value;

  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filters: {
        minMarketCapUsd: minMc === '' ? null : Number(minMc),
        maxMarketCapUsd: maxMc === '' ? null : Number(maxMc),
        minTraderBuyNative: minBuy === '' ? null : Number(minBuy),
        maxTraderBuyNative: maxBuy === '' ? null : Number(maxBuy),
        stage: document.getElementById('set-stage').value,
        pumpOnly: document.getElementById('set-pump-only').value === 'true',
      },
      safety: {
        blockRiskyCoins: document.getElementById('set-safe-risky').value === 'true',
        blockMintableSupply: document.getElementById('set-safe-mint').value === 'true',
        strictNonPump: document.getElementById('set-safe-strict').value === 'true',
      },
      risk: {
        dailyLossLimitUsd: daily === '' ? null : Number(daily),
        dailyLossTriggered: false,
        streakLimit: streak === '' ? null : Number(streak),
        exposureLimitUsd: exposure === '' ? null : Number(exposure),
      },
    }),
  });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
    showToast('Saved entry filters, token safety switches & risk circuit breakers.', 'good');
  }
};

window.toggleAccountPumpOnly = async function toggleAccountPumpOnly() {
  const next = !engineState.settings.filters.pumpOnly;
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: { pumpOnly: next } }),
  });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
    populateSettingsInputs();
    showToast(`Account-wide Pump-Only / Launchpad-Only switched ${next ? 'ON' : 'OFF'}.`, 'good');
  }
};

window.resetAllSettings = async function resetAllSettings() {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
    populateSettingsInputs();
    showToast('Reset execution settings, filters, safety switches, and risk limits to defaults.', 'good');
  }
};

window.createNewWallet = async function createNewWallet() {
  const res = await fetch('/api/wallets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create' }),
  });
  const data = await res.json();
  if (!data.ok) {
    showToast(data.error, 'danger');
    return;
  }
  engineState = data.state;
  renderTerminalAll();
  showToast('Created new multi-chain Privy wallet.', 'good');
};

window.switchActiveWallet = async function switchActiveWallet(walletId) {
  const res = await fetch('/api/wallets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'switch', walletId }),
  });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
    showToast('Switched active trading wallet.', 'good');
  }
};


async function walletAction(body) {
  const res = await fetch('/api/wallets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ ok: false, error: 'No answer from the server' }));
  if (!data.ok) {
    showToast(data.error || 'That did not work', 'danger');
    return null;
  }
  engineState = data.state;
  renderTerminalAll();
  renderBalancesEverywhere?.();
  return data;
}

window.setDefaultWallet = async function setDefaultWallet(walletId) {
  const w = engineState.wallets.find((x) => x.id === walletId);
  if (await walletAction({ action: 'set-default', walletId })) showToast(`${w?.name === 'Main' ? 'Solana Wallet' : w?.name || 'Wallet'} is now the default wallet.`, 'good');
};

window.deleteWallet = async function deleteWallet(walletId) {
  const w = engineState.wallets.find((x) => x.id === walletId);
  if (!w) return;
  const name = w.name === 'Main' ? 'Solana Wallet' : w.name;
  const def = engineState.wallets.find((x) => x.isDefault && !x.archived);
  const moving = (engineState.follows || []).filter((f) => f.walletId === walletId).length;
  const ok = await confirmAction({
    title: `Delete ${name}?`,
    message: `It is removed from Odex Mirror together with its paper balance. Your trade history stays.${moving ? ` Its ${moving} copytrade${moving === 1 ? '' : 's'} move to ${def ? (def.name === 'Main' ? 'Solana Wallet' : def.name) : 'the default wallet'}.` : ''} Nothing on the blockchain is touched.`,
    confirmLabel: 'Delete wallet',
  });
  if (!ok) return;
  if (await walletAction({ action: 'delete', walletId })) showToast(`${name} deleted.`, 'good');
};

// ---- Paper balance: set an exact amount in USD or SOL ----
let paperEdit = { walletId: null, unit: 'usd' };
const PAPER_CHIPS = { usd: [100, 500, 1000, 5000, 10000], sol: [0.5, 1, 5, 10, 50] };

window.openPaperBalance = function openPaperBalance(walletId) {
  const w = engineState.wallets.find((x) => x.id === walletId) || engineState.wallets.find((x) => x.active);
  if (!w) return;
  paperEdit = { walletId: w.id, unit: paperEdit.unit || 'usd' };
  document.getElementById('pb-wallet').textContent = `${w.name === 'Main' ? 'Solana Wallet' : w.name} · now ${formatUsd(Number(w.paperBalanceUsd ?? 10000))}`;
  setPaperUnit(paperEdit.unit, true);
  document.getElementById('modal-paper-balance').classList.add('open');
  setTimeout(() => document.getElementById('pb-amount')?.focus(), 40);
};

window.setPaperUnit = function setPaperUnit(unit, fill = false) {
  const px = Number(engineState?.chains?.solana?.nativePriceUsd) || 0;
  const input = document.getElementById('pb-amount');
  const prevUnit = paperEdit.unit;
  paperEdit.unit = unit === 'sol' && px > 0 ? 'sol' : 'usd';
  document.querySelectorAll('#pb-unit button').forEach((b) => b.classList.toggle('active', b.dataset.unit === paperEdit.unit));
  document.getElementById('pb-prefix').textContent = paperEdit.unit === 'sol' ? 'SOL' : '$';
  const w = engineState.wallets.find((x) => x.id === paperEdit.walletId);
  const cur = Number(w?.paperBalanceUsd ?? 10000);
  if (fill) input.value = paperEdit.unit === 'sol' ? fmtSol(cur / px) : String(cur);
  else if (prevUnit !== paperEdit.unit && input.value) {
    const v = Number(input.value);
    if (Number.isFinite(v)) input.value = paperEdit.unit === 'sol' ? fmtSol(v / px) : (v * px).toFixed(2);
  }
  document.getElementById('pb-chips').innerHTML = PAPER_CHIPS[paperEdit.unit]
    .map((v) => `<button type="button" class="btn btn-sm" onclick="document.getElementById('pb-amount').value='${v}'; paperPreview()">${paperEdit.unit === 'sol' ? `${v} SOL` : formatUsd(v).replace('.00', '')}</button>`)
    .join('');
  paperPreview();
};

window.paperPreview = function paperPreview() {
  const px = Number(engineState?.chains?.solana?.nativePriceUsd) || 0;
  const v = Number(document.getElementById('pb-amount').value);
  const out = document.getElementById('pb-preview');
  if (!Number.isFinite(v) || v < 0 || document.getElementById('pb-amount').value === '') {
    out.textContent = 'Enter an amount';
    return;
  }
  out.textContent = paperEdit.unit === 'sol' ? `= ${formatUsd(v * px)} at $${px.toFixed(2)}/SOL` : px > 0 ? `≈ ${fmtSol(v / px)} SOL at $${px.toFixed(2)}/SOL` : '';
};

window.savePaperBalance = async function savePaperBalance() {
  const raw = document.getElementById('pb-amount').value;
  const amount = Number(raw);
  if (raw === '' || !Number.isFinite(amount) || amount < 0) {
    showToast('Enter an amount of 0 or more', 'warn');
    return;
  }
  const data = await walletAction({ action: 'set-paper-balance', walletId: paperEdit.walletId, amount, unit: paperEdit.unit });
  if (!data) return;
  closeModal('modal-paper-balance');
  const w = data.state.wallets.find((x) => x.id === paperEdit.walletId);
  showToast(`Paper balance set to ${formatUsd(Number(w?.paperBalanceUsd ?? 0))} (paper money, not real funds).`, 'good');
};

window.copyWalletAddress = async function copyWalletAddress(addr) {
  try {
    await navigator.clipboard.writeText(addr);
    showToast('Wallet address copied.', 'good');
  } catch {
    showToast(addr, 'info');
  }
};







// ============================================================================
// Shareable Canvas PnL Card Generator (/positions -> PnL cards)
// ============================================================================

// Images used on the card: same-origin logo, CORS-enabled token / trader pictures (others are
// skipped so the canvas stays exportable)
const pnlImgCache = new Map();
function loadCardImage(url) {
  if (!url) return Promise.resolve(null);
  if (pnlImgCache.has(url)) return pnlImgCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    if (/^https?:/i.test(url)) img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    const t = setTimeout(() => resolve(null), 4000);
    img.onload = () => {
      clearTimeout(t);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(t);
      resolve(null);
    };
    img.src = url;
  });
  pnlImgCache.set(url, p);
  return p;
}

const trimCache = new WeakMap();
/** Bounding box of the non-transparent pixels of an image (same-origin images only). */
function trimmedBounds(img) {
  if (trimCache.has(img)) return trimCache.get(img);
  const full = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const { data, width, height } = x.getImageData(0, 0, c.width, c.height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let xx = 0; xx < width; xx++) {
        if (data[(y * width + xx) * 4 + 3] > 8) {
          if (xx < minX) minX = xx;
          if (xx > maxX) maxX = xx;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const out = maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : full;
    trimCache.set(img, out);
    return out;
  } catch {
    return full;
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

let pnlCardPos = null;

window.openPnlCard = function openPnlCard(posId, closed = false) {
  let pos = engineState?.positions.find((p) => p.id === posId);
  if (!pos && closed) {
    const c = (engineState?.closedPositions || []).find((p) => p.id === posId);
    if (c) pos = { ...c, unrealizedPnlPct: c.pnlPct, unrealizedPnlUsd: c.pnlUsd, currentMarketCapUsd: null, isClosed: true };
  }
  if (!pos) return;
  pnlCardPos = pos;
  const canvas = document.getElementById('pnl-canvas');
  canvas.classList.remove('is-ready'); // hidden until fully drawn: no flash of the previous card
  document.getElementById('modal-pnl-card').classList.add('open');
  const seq = (pnlDrawSeq += 1);
  requestAnimationFrame(async () => {
    // preview drawn at the screen's exact pixel size, so the browser never resamples (no shimmer)
    const cssW = canvas.clientWidth || 760; // layout width (ignores the opening zoom animation)
    const S = Math.max(0.3, (cssW * (window.devicePixelRatio || 1)) / 1200); // 1 canvas px = 1 screen px
    const off = document.createElement('canvas');
    await drawPnlCard(pos, off, S);
    if (seq !== pnlDrawSeq) return; // a newer card was opened meanwhile
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
    canvas.classList.add('is-ready');
  });
};
let pnlDrawSeq = 0;

/** Full-size (2400×1350) PNG of the open card, for copy / download. */
async function pnlCardBlob() {
  const off = document.createElement('canvas');
  await drawPnlCard(pnlCardPos, off, 2);
  return new Promise((r) => off.toBlob(r, 'image/png'));
}

// Small seeded random so a token always gets the same artwork
function seededRand(seedStr) {
  let h = 2166136261;
  for (const c of String(seedStr)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Original artwork for the right side: glowing slanted prisms + electric streaks. */
function drawCardArt(ctx, x0, y0, w, h, seed, up) {
  const rnd = seededRand(seed);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  const base = ctx.createLinearGradient(x0, y0, x0 + w, y0 + h);
  base.addColorStop(0, '#0a0c1c');
  base.addColorStop(1, '#05060d');
  ctx.fillStyle = base;
  ctx.fillRect(x0, y0, w, h);
  let gl = ctx.createRadialGradient(x0 + w * 0.6, y0 + h * 0.45, 10, x0 + w * 0.6, y0 + h * 0.45, w * 0.8);
  gl.addColorStop(0, 'rgba(99,102,241,0.35)');
  gl.addColorStop(1, 'rgba(99,102,241,0)');
  ctx.fillStyle = gl;
  ctx.fillRect(x0, y0, w, h);
  // three big slanted prisms (a nod to the Solana mark), lit from the left
  const cx = x0 + w * 0.55;
  const tilt = -0.32;
  const baseM = ctx.getTransform();
  ctx.translate(cx, y0 + h * 0.5);
  ctx.rotate(tilt);
  [[-190, 1], [-40, -1], [110, 1]].forEach(([yy, dir], k) => {
    const bw = 330;
    const bh = 92;
    const off = dir > 0 ? 46 : -46;
    const face = ctx.createLinearGradient(-bw / 2, yy, bw / 2, yy + bh);
    face.addColorStop(0, `rgba(${k === 1 ? '124,92,246' : '79,70,229'},0.85)`);
    face.addColorStop(0.5, 'rgba(30,27,75,0.95)');
    face.addColorStop(1, 'rgba(8,9,20,1)');
    ctx.beginPath();
    ctx.moveTo(-bw / 2 + off, yy);
    ctx.lineTo(bw / 2 + off, yy);
    ctx.lineTo(bw / 2 - off, yy + bh);
    ctx.lineTo(-bw / 2 - off, yy + bh);
    ctx.closePath();
    ctx.fillStyle = face;
    ctx.fill();
    ctx.strokeStyle = 'rgba(165,180,252,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // top edge highlight
    ctx.beginPath();
    ctx.moveTo(-bw / 2 + off, yy);
    ctx.lineTo(bw / 2 + off, yy);
    ctx.strokeStyle = 'rgba(224,231,255,0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
  });
  ctx.setTransform(baseM);
  // electric streaks
  const streak = (sx, sy, len, ang) => {
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    let px = sx;
    let py = sy;
    const steps = 6 + Math.floor(rnd() * 5);
    for (let k = 0; k < steps; k++) {
      px += Math.cos(ang) * (len / steps) + (rnd() - 0.5) * 26;
      py += Math.sin(ang) * (len / steps) + (rnd() - 0.5) * 26;
      ctx.lineTo(px, py);
    }
    ctx.shadowColor = 'rgba(129,140,248,0.9)';
    ctx.shadowBlur = 22;
    ctx.strokeStyle = 'rgba(199,210,254,0.75)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  };
  // streaks stay clear of the logo (top-right) and point away from it
  for (let k = 0, tries = 0; k < 5 && tries < 40; tries++) {
    const sx = x0 + rnd() * w;
    const sy = y0 + 150 + rnd() * (h - 150);
    const ang = Math.PI * (0.15 + rnd() * 0.85); // heading down / sideways, never up into the logo
    if (sx > x0 + w - 360 && sy < y0 + 230) continue;
    streak(sx, sy, 80 + rnd() * 120, ang);
    k += 1;
  }
  // accent wash in the result colour at the bottom
  gl = ctx.createLinearGradient(x0, y0 + h, x0, y0 + h * 0.55);
  gl.addColorStop(0, up ? 'rgba(34,229,139,0.18)' : 'rgba(255,84,112,0.18)');
  gl.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gl;
  ctx.fillRect(x0, y0, w, h);
  // fade into the left panel
  gl = ctx.createLinearGradient(x0, 0, x0 + 220, 0);
  gl.addColorStop(0, 'rgba(7,8,13,1)');
  gl.addColorStop(1, 'rgba(7,8,13,0)');
  ctx.fillStyle = gl;
  ctx.fillRect(x0, y0, 220, h);
  ctx.restore();
}

async function drawPnlCard(pos, canvas, S = 2) {
  const W = 1200;
  const H = 675;
  canvas.width = Math.round(W * S);
  canvas.height = Math.round(H * S);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  if ('textRendering' in ctx) ctx.textRendering = 'optimizeLegibility';
  try {
    await document.fonts?.load('400 40px Aeonik');
    await document.fonts?.load('400 40px Geist');
  } catch {
    // system font fallback
  }
  // clean geometric face like the reference card: Aeonik, light weights
  const F = (w, px) => `${w} ${px}px Aeonik, Geist, ui-sans-serif, system-ui, sans-serif`;
  // Aeonik ships one weight: thicken strokes with an outline in the text colour for a real-looking bold
  const heavy = (text, x, y, weight) => {
    ctx.fillText(text, x, y);
    if (!weight) return;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineJoin = 'round';
    ctx.lineWidth = weight;
    ctx.strokeText(text, x, y);
    ctx.restore();
  };
  const pct = Number(pos.unrealizedPnlPct) || 0;
  const pnlUsd = Number(pos.isClosed ? pos.pnlUsd : pos.unrealizedPnlUsd) || 0;
  const up = pnlUsd >= 0;
  const green = '#2ee6a0';
  const red = '#ff4d7a';
  const accent = up ? green : red;
  const solPx = Number(engineState?.chains?.solana?.nativePriceUsd) || 0;

  // card shape
  roundRectPath(ctx, 0, 0, W, H, 26);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#07080d';
  ctx.fillRect(0, 0, W, H);
  drawCardArt(ctx, 610, 0, W - 610, H, `${pos.tokenAddress || pos.symbol}`, up);
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.restore();
  roundRectPath(ctx, 1, 1, W - 2, H - 2, 25);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 2;
  ctx.stroke();

  const PAD = 60;
  // top-right: odex mirror logo
  const logo = await loadCardImage('/logo.png');
  if (logo) {
    // trim the transparent margin around the artwork so the logo is drawn at its real size
    const b = trimmedBounds(logo);
    const lh = 34;
    const lw = (b.w / b.h) * lh;
    ctx.drawImage(logo, b.x, b.y, b.w, b.h, W - PAD - lw, 58, lw, lh);
  }

  // title: token
  ctx.fillStyle = '#ffffff';
  ctx.font = F(400, 56);
  let title = String(pos.symbol || '').replace(/^\$/, '').toUpperCase();
  while (ctx.measureText(title).width > 470 && title.length > 4) title = `${title.slice(0, -2)}…`;
  heavy(title, PAD, 120, 1.6);

  // result box: solid accent with dark text
  const boxText = `${up ? '+' : '-'}${formatUsd(Math.abs(pnlUsd))}`;
  ctx.font = F(500, 60);
  const COL = 470; // left column width: box and value column share it
  const bw = Math.max(COL, ctx.measureText(boxText).width + 56);
  ctx.fillStyle = accent;
  ctx.fillRect(PAD, 148, bw, 90);
  ctx.fillStyle = '#04120c';
  if (!up) ctx.fillStyle = '#1a0309';
  heavy(boxText, PAD + 26, 215, 2.6);

  // stats list
  const solVal = pos.pnlSol != null ? Number(pos.pnlSol) : solPx > 0 ? pnlUsd / solPx : null;
  const rows = [
    ['PnL', `${pct >= 0 ? '+' : ''}${pct.toFixed(Math.abs(pct) < 10 ? 2 : 1)}%${solVal != null ? `  ·  ${solVal >= 0 ? '+' : '−'}${fmtSol(Math.abs(solVal))} SOL` : ''}`, accent],
  ];
  if (pos.isClosed) {
    rows.push(['Bought', `${formatUsd(pos.boughtUsd)}${pos.boughtSol != null ? `  ·  ${fmtSol(pos.boughtSol)} SOL` : ''}`, green]);
    rows.push(['Sold', `${formatUsd(pos.soldUsd)}${pos.soldSol != null ? `  ·  ${fmtSol(pos.soldSol)} SOL` : ''}`, red]);
    rows.push(['Held', pos.closedAt ? durationShort(pos.closedAt - pos.openedAt) : '—', '#ffffff']);
  } else {
    rows.push(['Entry MC', formatMc(pos.entryMarketCapUsd), '#ffffff']);
    rows.push(['Now MC', pos.currentMarketCapUsd ? formatMc(pos.currentMarketCapUsd) : '—', '#ffffff']);
    rows.push(['Held', durationShort(Date.now() - (pos.openedAt || Date.now())), '#ffffff']);
  }
  rows.push(['Copied from', `@${String(pos.traderHandle || 'trader').replace(/^@/, '')}`, '#a5b4fc']);
  let ry = 300;
  const solMark = (x, y, size) => {
    // three slanted bars, Solana gradient
    const g2 = ctx.createLinearGradient(x, y + size, x + size * 1.25, y);
    g2.addColorStop(0, '#9945FF');
    g2.addColorStop(1, '#14F195');
    ctx.fillStyle = g2;
    const bh = size * 0.22;
    const sk = size * 0.2;
    [[0, 1], [0.39, -1], [0.78, 1]].forEach(([f, d]) => {
      const yy = y + f * size;
      ctx.beginPath();
      if (d > 0) {
        ctx.moveTo(x + sk, yy);
        ctx.lineTo(x + size * 1.25, yy);
        ctx.lineTo(x + size * 1.25 - sk, yy + bh);
        ctx.lineTo(x, yy + bh);
      } else {
        ctx.moveTo(x, yy);
        ctx.lineTo(x + size * 1.25 - sk, yy);
        ctx.lineTo(x + size * 1.25, yy + bh);
        ctx.lineTo(x + sk, yy + bh);
      }
      ctx.closePath();
      ctx.fill();
    });
  };
  const right = PAD + COL - 14;
  rows.forEach(([k, v, col]) => {
    ctx.fillStyle = '#e8eaf0';
    ctx.font = F(400, 26);
    ctx.textAlign = 'left';
    heavy(k, PAD + 14, ry, 0.7);
    ctx.font = F(400, 26);
    ctx.textAlign = 'right';
    let t = String(v);
    // "… · 1.23 SOL" values: the Solana logo stands in front of the number instead of the word
    const m = /^(.*?)\s*·\s*([+\-−]?[\d.,]+) SOL$/.exec(t);
    if (m) {
      ctx.fillStyle = col;
      heavy(m[2], right, ry, 0.9);
      const w2 = ctx.measureText(m[2]).width;
      solMark(right - w2 - 36, ry - 19, 22);
      ctx.fillStyle = col;
      heavy(m[1], right - w2 - 58, ry, 0.9);
    } else {
      while (ctx.measureText(t).width > COL - 200 && t.length > 4) t = `${t.slice(0, -2)}…`;
      ctx.fillStyle = col;
      heavy(t, right, ry, 0.9);
    }
    ctx.textAlign = 'left';
    ry += 42;
  });

  // tagline + footer
  ctx.fillStyle = '#ffffff';
  ctx.font = F(400, 44);
  const tagline = pos.isClosed ? (up ? (pct >= 50 ? 'What a trade!' : 'Nice copy!') : 'On to the next one.') : up ? 'Riding it up.' : 'Still in the game.';
  heavy(tagline, PAD, ry + 44, 1.4);
  ctx.fillStyle = '#9ca3b4';
  ctx.font = F(400, 18);
  const kind = pos.isPaper || engineState?.settings?.paperTrading ? 'Paper trade' : 'Copy trade';
  const when = new Date(pos.closedAt || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  ctx.fillText(`${kind} · ${when} · copied in real time with Odex Mirror`, PAD, H - 38);
}

window.copyPnlCard = async function copyPnlCard() {
  if (!pnlCardPos) return;
  try {
    // the clipboard item takes a promise so the browser keeps the click's permission while it renders
    const blob = pnlCardBlob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    showToast('PnL card copied: paste it anywhere', 'good');
  } catch {
    showToast('Copying images is not supported here: use Download PNG', 'warn');
  }
};

window.downloadPnlCard = async function downloadPnlCard() {
  if (!pnlCardPos) return;
  const blob = await pnlCardBlob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = `odex-mirror-${String(pnlCardPos?.symbol || 'pnl').replace(/[^a-z0-9]+/gi, '')}-${Date.now()}.png`;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

// ============================================================================
// Live Wallet Signals (signals only — real on-chain swaps, no trading)
// ============================================================================
let liveWatch = null;

// ---------------------------------------------------------------------------
// Real trading panel (Settings → Trading & risk)
// ---------------------------------------------------------------------------
function renderRealPanel(s) {
  const el = document.getElementById('real-trading-body');
  if (!el || !s) return;
  const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
  const sol = (n) => `${Number(n || 0).toFixed(4)} SOL`;
  let state;
  if (s.keyError) state = `<span class="real-state bad">Key problem</span> ${esc(s.keyError)}`;
  else if (!s.configured) state = '<span class="real-state off">Not set up</span> No bot wallet key — real trading is unavailable. Paper trading works as before.';
  else if (s.active) state = `<span class="real-state live">LIVE</span> Paper Trading is OFF: copies spend real SOL from this wallet.${s.solPriceLive ? '' : ' Waiting for the live SOL price before ordering.'}`;
  else state = '<span class="real-state ready">Ready</span> Wallet loaded. Real trading starts when you switch Paper Trading OFF.';
  const rows = [];
  if (s.address) rows.push(['Bot wallet', `<a href="https://solscan.io/account/${esc(s.address)}" target="_blank" rel="noopener" class="mono">${esc(short(s.address))}</a>`]);
  if (s.balance) rows.push(['Balance', `<span class="mono">${sol(s.balance.sol)} · ${Number(s.balance.usdc || 0).toFixed(2)} USDC</span>`]);
  if (s.caps) {
    rows.push(['Max per buy', `<span class="mono">${s.caps.maxSolPerTrade} SOL</span>`]);
    rows.push(['Max per 24 h', `<span class="mono">${s.caps.maxSolPerDay > 0 ? `${s.caps.maxSolPerDay} SOL` : 'no cap'}</span> <span class="real-muted">(spent ${sol(s.spent24hSol)})</span>`]);
    rows.push(['Kept for fees', `<span class="mono">${s.caps.reserveSol} SOL</span>`]);
  }
  if (s.lastError) rows.push(['Last problem', `<span class="real-err">${esc(s.lastError.error)}</span> <span class="real-muted">${new Date(s.lastError.at).toLocaleTimeString()}</span>`]);
  const trades = (s.trades || []).slice(0, 8).map((t) => `<li><span class="${t.ok ? 'real-ok' : t.ok === false ? 'real-err' : 'real-warn'}">${t.ok ? '✓' : t.ok === false ? '✗' : '?'}</span> ${esc(t.side)} $${esc(t.symbol || short(t.mint))}${t.usd ? ` · $${Number(t.usd).toFixed(2)}` : ''}${t.error ? ` · <span class="real-muted">${esc(t.error)}</span>` : ''} ${t.signature ? `<a href="https://solscan.io/tx/${esc(t.signature)}" target="_blank" rel="noopener">tx</a>` : ''} <span class="real-muted">${new Date(t.t).toLocaleString()}</span></li>`).join('');
  const setup = s.configured
    ? ''
    : `<div class="real-setup"><strong>Set up:</strong> create a new Phantom account just for the bot, export its private key, add <code>ODEX_TRADER_KEY=&lt;key&gt;</code> to <code>.env</code> and restart. Optional: <code>JUPITER_API_KEY</code>, <code>ODEX_REAL_MAX_SOL_PER_TRADE</code> (0.5), <code>ODEX_REAL_MAX_SOL_PER_DAY</code> (2). The key never leaves this computer's server.</div>`;
  el.innerHTML = `<p class="real-status">${state}</p>${rows.length ? `<div class="real-grid">${rows.map(([k, v]) => `<div class="real-k">${k}</div><div>${v}</div>`).join('')}</div>` : ''}${setup}${trades ? `<div class="form-section-label">Recent real orders</div><ul class="real-trades">${trades}</ul>` : ''}<div id="real-test-out"></div>`;
}

window.refreshRealPanel = async function refreshRealPanel() {
  try {
    renderRealPanel(await (await fetch('/api/real/status')).json());
  } catch {
    const el = document.getElementById('real-trading-body');
    if (el) el.innerHTML = '<p class="real-err">Could not load real-trading status.</p>';
  }
};

window.runRealSelfTest = async function runRealSelfTest() {
  const out = () => document.getElementById('real-test-out');
  if (out()) out().innerHTML = '<p class="real-muted">Testing (nothing is sent)…</p>';
  try {
    const r = await (await fetch('/api/real/test', { method: 'POST' })).json();
    const html = `<div class="real-test ${r.ok ? 'ok' : 'bad'}"><strong>${r.ok ? (r.warning ? 'Partly passed' : 'Test passed') : 'Test failed'}</strong>${r.warning ? ` — ${esc(r.warning)}` : ''}${r.error ? ` — ${esc(r.error)}` : ''}<ul>${(r.steps || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    if (out()) out().innerHTML = html;
  } catch (err) {
    if (out()) out().innerHTML = `<p class="real-err">Test could not run: ${esc(err.message)}</p>`;
  }
};

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---- Token logos (Alchemy) and trader wallet pictures (an NFT the wallet holds, via Alchemy) ----
const tokenImageCache = new Map(); // mint → https url | null
const walletAvatarCache = new Map(); // wallet → { imageUrl, name } | null
const imagePending = new Set();
let imageFetchTimer = null;

function needTokenImage(mint) {
  if (!mint || tokenImageCache.has(mint) || imagePending.has(`t:${mint}`)) return;
  imagePending.add(`t:${mint}`);
  scheduleImageFetch();
}
function needWalletAvatar(wallet) {
  if (!wallet || walletAvatarCache.has(wallet) || imagePending.has(`w:${wallet}`)) return;
  imagePending.add(`w:${wallet}`);
  scheduleImageFetch();
}
function scheduleImageFetch() {
  if (imageFetchTimer) return;
  imageFetchTimer = setTimeout(fetchPendingImages, 250);
}
async function fetchPendingImages() {
  imageFetchTimer = null;
  const keys = [...imagePending];
  const mints = keys.filter((k) => k.startsWith('t:')).map((k) => k.slice(2)).slice(0, 40);
  const wallets = keys.filter((k) => k.startsWith('w:')).map((k) => k.slice(2)).slice(0, 25);
  let changed = false;
  try {
    const jobs = [];
    if (mints.length) {
      jobs.push(
        fetch('/api/tokens/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: mints.map((address) => ({ chain: 'solana', address })) }) })
          .then((r) => r.json())
          .then((d) => {
            for (const m of mints) {
              const img = d?.tokens?.[m]?.imageUrl;
              tokenImageCache.set(m, typeof img === 'string' && /^https:\/\//i.test(img) ? img : null);
              if (img) changed = true;
            }
          })
      );
    }
    if (wallets.length) {
      jobs.push(
        fetch('/api/wallets/avatars', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses: wallets }) })
          .then((r) => (r.ok ? r.json() : { avatars: {} }))
          .then((d) => {
            for (const w of wallets) {
              const a = d?.avatars?.[w];
              walletAvatarCache.set(w, a && /^https:\/\//i.test(a.imageUrl || '') ? a : null);
              if (a) changed = true;
            }
          })
      );
    }
    await Promise.all(jobs);
  } catch {
    // keep fallbacks; retry on a later render
    for (const m of mints) tokenImageCache.delete(m);
    for (const w of wallets) walletAvatarCache.delete(w);
  } finally {
    for (const m of mints) imagePending.delete(`t:${m}`);
    for (const w of wallets) imagePending.delete(`w:${w}`);
  }
  if (imagePending.size) scheduleImageFetch();
  if (changed) {
    renderTerminalAll();
    if (typeof renderLiveSignals === 'function') renderLiveSignals();
  }
}

/** Token logo with a lettered fallback; only https images are used. Pass the mint to fill gaps from Alchemy. */
function tokenAvatar(imageUrl, symbol, size = 28, mint = null) {
  const letter = esc(String(symbol || '?').replace(/^\$/, '').charAt(0).toUpperCase() || '?');
  let img = typeof imageUrl === 'string' && /^https:\/\//i.test(imageUrl) ? imageUrl : null;
  if (!img && mint) {
    img = tokenImageCache.get(mint) || null;
    if (!tokenImageCache.has(mint)) needTokenImage(mint);
  }
  return `<span class="tok-avatar" style="width:${size}px;height:${size}px">${
    img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ''
  }<b>${letter}</b></span>`;
}

/** Trader picture: an NFT the wallet holds (Alchemy). Falls back to the initial on a colour made from the address. */
function walletAvatar(wallet, name, size = 36, extraClass = '') {
  const letter = esc(String(name || wallet || '?').replace('@', '').charAt(0).toUpperCase() || '?');
  let hue = 0;
  for (const ch of String(wallet || '')) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const a = wallet ? walletAvatarCache.get(wallet) : null;
  if (wallet && !walletAvatarCache.has(wallet)) needWalletAvatar(wallet);
  const title = a ? `Wallet picture: ${a.name || 'NFT'} held by this wallet` : '';
  return `<span class="w-avatar ${extraClass}" style="width:${size}px;height:${size}px;--wh:${hue}"${title ? ` title="${esc(title)}"` : ''}>${
    a ? `<img src="${esc(a.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ''
  }<b>${letter}</b></span>`;
}

function shortAddr(a, head = 4, tail = 4) {
  const s = String(a || '');
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

function timeAgo(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function formatTokenPrice(p) {
  const n = Number(p || 0);
  if (!n) return '—';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.0001) return `$${n.toPrecision(3).replace(/0+$/, '')}`;
  // Meme-coin style: $0.0₅21 = 0.0000021 (subscript = number of extra zeros)
  const zeros = Math.floor(-Math.log10(n));
  const digits = Math.round(n * 10 ** (zeros + 3)).toString().slice(0, 3).replace(/0+$/, '');
  return `$0.0<sub>${zeros}</sub>${digits}`;
}

function formatQty(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(v < 1 ? 4 : 2);
}

window.loadLiveSignals = async function loadLiveSignals() {
  try {
    const res = await fetch('/api/signals');
    const data = await res.json();
    if (data.ok) {
      liveWatch = data;
      renderLiveSignals();
    }
  } catch {
    // server without live watching support
  }
};

function mergeLiveWatch(partial) {
  if (!partial) return;
  liveWatch = { ...(liveWatch || { signals: [] }), ...partial, signals: liveWatch?.signals || [] };
}

function handleLiveSse(payload) {
  if (payload.event === 'live_signal' && payload.data) {
    mergeLiveWatch(payload.liveWatch);
    if (!liveWatch.signals.some((s) => s.signature === payload.data.signature)) {
      liveWatch.signals.unshift(payload.data);
      liveWatch.signals = liveWatch.signals.slice(0, 200);
    }
    renderLiveSignals();
    const s = payload.data;
    if (!s.backfill && Number(s.usdValue || 0) >= 1) {
      const who = s.label || shortAddr(s.wallet);
      showToast(`${who} ${s.side === 'buy' ? 'bought' : 'sold'} $${s.symbol} · ${formatUsd(s.usdValue)} (live signal)`, s.side === 'buy' ? 'good' : 'warn');
    }
    return true;
  }
  if (payload.event === 'watcher_status') {
    mergeLiveWatch(payload.liveWatch);
    renderLiveSignals();
    return true;
  }
  return false;
}

function watchStatusInfo() {
  if (!liveWatch) return { tone: 'off', text: 'Unavailable' };
  const { config, status, watchList } = liveWatch;
  if (!config.enabled) return { tone: 'off', text: 'Paused' };
  if (!watchList.length) return { tone: 'off', text: 'No wallets to watch' };
  if (status.rateLimited) return { tone: 'warn', text: 'RPC rate-limited · slowing down' };
  if (status.lastError) return { tone: 'bad', text: status.lastError };
  if (!status.lastSuccessAt) return { tone: 'warn', text: `Connecting · ${watchList.length} wallet${watchList.length === 1 ? '' : 's'}` };
  const read = Number(status.txParsed || 0);
  const trades = Number(status.signalsEmitted || 0);
  const reasons = Object.entries(status.skipReasons || {}).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n}× ${r}`).join('\n');
  const sm = status.stream || {};
  const bf = sm.balanceFeed;
  const live = sm.enabled && sm.connected && (!bf || bf.connected || !bf.wanted);
  const streamingCount = (sm.subscriptions || 0) + (bf?.subscriptions || 0);
  const mode = live
    ? `Real-time · ${streamingCount}/${watchList.length} wallet${watchList.length === 1 ? '' : 's'} streaming${sm.tooBusy?.length ? ` · ${sm.tooBusy.length} too busy (checked every ${config.pollSec}s)` : ''}`
    : sm.enabled
      ? `Checking every ${config.pollSec}s · real-time reconnecting`
      : `Watching ${watchList.length} wallet${watchList.length === 1 ? '' : 's'} · checking every ${config.pollSec}s`;
  const streamInfo = sm.enabled
    ? `\n\nReal-time stream: ${live ? 'connected' : 'not connected'}${sm.lastError ? ` (${sm.lastError})` : ''}${bf ? `\nBalance watch (spam-flooded wallets): ${bf.connected ? 'connected' : 'not connected'} · ${bf.subscriptions} wallet${bf.subscriptions === 1 ? '' : 's'} · ${sm.balanceMoves || 0} balance moves${bf.lastError ? ` (${bf.lastError})` : ''}` : ''}\nPushed: ${sm.events || 0} tx · ${sm.failedTx || 0} failed · ${sm.notSwap || 0} not swaps · ${sm.signals || 0} trades${sm.avgProcessMs != null ? ` · ready ${sm.avgProcessMs} ms after the push` : ''}`
    : '';
  return {
    tone: live || !sm.enabled ? 'ok' : 'warn',
    text: `${mode} · ${trades} trade${trades === 1 ? '' : 's'} found`,
    title: `${reasons ? `Ignored transactions:\n${reasons}` : `Last check ${timeAgo(status.lastSuccessAt)} · ${read} tx read`}${streamInfo}`,
  };
}

function decisionHtml(sig) {
  const decisions = sig.decisions || [];
  if (Array.isArray(sig.copies) && sig.copies.length) {
    return sig.copies
      .map((c) =>
        c.ok
          ? `<span class="decision d-copied" title="Copied for ${esc(c.handle)}">Copied${sig.copies.length > 1 ? ` · ${esc(c.handle)}` : ''}</span>`
          : skipBadge(c.reason || c.status)
      )
      .join(' ');
  }
  if (sig.paperCopied) return '<span class="decision d-copied">Copied</span>';
  if (!decisions.length) return '<span class="muted">—</span>';
  return decisions
    .map((d) => {
      if (d.status === 'would_copy') {
        const what = sig.side === 'buy' ? `Would copy ${d.sizeUsd ? formatUsd(d.sizeUsd) : ''}` : 'Would mirror sell';
        return `<span class="decision d-copy" title="Dry run: passed every filter and risk check">${esc(what)}</span>`;
      }
      if (d.status === 'watch_only') return '<span class="decision d-watch">Watch only</span>';
      if (d.status === 'error') return `<span class="decision d-skip" title="${esc(d.reason)}">Check failed</span>`;
      return skipBadge(d.reason);
    })
    .join(' ');
}

function renderLiveSignals() {
  const badge = document.getElementById('badge-sig-count');
  const tbody = document.getElementById('signals-tbody');
  if (!liveWatch || !tbody) return;
  const { config, watchList } = liveWatch;
  const signals = liveWatch.signals.filter((x) => (!traderFilter || x.wallet === traderFilter.wallet) && inDateFilter(x.blockTime || x.detectedAt));
  renderTraderFilterBar();
  const liveCount = signals.filter((s) => !s.backfill).length;
  if (badge) badge.textContent = String(liveCount);

  const st = watchStatusInfo();
  const stEl = document.getElementById('watch-status');
  if (stEl) {
    stEl.className = `watch-status ws-${st.tone}`;
    document.getElementById('watch-status-text').textContent = st.text;
    stEl.title = st.title || '';
  }
  const dot = document.getElementById('signals-tab-dot');
  if (dot) dot.style.display = st.tone === 'ok' ? '' : 'none';

  const en = document.getElementById('watch-enabled');
  if (en) en.checked = Boolean(config.enabled);
  const rt = document.getElementById('watch-realtime');
  if (rt) rt.checked = config.realtime !== false;
  const pc = document.getElementById('watch-paper-copy');
  if (pc) pc.checked = Boolean(config.paperCopy);
  const rpc = document.getElementById('watch-rpc-url');
  if (rpc && document.activeElement !== rpc) rpc.value = config.rpcUrl || '';
  const al = document.getElementById('alchemy-status');
  if (al) {
    const a = liveWatch.alchemy || {};
    if (a.configured) {
      const onRpc = config.rpcProvider === 'alchemy';
      al.className = 'alchemy-status is-on';
      al.innerHTML = `<span class="ws-dot"></span><span><strong>Alchemy connected</strong> · key ${esc(a.keyMasked)} · token logos &amp; metadata on${
        onRpc ? ' · Solana RPC via Alchemy' : ''
      }${a.lastError ? ` · <span class="pos-warn">${esc(a.lastError)}</span>` : ''}</span>${
        onRpc ? '' : `<button class="btn btn-sm" onclick="updateWatchConfig({ rpcUrl: 'alchemy' })">Use Alchemy RPC</button>`
      }`;
    } else {
      al.className = 'alchemy-status';
      al.innerHTML = '<span class="ws-dot"></span><span><strong>Alchemy not configured.</strong> Add <code>ALCHEMY_API_KEY=…</code> to the <code>.env</code> file next to server.mjs and restart for token logos and a faster Solana RPC.</span>';
    }
  }
  const ps = document.getElementById('watch-poll-sec');
  if (ps && [...ps.options].some((o) => Number(o.value) === Number(config.pollSec))) ps.value = String(config.pollSec);

  const wl = document.getElementById('watch-list');
  if (wl) {
    wl.innerHTML = watchList.length
      ? watchList
          .map(
            (w) => `<span class="watch-chip ${w.source === 'manual' ? 'is-manual' : ''}" title="${esc(w.address)}">
              ${walletAvatar(w.address, w.label, 30)}
              <strong>${esc(w.label || 'Wallet')}</strong><span class="mono">${esc(shortAddr(w.address))}</span>
              ${w.source === 'manual' ? `<button onclick="removeWatchWallet('${esc(w.address)}')" aria-label="Stop watching">✕</button>` : '<em>follow</em>'}
            </span>`
          )
          .join('')
      : '<span class="muted watch-empty">No wallets yet. Follow a Solana trader or paste a wallet address.</span>';
  }

  if (!signals.length) {
    tbody.__lastHtml = null;
    tbody.innerHTML = emptyRowHtml(
      8,
      watchList.length ? (dateFilterState.preset !== 'all' && liveWatch.signals.length ? `No signals ${dateFilterPhrase()}` : 'Waiting for the next swap…') : 'Nothing to watch yet',
      watchList.length
        ? dateFilterState.preset !== 'all' && liveWatch.signals.length
          ? 'Older signals are hidden by the date filter at the top. Pick a longer range or All time to see them.'
          : 'New buys and sells appear here within one check interval of landing on-chain. The last few swaps load when watching starts.'
        : 'Copy a wallet, or paste any wallet address above to watch it, and its real trades show up here.',
      watchList.length ? '' : `<div class="empty-inline-actions"><button class="btn btn-primary btn-sm" onclick="openQuickCopyModal()">Copy a wallet</button></div>`
    );
    return;
  }

  setHtml(tbody, signals
    .map((s, i) => {
      const quote = s.quoteSymbol === 'SOL' ? `${Number(s.quoteAmount).toFixed(3)} SOL` : `${Number(s.quoteAmount).toFixed(2)} ${esc(s.quoteSymbol)}`;
      const tokenLink = s.pairUrl || `https://dexscreener.com/solana/${encodeURIComponent(s.tokenMint)}`;
      const copied = (Array.isArray(s.copies) && s.copies.some((c) => c.ok)) || s.paperCopied;
      const ageChip = copied
        ? '<span class="age-chip ac-copied"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12.5 11 15.5 16 9.5"/></svg>Copied</span>'
        : s.via === 'stream' || s.via === 'fast-logs'
          ? `<span class="age-chip ac-live" title="Pushed in real time${s.latencySec != null ? ` · seen ${s.latencySec}s after the trade` : ''}${s.streamMs != null ? ` · ready ${s.streamMs} ms after the push` : ''}">⚡ live</span>`
          : s.backfill
            ? '<span class="age-chip ac-hist">earlier</span>'
            : '';
      const auth = s.authorityKnown
        ? `<span class="sig-pill ${s.mintAuthority ? 'sp-risk' : 'sp-ok'}" title="Mint authority ${s.mintAuthority ? 'is active: more tokens can be created' : 'revoked'}">mint ${s.mintAuthority ? 'on' : 'off'}</span>${s.freezeAuthority ? '<span class="sig-pill sp-risk" title="Freeze authority is active">freeze on</span>' : ''}`
        : '';
      const traderName = esc(s.label || 'Wallet');
      return `
        <tr class="sig-row ${s.backfill ? 'is-backfill' : 'is-new'}">
          <td>
            <div class="sig-token-cell">
              ${tokenAvatar(s.imageUrl, s.symbol, 58, s.tokenMint)}
              <div class="sig-token-main">
                <div class="sig-token-line"><a class="sig-token" href="${esc(tokenLink)}" target="_blank" rel="noopener" title="Open chart">$${esc(s.symbol)}</a>${s.dexId ? `<span class="sig-pill sp-dex">${esc(s.dexId)}</span>` : ''}</div>
                <div class="sig-mint mono" title="${esc(s.tokenMint)}">${esc(shortAddr(s.tokenMint, 6, 4))}<button type="button" class="sig-copy" onclick="copyText('${esc(s.tokenMint)}', 'Token address copied.')" aria-label="Copy token address"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>
                ${auth ? `<div class="sig-pills">${auth}</div>` : ''}
              </div>
            </div>
          </td>
          <td>
            <span class="sig-trader-wrap">${walletAvatar(s.wallet, s.label, 32)}<span class="sig-trader">${followForWallet(s.wallet) ? `<button type="button" class="trader-link" onclick="openTrader('${esc(s.wallet)}')" title="Open in Copytrades">${traderName}</button>` : `<strong>${traderName}</strong>`}<a class="mono muted" href="https://solscan.io/account/${encodeURIComponent(s.wallet)}" target="_blank" rel="noopener">${esc(shortAddr(s.wallet))}</a></span></span>
          </td>
          <td><span class="side-pill side-${s.side}">${s.side === 'buy' ? 'Buy' : 'Sell'}</span></td>
          <td><div class="mono sig-main">${quote}</div><div class="mono muted sig-sub" title="${formatQty(s.tokenAmount)} tokens">${formatUsd(s.usdValue)}</div></td>
          <td><div class="mono sig-main">${formatTokenPrice(s.txPriceUsd)}</div><div class="mono muted sig-sub">${s.marketCapUsd ? `MC ${formatMc(s.marketCapUsd)}` : 'MC —'}</div></td>
          <td><div class="sig-main" title="${s.blockTime ? fmtDateTime(s.blockTime) : ''}">${timeAgo(s.blockTime || s.detectedAt)}</div>${ageChip ? `<div class="sig-age-chip">${ageChip}</div>` : ''}</td>
          <td class="sig-decision">${copied ? decisionSkipsOnly(s) : decisionHtml(s)}</td>
          <td class="right">
            <div class="sig-actions">
              <a class="ext-ico" href="${esc(s.explorerUrl)}" target="_blank" rel="noopener" title="Open transaction on Solscan" aria-label="Open transaction on Solscan"><img src="/icons/solscan.png" alt="" width="20" height="16" /></a>
              <a class="ext-ico" href="${esc(tokenLink)}" target="_blank" rel="noopener" title="Open ${esc(s.symbol)} on DexScreener" aria-label="Open token on DexScreener"><img src="/icons/dexscreener.png" alt="" width="20" height="17" /></a>
              <div class="sig-more">
                <button type="button" class="sig-more-btn" onclick="toggleSigMenu(event, ${i})" aria-label="More actions"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg></button>
                <div class="sig-menu" id="sig-menu-${i}" hidden>
                  <a href="${esc(tokenLink)}" target="_blank" rel="noopener">Open chart</a>
                  <button type="button" onclick="copyText('${esc(s.tokenMint)}', 'Token address copied.')">Copy token address</button>
                  <button type="button" onclick="copyText('${esc(s.signature)}', 'Transaction signature copied.')">Copy transaction</button>
                  ${followForWallet(s.wallet) ? `<button type="button" onclick="filterByTrader('${esc(s.wallet)}', 'signals')">Only this trader</button>` : ''}
                </div>
              </div>
            </div>
          </td>
        </tr>`;
    })
    .join(''));
}

/** When a trade was copied, only show the follows that skipped it (the "Copied" chip says the rest). */
function decisionSkipsOnly(sig) {
  const bad = (sig.copies || []).filter((c) => !c.ok);
  return bad.map((c) => skipBadge(c.reason || c.status)).join(' ');
}

window.copyText = async function copyText(text, msg = 'Copied.') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(msg, 'good');
  } catch {
    showToast(text, 'info');
  }
};

window.toggleSigMenu = function toggleSigMenu(ev, i) {
  ev.stopPropagation();
  const m = document.getElementById(`sig-menu-${i}`);
  const open = m && m.hidden;
  document.querySelectorAll('.sig-menu').forEach((x) => (x.hidden = true));
  if (m) m.hidden = !open;
};
document.addEventListener('click', () => document.querySelectorAll('.sig-menu').forEach((x) => (x.hidden = true)));

window.toggleSignalsBanner = function toggleSignalsBanner() {
  const b = document.getElementById('signals-banner');
  if (!b) return;
  b.classList.toggle('is-collapsed');
  try {
    localStorage.setItem('odex.signalsBannerCollapsed', b.classList.contains('is-collapsed') ? '1' : '0');
  } catch {
    // storage unavailable: just toggle for this visit
  }
};
try {
  if (localStorage.getItem('odex.signalsBannerCollapsed') === '1') document.addEventListener('DOMContentLoaded', () => document.getElementById('signals-banner')?.classList.add('is-collapsed'));
} catch {
  // ignore
}

window.updateWatchConfig = async function updateWatchConfig(patch) {
  const res = await fetch('/api/signals/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!data.ok) {
    showToast(data.error || 'Could not update live watching', 'danger');
    return loadLiveSignals();
  }
  mergeLiveWatch(data);
  renderLiveSignals();
  if (patch.paperCopy === true && engineState && engineState.settings.paperTrading === false) {
    showToast('Paper-copy only runs while Paper Trading is ON', 'warn');
  }
};

window.addWatchWallet = async function addWatchWallet() {
  const addrEl = document.getElementById('watch-add-address');
  const labelEl = document.getElementById('watch-add-label');
  const res = await fetch('/api/signals/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', address: addrEl.value.trim(), label: labelEl.value.trim() }),
  });
  const data = await res.json();
  if (!data.ok) return showToast(data.error || 'Could not watch that wallet', 'danger');
  addrEl.value = '';
  labelEl.value = '';
  mergeLiveWatch(data);
  renderLiveSignals();
  showToast('Watching wallet: its last few swaps will load shortly', 'good');
};

window.removeWatchWallet = async function removeWatchWallet(address) {
  const res = await fetch('/api/signals/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', address }),
  });
  const data = await res.json();
  if (data.ok) {
    mergeLiveWatch(data);
    renderLiveSignals();
  }
};

window.pollSignalsNow = async function pollSignalsNow() {
  const btn = document.getElementById('btn-poll-now');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/signals/poll', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      liveWatch = data;
      renderLiveSignals();
      if (data.status?.lastError) showToast(data.status.lastError, 'danger');
      else showToast(data.found ? `${data.found} new swap${data.found === 1 ? '' : 's'} found` : 'No new swaps since the last check', 'good');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.addEventListener('DOMContentLoaded', () => {
  loadLiveSignals();
  // keep "x seconds ago" fresh
  setInterval(() => {
    if (document.getElementById('term-signals')?.classList.contains('active')) renderLiveSignals();
  }, 5000);
});

// ============================================================================
// Sidebar (vertical menu) & global header search
// ============================================================================
function activeTermTab() {
  return currentTermTab || 'positions';
}

const SIDEBAR_PANELS = ['follows', 'wallets', 'history', 'config'];

function syncSideSubnav() {
  const onTerminal = document.getElementById('view-terminal')?.classList.contains('active');
  const tab = activeTermTab();
  // Sidebar: Copytrades / Wallets / History / Settings light up for their panel; Home for every other panel
  document.querySelectorAll('.side-nav .nav-tab').forEach((b) => {
    const panel = b.getAttribute('data-panel');
    const view = b.getAttribute('data-view');
    if (panel === 'follows') b.classList.toggle('active', Boolean(onTerminal && tab === 'config' && currentCfgSection === 'copytrades'));
    else if (panel === 'config') b.classList.toggle('active', Boolean(onTerminal && tab === 'config' && currentCfgSection !== 'copytrades'));
    else if (panel) b.classList.toggle('active', Boolean(onTerminal && tab === panel));
    else if (view === 'terminal') b.classList.toggle('active', Boolean(onTerminal && !SIDEBAR_PANELS.includes(tab)));
  });
  document.querySelectorAll('.nav-sub').forEach((b) => {
    const m = (b.getAttribute('onclick') || '').match(/goTerminalTab\('([a-z]+)'\)/);
    b.classList.toggle('active', Boolean(onTerminal && m && m[1] === tab));
  });
}

window.goTerminalTab = function goTerminalTab(tab) {
  if (tab === 'config') {
    setTimeout(() => window.refreshRealPanel?.(), 0);
    if (!routeApplying && currentCfgSection === 'copytrades') setTimeout(() => openSettingsSection('profile'), 0);
  }
  // one address change per click: the view switch below must not record its own step
  const wasApplying = typeof routeApplying !== 'undefined' && routeApplying;
  if (typeof routeApplying !== 'undefined') routeApplying = true;
  switchMainView.keepPanel = true;
  switchMainView('terminal');
  switchMainView.keepPanel = false;
  if (typeof routeApplying !== 'undefined') routeApplying = wasApplying;
  switchTermTab(tab);
  // opening an address directly (or Back / Forward) keeps the page where it is
  if (typeof routeApplying !== 'undefined' && routeApplying) return;
  const target = SIDEBAR_PANELS.includes(tab) ? document.getElementById(`term-${tab}`) : document.querySelector('.term-tabs');
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// ---------------------------------------------------------------------------
// Footer status bar: Solana ping + website bug checker
// ---------------------------------------------------------------------------
// Skips that are the bot doing its job — used only to keep those out of popups
const NORMAL_SKIP_RE = /manages exits itself|doesn't copy sells|nothing tracked to sell|below your minimum|watched manually|your account is paused|trader paused|already holding|cooldown|price moved too far|top-ups not copied/i;

/** A "not copied" badge: expected skips (rules doing their job) are neutral; real problems stay yellow. */
function skipBadge(reason) {
  const r = String(reason || 'not copied');
  const friendly = /nothing tracked to sell/i.test(r)
    ? 'Not held — we hold none of this coin'
    : /first buy was too late/i.test(r)
      ? 'Missed entry — skipping their top-ups too'
      : /top-ups not copied/i.test(r)
        ? 'Top-up — already copied this position'
        : /price moved too far/i.test(r)
          ? 'Price ran past your max chase'
          : null;
  const normal = NORMAL_SKIP_RE.test(r) || /pump-only is on|launchpad-only/i.test(r);
  return `<span class="decision d-skip${normal ? ' is-normal' : ''}" title="${esc(r)}">${normal ? '' : 'Skip · '}${esc(friendly || r)}</span>`;
}
let lastPing = { ms: null, ok: false, source: 'rpc' };
let serverHealth = null; // { checks: [...], checkedAt }
let healthUnavailable = false;
const clientBugs = new Map(); // key → { title, detail, source, count, first, last }
let sseDown = false;

function recordBug(key, title, detail, source = 'Website') {
  const b = clientBugs.get(key);
  if (b) {
    b.count += 1;
    b.last = Date.now();
    b.detail = detail || b.detail;
  } else {
    clientBugs.set(key, { title, detail, source, count: 1, first: Date.now(), last: Date.now() });
  }
  setTimeout(renderStatusBar, 0);
}

// 1. Script errors anywhere on the page
window.addEventListener('error', (e) => {
  if (!e.message) return;
  const where = e.filename ? `${String(e.filename).split('/').pop()}:${e.lineno}` : 'page';
  recordBug(`js:${e.message}:${where}`, 'Script error', `${e.message} (${where})`);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason || 'Unknown error');
  if (/Failed to fetch|NetworkError|aborted/i.test(msg)) return; // counted by the request monitor
  recordBug(`promise:${msg}`, 'Unhandled error', msg);
});

// 2. Requests to the server that crash (5xx) or cannot reach it at all
(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const ours = url.startsWith('/') || url.startsWith(location.origin);
    const path = ours ? url.replace(location.origin, '').split('?')[0] : '';
    try {
      const res = await nativeFetch(input, init);
      if (ours && res.status >= 500) recordBug(`http:${path}:${res.status}`, 'Server error', `${init?.method || 'GET'} ${path} returned ${res.status}`, 'Server');
      else if (ours && res.ok) clientBugs.delete(`net:${path}`);
      return res;
    } catch (err) {
      if (ours) recordBug(`net:${path}`, "Can't reach the server", `${init?.method || 'GET'} ${path}: ${err.message}. Is the server running?`, 'Server');
      throw err;
    }
  };
})();

// 3. Page parts the app depends on (missing = broken page)
const REQUIRED_ELEMENTS = ['positions-list', 'follows-list', 'signals-tbody', 'history-tbody', 'wallets-list', 'kpi-total-balance', 'modal-copy', 'modal-deposit', 'modal-confirm', 'header-wallet-dropdown'];
function checkPageParts() {
  const missing = REQUIRED_ELEMENTS.filter((id) => !document.getElementById(id));
  if (missing.length) recordBug('dom:missing', 'Page parts missing', `Not found: ${missing.join(', ')}. Hard-refresh the page (Ctrl+F5).`);
}

function collectIssues() {
  const items = [];
  if (sseDown) items.push({ tone: 'bad', source: 'Website', title: 'Live updates disconnected', detail: 'The page lost its live connection to the server; numbers may be stale. It reconnects automatically.' });
  if (healthUnavailable) items.push({ tone: 'warn', source: 'Server', title: 'Health check unavailable', detail: 'Restart the server to enable the full bug checker.' });
  for (const c of serverHealth?.checks || []) {
    if (!c.ok) items.push({ tone: c.severity === 'error' ? 'bad' : 'warn', source: 'Server', title: c.name, detail: c.detail });
  }
  for (const b of clientBugs.values()) {
    items.push({ tone: 'bad', source: b.source, title: b.title, detail: `${b.detail}${b.count > 1 ? ` · ${b.count}×` : ''}`, at: b.last });
  }
  return items;
}

let sbLastSolPx = 0;
function renderStatusBar() {
  if (!engineState) return;
  // live SOL price (left of the status bar): flashes green/red when it moves
  const pxEl = document.getElementById('sb-solpx-n');
  const solNow = Number(engineState?.chains?.solana?.nativePriceUsd) || 0;
  if (pxEl && solNow > 0) {
    pxEl.textContent = `$${solNow.toFixed(2)}`;
    const box = document.getElementById('sb-solpx');
    if (box && sbLastSolPx > 0 && Math.abs(solNow - sbLastSolPx) >= 0.005) {
      const dir = solNow > sbLastSolPx ? 'up' : 'down';
      box.classList.remove('px-up', 'px-down');
      void box.offsetWidth; // restart the flash
      box.classList.add(`px-${dir}`);
      box.title = `Live SOL price · ${dir === 'up' ? '▲' : '▼'} $${Math.abs(solNow - sbLastSolPx).toFixed(2)} since last update`;
    }
    sbLastSolPx = solNow;
  }
  const issues = collectIssues();
  const iEl = document.getElementById('sb-issues-n');
  if (iEl) iEl.textContent = issues.length ? `${issues.length.toLocaleString()} Issue${issues.length === 1 ? '' : 's'} Tracked` : 'No issues';
  document.getElementById('sb-issues')?.classList.toggle('is-clear', issues.length === 0);
  if (document.getElementById('issues-panel')?.classList.contains('open')) renderIssuesPanel(issues);

  const lEl = document.getElementById('sb-latency-n');
  const ms = lastPing.ms;
  if (lEl) lEl.textContent = ms != null ? `${ms}ms` : lastPing.checked ? 'offline' : '…';
  const lat = document.getElementById('sb-latency');
  if (lat) {
    lat.setAttribute('data-tone', ms == null ? (lastPing.checked ? 'bad' : 'off') : ms < 400 ? 'ok' : ms < 1200 ? 'warn' : 'bad');
    lat.title = lastPing.source === 'rpc' ? 'Ping to your Solana RPC (live)' : 'Ping to the Odex Mirror server (restart the server for Solana RPC ping)';
  }
}

function renderIssuesPanel(issues = collectIssues()) {
  const list = document.getElementById('ip-list');
  if (!list) return;
  const sub = document.getElementById('ip-sub');
  const checked = serverHealth?.checkedAt ? `checked ${timeAgo(serverHealth.checkedAt)}` : 'checking…';
  if (sub) sub.textContent = issues.length ? `${issues.length} problem${issues.length === 1 ? '' : 's'} found · ${checked}` : `All checks passed · ${checked}`;
  list.innerHTML = issues.length
    ? issues
        .map(
          (i) => `<div class="ip-item tone-${i.tone}"><span class="ip-dot"></span><div class="ip-body"><div class="ip-title">${esc(i.title || 'Issue')} <span class="ip-src">${esc(i.source || '')}</span></div><div class="ip-detail">${esc(i.detail || '')}</div></div>${i.at ? `<span class="ip-time">${timeAgo(i.at)}</span>` : ''}</div>`
        )
        .join('')
    : `<div class="ip-empty"><strong>No bugs found</strong><span>Website, server, database, wallet watcher, Solana connection and price feed are all working.</span></div>`;
  const passed = (serverHealth?.checks || []).filter((c) => c.ok);
  if (passed.length) {
    list.insertAdjacentHTML('beforeend', `<details class="ip-passed"><summary>${passed.length} server checks passed</summary><ul>${passed.map((c) => `<li>${esc(c.name)}</li>`).join('')}</ul></details>`);
  }
}

async function runHealthCheck() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (res.status === 404) {
      healthUnavailable = true;
      serverHealth = null;
    } else {
      healthUnavailable = false;
      serverHealth = await res.json();
    }
  } catch {
    // unreachable server is reported by the request monitor
  }
  checkPageParts();
  renderStatusBar();
}

window.toggleIssuesPanel = function toggleIssuesPanel(force) {
  const panel = document.getElementById('issues-panel');
  if (!panel) return;
  const open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  document.getElementById('sb-issues')?.setAttribute('aria-expanded', String(open));
  if (open) {
    renderIssuesPanel();
    runHealthCheck();
  }
};

window.rerunChecks = async function rerunChecks() {
  clientBugs.clear();
  const sub = document.getElementById('ip-sub');
  if (sub) sub.textContent = 'Running checks…';
  await runHealthCheck();
  renderIssuesPanel();
};

window.copyBugReport = async function copyBugReport() {
  const issues = collectIssues();
  const lines = [
    `Odex Mirror bug report · ${new Date().toISOString()}`,
    `Page: ${location.href}`,
    `Ping: ${lastPing.ms != null ? `${lastPing.ms} ms (${lastPing.source})` : 'offline'}`,
    '',
    issues.length ? issues.map((i) => `- [${i.source}] ${i.title}: ${i.detail}`).join('\n') : 'No issues found.',
    '',
    'Server checks:',
    ...(serverHealth?.checks || []).map((c) => `  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`),
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    showToast('Bug report copied.', 'good');
  } catch {
    showToast('Could not copy the report.', 'warn');
  }
};

window.openIssues = () => toggleIssuesPanel(true);

document.addEventListener('click', (e) => {
  const wrap = document.querySelector('.sb-issues-wrap');
  if (wrap && !wrap.contains(e.target)) toggleIssuesPanel(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleIssuesPanel(false);
});

setInterval(runHealthCheck, 15000);
setTimeout(runHealthCheck, 800);

async function pingNow() {
  try {
    const t0 = performance.now();
    const res = await fetch('/api/ping', { cache: 'no-store' });
    if (res.status === 404) {
      // older server without /api/ping: show the server round-trip instead
      lastPing = { ms: Math.round(performance.now() - t0), ok: true, source: 'server', checked: true };
    } else {
      const d = await res.json();
      lastPing = { ms: d.rpcMs ?? null, ok: Boolean(d.ok && d.rpcMs != null), source: 'rpc', error: d.error, checked: true };
    }
  } catch (err) {
    lastPing = { ms: null, ok: false, source: 'server', error: err.message, checked: true };
  }
  renderStatusBar();
}
setInterval(pingNow, 5000);
setInterval(() => refreshChainBalance(true), 30000);
setTimeout(() => refreshChainBalance(true), 1200);
setTimeout(pingNow, 500);
setInterval(renderStatusBar, 3000);

window.toggleSidebar = function toggleSidebar(force) {
  const open = typeof force === 'boolean' ? force : !document.body.classList.contains('sidebar-open');
  document.body.classList.toggle('sidebar-open', open);
  document.querySelector('.sidebar-toggle')?.setAttribute('aria-expanded', String(open));
};



// ---------------------------------------------------------------------------
// Global search
// ---------------------------------------------------------------------------
const SEARCH_PAGES = [
  { title: 'Web Terminal', sub: 'Positions, KPIs and exit engine', keys: 'terminal home dashboard', go: () => switchMainView('terminal') },
  { title: 'Positions', sub: 'Open positions & limit orders', keys: 'positions open orders limit sell', go: () => goTerminalTab('positions') },
  { title: 'Live Signals', sub: 'Real wallet buys and sells', keys: 'live signals watch wallet real onchain', go: () => goTerminalTab('signals') },
  { title: 'Copytrades', sub: 'Traders you copy & exit rules', keys: 'copytrades follows traders exit rules', go: () => goTerminalTab('follows') },
  { title: 'Settings & Risk', sub: 'Slippage, filters, risk limits', keys: 'settings slippage filters risk chase safety', go: () => goTerminalTab('settings') },
  { title: 'Profile', sub: 'Name, time zone, start page', keys: 'profile name timezone account', go: () => { goTerminalTab('config'); setTimeout(() => openSettingsSection('profile'), 0); } },
  { title: 'Security', sub: 'Network access, keys, sell confirmations', keys: 'security network lan keys password confirm hide balances privacy', go: () => { goTerminalTab('config'); setTimeout(() => openSettingsSection('security'), 0); } },
  { title: 'Notifications', sub: 'Pop-ups and sound', keys: 'notifications toast sound alerts popups', go: () => { goTerminalTab('config'); setTimeout(() => openSettingsSection('notifications'), 0); } },
  { title: 'Data & storage', sub: 'Database, backups, Supabase', keys: 'database backup supabase storage export import', go: () => { goTerminalTab('config'); setTimeout(() => openSettingsSection('data'), 0); } },
  { title: 'Wallets', sub: 'Solana wallet, balance, receive, swap', keys: 'wallets balance receive deposit swap solana phantom', go: () => goTerminalTab('wallets') },
  { title: 'History', sub: '7-day fills and skips', keys: 'history receipts skips log', go: () => goTerminalTab('history') },
  { title: 'Docs', sub: 'How the engine works', keys: 'docs help engine spec rules', go: () => switchMainView('docs') },
  { title: 'Dax', sub: 'Trade report agent', keys: 'dax report agent analysis summary claude', go: () => openDax() },
  { title: 'Deposit', sub: 'Add funds to the active wallet', keys: 'deposit fund add sol', go: () => openDepositModal() },
  { title: 'Copy a trader', sub: 'Open the copy dialog', keys: 'copy follow new trader add', go: () => openQuickCopyModal() },
];

const SEARCH_ICONS = {
  page: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  wallet: '<path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0-2 2c0 1.1.9 2 2 2h4v-4h-4z"/>',
  token: '<circle cx="12" cy="12" r="9"/><path d="M9 12h6M12 9v6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
};

let searchItems = [];
let searchActive = 0;

function iconBox(name) {
  return `<span class="gs-item-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${SEARCH_ICONS[name]}</svg></span>`;
}

function highlight(text, q) {
  const t = esc(text);
  if (!q) return t;
  const i = String(text).toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t;
  return `${esc(String(text).slice(0, i))}<mark>${esc(String(text).slice(i, i + q.length))}</mark>${esc(String(text).slice(i + q.length))}`;
}

function buildSearchResults(raw) {
  const q = raw.trim().replace(/^[@$]/, '');
  const ql = q.toLowerCase();
  const groups = [];
  if (!q) {
    groups.push({ label: 'Jump to', items: SEARCH_PAGES.slice(0, 7).map((p) => ({ icon: iconBox('page'), title: esc(p.title), sub: p.sub, hint: 'Open', go: p.go })) });
    return groups;
  }

  // Wallet addresses
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw.trim())) {
    const addr = raw.trim();
    groups.push({
      label: 'Solana wallet',
      items: [
        { icon: iconBox('eye'), title: `Watch ${esc(shortAddr(addr, 6, 6))}`, sub: 'Show its real buys and sells in Live Signals', hint: 'Watch', go: async () => {
          goTerminalTab('signals');
          document.getElementById('watch-add-address').value = addr;
          await addWatchWallet();
        } },
        { icon: iconBox('copy'), title: `Copy ${esc(shortAddr(addr, 6, 6))}`, sub: 'Open the copy dialog with this wallet', hint: 'Copy', go: () => {
          openQuickCopyModal(addr);
        } },
      ],
    });
  }

  // Traders you copy (by name or wallet)
  const traderItems = [];
  for (const f of engineState?.follows || []) {
    const hay = `${f.handle} ${f.name} ${f.traderWallet}`.toLowerCase();
    if (!hay.includes(ql)) continue;
    traderItems.push({
      icon: walletAvatar(f.traderWallet, f.name || f.handle, 30),
      title: highlight(f.name || f.handle, q),
      sub: `${f.status === 'copying' ? 'Copying' : 'Paused'} · ${esc(shortAddr(f.traderWallet, 4, 4))}`,
      hint: 'Open',
      go: () => goTerminalTab('follows'),
    });
  }
  if (traderItems.length) groups.push({ label: 'Traders', items: traderItems.slice(0, 6) });

  // Tokens: open positions + live signals
  const tokenItems = [];
  const seenTok = new Set();
  for (const p of (engineState?.positions || []).filter((x) => x.remainingTokens > 0)) {
    if (!`${p.symbol} ${p.name}`.toLowerCase().includes(ql) || seenTok.has(p.symbol)) continue;
    seenTok.add(p.symbol);
    tokenItems.push({ icon: tokenAvatar(p.imageUrl, p.symbol, 30, p.tokenAddress), title: `$${highlight(p.symbol, q)}`, sub: `Open position · ${formatUsd(p.valueUsd)} · ${p.unrealizedPnlPct >= 0 ? '+' : ''}${Number(p.unrealizedPnlPct || 0).toFixed(1)}%`, hint: 'Position', go: () => goTerminalTab('positions') });
  }
  for (const sg of liveWatch?.signals || []) {
    if (!`${sg.symbol} ${sg.name || ''} ${sg.tokenMint}`.toLowerCase().includes(ql) || seenTok.has(sg.symbol)) continue;
    seenTok.add(sg.symbol);
    tokenItems.push({ icon: tokenAvatar(sg.imageUrl, sg.symbol, 30, sg.tokenMint), title: `$${highlight(sg.symbol, q)}`, sub: `Live signal · ${sg.label || shortAddr(sg.wallet)} ${sg.side === 'buy' ? 'bought' : 'sold'} ${timeAgo(sg.blockTime || sg.detectedAt)}`, hint: 'Signals', go: () => goTerminalTab('signals') });
  }
  if (tokenItems.length) groups.push({ label: 'Tokens', items: tokenItems.slice(0, 6) });

  // Pages & actions
  const pages = SEARCH_PAGES.filter((p) => `${p.title} ${p.keys}`.toLowerCase().includes(ql)).slice(0, 5);
  if (pages.length) groups.push({ label: 'Pages & actions', items: pages.map((p) => ({ icon: iconBox('page'), title: highlight(p.title, q), sub: p.sub, hint: 'Open', go: p.go })) });

  return groups;
}

function renderSearch() {
  const input = document.getElementById('global-search-input');
  const box = document.getElementById('global-search');
  const out = document.getElementById('global-search-results');
  if (!input || !out) return;
  const groups = buildSearchResults(input.value);
  searchItems = groups.flatMap((g) => g.items);
  searchActive = Math.min(searchActive, Math.max(0, searchItems.length - 1));
  box.classList.toggle('has-value', Boolean(input.value));
  if (!searchItems.length) {
    out.innerHTML = `<div class="gs-empty">No matches for “${esc(input.value.trim())}”.<br/>Try a trader handle, token symbol, or paste a wallet address.</div>`;
    return;
  }
  let i = 0;
  out.innerHTML =
    groups
      .map(
        (g) => `<div class="gs-group-label">${g.label}</div>` +
          g.items
            .map((it) => {
              const idx = i++;
              return `<button type="button" class="gs-item ${idx === searchActive ? 'is-active' : ''}" role="option" data-idx="${idx}">
                ${it.icon}
                <span class="gs-item-main"><span class="gs-item-title">${it.title}</span><span class="gs-item-sub">${esc(it.sub)}</span></span>
                <span class="gs-item-hint">${it.hint}</span>
              </button>`;
            })
            .join('')
      )
      .join('') +
    `<div class="gs-footer"><span><kbd>↑</kbd><kbd>↓</kbd>navigate</span><span><kbd>Enter</kbd>open</span><span><kbd>Esc</kbd>close</span></div>`;
}

function openSearch(open) {
  const box = document.getElementById('global-search');
  const input = document.getElementById('global-search-input');
  if (!box) return;
  box.classList.toggle('open', open);
  input?.setAttribute('aria-expanded', String(open));
  if (open) renderSearch();
}

function runSearchItem(idx) {
  const it = searchItems[idx];
  if (!it) return;
  const input = document.getElementById('global-search-input');
  openSearch(false);
  input.value = '';
  document.getElementById('global-search').classList.remove('has-value');
  input.blur();
  it.go();
}

window.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('global-search-input');
  const out = document.getElementById('global-search-results');
  if (!input) return;
  input.addEventListener('focus', () => openSearch(true));
  input.addEventListener('input', () => {
    searchActive = 0;
    openSearch(true);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!searchItems.length) return;
      searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchItems.length) % searchItems.length;
      renderSearch();
      out.querySelector('.gs-item.is-active')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runSearchItem(searchActive);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      openSearch(false);
      input.blur();
    }
  });
  out.addEventListener('mousedown', (e) => {
    const btn = e.target.closest('.gs-item');
    if (!btn) return;
    e.preventDefault();
    runSearchItem(Number(btn.dataset.idx));
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#global-search')) openSearch(false);
  });
  // "/" or Ctrl/Cmd+K focuses search (unless typing in another field)
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
  syncSideSubnav();
});


// ============================================================================
// Clear History
// ============================================================================
window.clearHistory = async function clearHistory() {
  const count = engineState?.history?.length || 0;
  if (!count) {
    showToast('History is already empty', 'warn');
    return;
  }
  const ok = await confirmAction({
    title: `Clear ${count} history entr${count === 1 ? 'y' : 'ies'}?`,
    message: 'Removes every fill and skip from the list. Open positions, balances and follows stay as they are. The 24h daily-loss tally also restarts from zero.',
    confirmLabel: 'Clear history',
    danger: true,
  });
  if (!ok) return;
  let data = null;
  try {
    const res = await fetch('/api/history/clear', { method: 'POST' });
    if (res.status === 404) {
      showToast('Clear history needs the updated server: stop it (Ctrl+C) and run npm start again', 'danger');
      return;
    }
    data = await res.json();
  } catch {
    showToast('Could not reach the server to clear history', 'danger');
    return;
  }
  if (data.ok) {
    engineState = data.state;
    renderTerminalAll();
    showToast(`Cleared ${data.removed} history entr${data.removed === 1 ? 'y' : 'ies'}`, 'good');
  } else {
    showToast(data.error || 'Could not clear history', 'danger');
  }
};



// ============================================================================
// Settings page (left menu): sections + profile / security / notification prefs
// ============================================================================
let currentCfgSection = 'copytrades';
let landingApplied = false;

function uiPrefs() {
  return engineState?.settings?.ui || { timeZone: 'local', confirmSells: true, hideBalances: false, notify: { copies: true, sells: true, skips: true, problems: true, sound: false } };
}

function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return uiPrefs().timeZone === 'utc' ? `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC` : d.toLocaleString();
}

window.openSettingsSection = function openSettingsSection(key) {
  if (!document.querySelector(`.cfg-section[data-cfg="${key}"]`)) key = 'copytrades';
  currentCfgSection = key;
  document.querySelectorAll('.cfg-section').forEach((el) => el.classList.toggle('active', el.dataset.cfg === key));
  document.querySelectorAll('.cfg-nav-btn').forEach((el) => el.classList.toggle('active', el.dataset.cfg === key));
  syncSideSubnav();
  try {
    localStorage.setItem('odex.cfgSection', key);
  } catch {
    // storage unavailable
  }
  if (key === 'data' && typeof loadDatabaseInfo === 'function') loadDatabaseInfo();
  if (key === 'security') loadSecurity();
  if (key === 'profile' || key === 'notifications' || key === 'security') fillUiForms();
  if (key === 'trading' && typeof populateSettingsInputs === 'function') populateSettingsInputs();
  if (key === 'integrations') loadIntegrations();
  if (typeof syncUrl === 'function') syncUrl();
};

function fillUiForms() {
  const u = uiPrefs();
  const set = (id, v, prop = 'value') => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el[prop] = v;
  };
  set('ui-display-name', u.displayName || '');
  set('ui-timezone', u.timeZone || 'local');
  set('ui-landing', u.landingTab || 'positions');
  set('sec-confirm-sells', u.confirmSells !== false, 'checked');
  set('sec-hide-balances', Boolean(u.hideBalances), 'checked');
  const n = u.notify || {};
  for (const k of ['copies', 'sells', 'skips', 'problems']) set(`ntf-${k}`, n[k] !== false, 'checked');
  set('ntf-sound', Boolean(n.sound), 'checked');
  const ph = document.getElementById('cfg-phantom-row');
  if (ph) {
    const a = phantomAddress();
    ph.innerHTML = a
      ? `<span class="mono" title="${esc(a)}">${esc(shortAddr(a, 6, 6))}</span><a class="btn btn-sm" href="https://solscan.io/account/${encodeURIComponent(a)}" target="_blank" rel="noopener">Solscan</a><button class="btn btn-sm" onclick="disconnectPhantom().then(fillUiForms)">Disconnect</button>`
      : `<span class="muted">Not linked</span><button class="btn btn-sm" onclick="connectPhantom().then(fillUiForms)">Connect Phantom</button>`;
  }
}

window.saveUiSettings = async function saveUiSettings(group) {
  const ui = {};
  if (group === 'profile') {
    ui.displayName = document.getElementById('ui-display-name').value;
    ui.timeZone = document.getElementById('ui-timezone').value;
    ui.landingTab = document.getElementById('ui-landing').value;
  } else if (group === 'security') {
    ui.confirmSells = document.getElementById('sec-confirm-sells').checked;
    ui.hideBalances = document.getElementById('sec-hide-balances').checked;
  } else if (group === 'notifications') {
    ui.notify = {};
    for (const k of ['copies', 'sells', 'skips', 'problems', 'sound']) ui.notify[k] = document.getElementById(`ntf-${k}`).checked;
  }
  const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    showToast(data.error || 'Could not save settings', 'danger');
    return;
  }
  engineState = data.state;
  renderTerminalAll();
  fillUiForms();
  if (group === 'profile') showToast('Profile saved.', 'good');
};

function applyUiSettings() {
  const u = uiPrefs();
  document.body.classList.toggle('hide-balances', Boolean(u.hideBalances));
  const name = (u.displayName || '').trim();
  const btn = document.querySelector('.header-user-btn');
  if (btn) {
    btn.title = name ? `${name} · account & settings` : 'Account & settings';
    let ini = btn.querySelector('.hub-initial');
    if (name) {
      if (!ini) {
        ini = document.createElement('span');
        ini.className = 'hub-initial';
        btn.appendChild(ini);
      }
      ini.textContent = name.charAt(0).toUpperCase();
      btn.classList.add('has-initial');
    } else if (ini) {
      ini.remove();
      btn.classList.remove('has-initial');
    }
  }
  const acct = document.getElementById('acct-name');
  if (acct) acct.textContent = name || 'Odex Mirror';
  if (!landingApplied) {
    landingApplied = true;
    // "Open on" applies when the plain address (/) is opened, never over an address like /signals
    const t = u.landingTab;
    if (t && t !== 'positions' && openedAtRoot && currentTermTab === 'positions' && getSession()) setTimeout(() => goTerminalTab(t), 0);
  }
}

async function loadSecurity() {
  let d;
  try {
    d = await (await fetch('/api/security')).json();
  } catch {
    return;
  }
  if (!d?.ok) {
    const t = document.getElementById('sec-access-text');
    if (t) t.textContent = 'Restart the server to see network access settings.';
    return;
  }
  const t = document.getElementById('sec-access-text');
  const lan = document.getElementById('sec-lan');
  if (lan) lan.checked = Boolean(d.pendingLanAccess);
  if (t) {
    const now = d.lanAccess ? `Open to your network: any device on your Wi-Fi or local network can open this terminal at your computer's address, port ${d.port}.` : `Only this computer can open the terminal (listening on ${d.host}:${d.port}).`;
    const pending = d.pendingLanAccess !== d.lanAccess ? ' Change saved; restart the server to apply it.' : '';
    t.textContent = now + pending;
  }
  const keys = document.getElementById('sec-keys');
  if (keys) {
    const row = (label, k) => `<div class="cfg-key"><span>${label}</span>${k.configured ? `<span class="mono">${esc(k.keyMasked || 'set')}</span><span class="sig-pill sp-ok">in .env</span>` : '<span class="muted">not set</span>'}</div>`;
    keys.innerHTML = row('Alchemy', d.alchemy) + row(`Supabase${d.supabase.host ? ` · ${esc(d.supabase.host)}` : ''}`, d.supabase) + (d.devTools ? '<div class="cfg-key"><span>Developer test tools</span><span class="sig-pill sp-risk">ON (ODEX_DEV_TOOLS=1)</span></div>' : '');
  }
}

window.setLanAccess = async function setLanAccess(on) {
  if (on) {
    const ok = await confirmAction({ title: 'Open the terminal to your network?', message: 'Anyone on the same Wi-Fi or local network could open this terminal and change its settings or sell positions. Only turn this on at home on a network you trust.', confirmLabel: 'Allow', danger: true });
    if (!ok) {
      document.getElementById('sec-lan').checked = false;
      return;
    }
  }
  const res = await fetch('/api/security', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lanAccess: on }) });
  const d = await res.json().catch(() => ({}));
  if (!d.ok) {
    showToast(d.error || 'Could not change network access', 'danger');
    return;
  }
  showToast(`Saved. Restart the server to ${on ? 'open it to your network' : 'limit it to this computer'}.`, 'warn');
  loadSecurity();
};

let chimeCtx = null;
window.playChime = function playChime(test = false, up = true) {
  try {
    chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = chimeCtx.currentTime;
    const notes = up ? [880, 1320] : [660, 440];
    notes.forEach((f, i) => {
      const o = chimeCtx.createOscillator();
      const g = chimeCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.25);
      o.connect(g).connect(chimeCtx.destination);
      o.start(t0 + i * 0.12);
      o.stop(t0 + i * 0.12 + 0.3);
    });
  } catch {
    if (test) showToast('This browser blocked sound.', 'warn');
  }
};

try {
  const saved = localStorage.getItem('odex.cfgSection');
  if (saved) currentCfgSection = saved;
} catch {
  // ignore
}
// (the Settings section is opened by the router from the address)

// ============================================================================
// Linking: one trader filter shared by Positions, Live Signals and History,
// clickable traders / tokens everywhere, and one on-chain balance for the wallet
// ============================================================================
let traderFilter = null; // { wallet, label } or null

function followForWallet(wallet) {
  return engineState?.follows?.find((f) => f.traderWallet === wallet) || null;
}
function followById(id) {
  return engineState?.follows?.find((f) => f.id === id) || null;
}
function traderWalletOf(item) {
  return item?.traderWallet || followById(item?.followId)?.traderWallet || null;
}

function traderLinkHtml(handle, wallet) {
  const w = wallet || followForWallet(wallet)?.traderWallet || null;
  const label = `@${esc(handle || 'trader')}`;
  if (!w) return `<strong>${label}</strong>`;
  return `<button type="button" class="trader-link" onclick="openTrader('${esc(w)}')" title="Open this trader in Copytrades">${label}</button>`;
}

function tokenLinkHtml(symbol, address) {
  const sym = `$${esc(symbol || '?')}`;
  if (!address) return `<strong>${sym}</strong>`;
  return `<a class="token-link" href="https://dexscreener.com/solana/${encodeURIComponent(address)}" target="_blank" rel="noopener" title="Open chart on DexScreener"><strong>${sym}</strong></a>`;
}

/** Click a trader anywhere → their Copytrades card (highlighted). */
window.useRecommendedExits = async function useRecommendedExits(id) {
  const res = await fetch(`/api/follows/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ useRecommendedExits: true }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    showToast(data.error || 'Could not update the exit rules', 'danger');
    return;
  }
  if (data.state) engineState = data.state;
  else await refreshEngineState();
  renderTerminalAll();
  showToast('Recommended exits on: take initials +25%, trail, −45%→−20% floor, wave-cut, 5-min cap.', 'good');
};

window.openTrader = function openTrader(wallet) {
  const f = followForWallet(wallet);
  goTerminalTab('follows');
  setTimeout(() => {
    const el = f && document.querySelector(`.follow-card[data-follow="${f.id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('is-flash');
    setTimeout(() => el.classList.remove('is-flash'), 1600);
  }, 60);
};

/** Show only one trader's positions / signals / history. */
window.filterByTrader = function filterByTrader(wallet, tab) {
  const f = followForWallet(wallet);
  traderFilter = { wallet, label: f ? f.name || f.handle : shortAddr(wallet) };
  goTerminalTab(tab);
  renderTerminalAll();
  if (typeof renderLiveSignals === 'function') renderLiveSignals();
};

window.clearTraderFilter = function clearTraderFilter() {
  traderFilter = null;
  renderTerminalAll();
  if (typeof renderLiveSignals === 'function') renderLiveSignals();
};

function matchesTraderFilter(item) {
  if (!traderFilter) return true;
  return (item?.wallet || traderWalletOf(item)) === traderFilter.wallet;
}

function renderTraderFilterBar() {
  const bar = document.getElementById('trader-filter-bar');
  if (!bar) return;
  if (!traderFilter) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;
  bar.innerHTML = `<span>Showing only <strong>${esc(traderFilter.label)}</strong> <span class="mono muted">${esc(shortAddr(traderFilter.wallet))}</span></span>
    <button type="button" class="btn btn-sm" onclick="clearTraderFilter()">Show all traders</button>`;
}

// ---- on-chain wallet balance (the real SOL + USDC of your address) ----
let chainBalance = null; // { address, sol, usdc, usd, at } or null
let chainBalanceLoading = false;

/** The real Solana address for the active wallet: its own address, else the linked Phantom wallet. */
function walletChainAddress(w = activeWalletObj()) {
  if (w && isRealSolanaAddress(w.solanaAddress)) return w.solanaAddress;
  if (!w || w.active) {
    const ph = phantomAddress();
    if (isRealSolanaAddress(ph)) return ph;
  }
  return null;
}

async function refreshChainBalance(force = false) {
  const addr = walletChainAddress();
  if (!addr) {
    if (chainBalance) {
      chainBalance = null;
      renderBalancesEverywhere();
    }
    return;
  }
  if (chainBalanceLoading) return;
  if (!force && chainBalance?.address === addr && Date.now() - chainBalance.at < 25_000) return;
  chainBalanceLoading = true;
  try {
    const res = await fetch(`/api/external-wallet/balance?address=${encodeURIComponent(addr)}`);
    const data = await res.json();
    if (data.ok) chainBalance = { address: addr, sol: Number(data.sol) || 0, usdc: Number(data.usdc) || 0, usd: Number(data.usd) || 0, at: Date.now() };
    else chainBalance = { address: addr, error: data.error || 'Balance unavailable', sol: null, usdc: null, usd: null, at: Date.now() };
  } catch {
    chainBalance = { address: addr, error: 'Balance unavailable', sol: null, usdc: null, usd: null, at: Date.now() };
  } finally {
    chainBalanceLoading = false;
  }
  if (typeof phantomBalanceSol !== 'undefined' && chainBalance?.address === phantomAddress()) phantomBalanceSol = chainBalance.sol;
  renderBalancesEverywhere();
}

/**
 * Real mode (Paper Trading OFF + bot wallet set up): the money that trades is the bot wallet, so the
 * dashboard balances show it. null in paper mode or before the bot wallet status has loaded.
 */
function botWalletBalance() {
  if (engineState?.settings?.paperTrading !== false) return null;
  const s = window.__botStatus;
  if (!s?.configured || !s.balance) return null;
  const px = engineState?.chains?.solana?.nativePriceUsd || 0;
  const sol = Number(s.balance.sol) || 0;
  const usdc = Number(s.balance.usdc) || 0;
  return { sol, usdc, usd: sol * px + usdc, address: s.address, bot: true };
}

/** Balance for a wallet card: only the address we actually read on-chain. */
function balanceFor(w) {
  const addr = walletChainAddress(w);
  if (addr && chainBalance && chainBalance.address === addr && chainBalance.sol !== null) return chainBalance;
  return null;
}

let lastPaperModeSeen = null;
function renderBalancesEverywhereLite() {
  // switching Paper Trading on/off changes which wallet the balances show: refresh the bot status now
  const paperNow = engineState?.settings?.paperTrading !== false;
  if (lastPaperModeSeen !== null && lastPaperModeSeen !== paperNow && typeof loadBotCardStatus === 'function') loadBotCardStatus(true);
  lastPaperModeSeen = paperNow;
  const b = botWalletBalance() || balanceFor(activeWalletObj());
  const pill = document.getElementById('header-sol-balance');
  if (pill) pill.textContent = b ? `${b.sol.toFixed(b.sol >= 100 ? 1 : 3)} SOL` : walletChainAddress() ? '… SOL' : '0.00 SOL';
  const usdcEl = document.getElementById('hwd-usdc-bal');
  // the big number is SOL; the line under it shows the USD value (+ USDC when the wallet holds any)
  if (usdcEl) usdcEl.textContent = b ? b.sol.toFixed(b.sol >= 100 ? 2 : 3) : '0.00';
  const solEl = document.getElementById('hwd-sol-bal');
  if (solEl) solEl.textContent = b ? `≈ ${formatUsd(b.usd)}${b.usdc > 0 ? ` · ${b.usdc.toFixed(2)} USDC` : ''}` : walletChainAddress() ? 'Reading balance…' : 'No address linked';
  const pb = document.getElementById('paper-bal');
  if (pb) pb.textContent = formatUsd(Number(activeWalletObj()?.paperBalanceUsd ?? 10000));
  if (walletChainAddress() && (!chainBalance || chainBalance.address !== walletChainAddress())) refreshChainBalance();
}

function renderBalancesEverywhere() {
  if (!engineState) return;
  renderBalancesEverywhereLite();
  if (typeof renderWalletsList === 'function') renderWalletsList();
  renderKpiStrip();
}

window.openWalletExplorer = function openWalletExplorer() {
  const addr = walletChainAddress();
  if (!addr) {
    showToast('Link Phantom or add your Solana address first.', 'warn');
    openDepositModal('deposit');
    return;
  }
  window.open(`https://solscan.io/account/${addr}`, '_blank', 'noopener');
};

window.addPaperFunds = async function addPaperFunds(amountUsd, reset = false) {
  const res = await fetch('/api/wallets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'paper-funds', amountUsd, reset }),
  });
  const data = await res.json();
  if (!data.ok) {
    showToast(data.error || 'Could not change the paper balance', 'danger');
    return;
  }
  engineState = data.state;
  renderTerminalAll();
  renderBalancesEverywhere();
  showToast(reset ? 'Paper balance reset to $10,000.' : `Added ${formatUsd(amountUsd)} paper money (not real funds).`, 'good');
};

// ============================================================================
// Exchange modal (Convert / Deposit / Buy) + Phantom wallet linking
// ============================================================================
function isRealSolanaAddress(a) {
  return typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
}
function isRealEvmAddress(a) {
  return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a);
}

function activeWalletObj() {
  const wallets = engineState?.wallets?.filter((w) => !w.archived) || [];
  return wallets.find((w) => w.active) || wallets[0] || null;
}

window.switchExchangeTab = function switchExchangeTab() {
  renderDepositPane();
};

const BNB_ICON = '<svg class="chip-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#bnb-mark"/></svg>';
const SOL_ICON = '<svg class="chip-icon" aria-hidden="true"><use href="#sol-mark"/></svg>';
const USDC_ICON = '<span class="usdc-dot" aria-hidden="true">$</span>';

window.renderDepositPane = function renderDepositPane() {
  const w = activeWalletObj();
  const paper = engineState?.settings?.paperTrading !== false;
  // Only real addresses the user controls: the wallet's own address, else the linked Phantom wallet
  const own = isRealSolanaAddress(w?.solanaAddress) ? w.solanaAddress : null;
  const ph = phantomAddress();
  const addr = own || ph || null;

  const label = document.getElementById('dep-addr-label');
  const text = document.getElementById('dep-addr-text');
  const qr = document.getElementById('dep-qr');
  const hidden = document.getElementById('deposit-sol-addr');
  const card = document.getElementById('dep-card');
  const copyBtn = document.getElementById('btn-copy-address');
  const mini = document.getElementById('dep-copy-mini');
  const setBox = document.getElementById('dep-set');
  const test = document.getElementById('exch-test');
  if (test) test.hidden = !paper;

  if (addr) {
    label.textContent = own ? 'Your SOL deposit address' : `Your ${linkedWallet()?.name || 'Phantom'} wallet · SOL deposit address`;
    text.textContent = addr;
    hidden.value = addr;
    try {
      // Solana Pay URI: wallets that scan it open a "send to this address" screen
      qr.innerHTML = window.OdexQR ? window.OdexQR.toSvg(`solana:${addr}`, { ecc: 'M', border: 2, dark: '#0b0c10', light: '#ffffff' }) : '';
    } catch {
      qr.innerHTML = '';
    }
    qr.insertAdjacentHTML('beforeend', `<span class="exch-qr-badge">${SOL_ICON}</span>`);
    card.classList.remove('is-paper');
    copyBtn.disabled = false;
    mini.disabled = false;
    if (setBox) setBox.hidden = true;
  } else {
    label.textContent = 'No deposit address yet';
    text.textContent = 'Connect Phantom or MetaMask, or paste a Solana address you own. Never send funds until a real address and QR appear here.';
    hidden.value = '';
    qr.innerHTML = `<div class="exch-qr-empty"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h3v3"/></svg><span>No address</span></div>`;
    card.classList.add('is-paper');
    copyBtn.disabled = true;
    mini.disabled = true;
    if (setBox) setBox.hidden = false;
  }
  if (typeof renderPhantom === 'function') renderPhantom();
};

window.saveDepositAddress = async function saveDepositAddress() {
  const input = document.getElementById('dep-set-input');
  const address = (input?.value || '').trim();
  if (!isRealSolanaAddress(address)) {
    showToast('That is not a valid Solana address.', 'danger');
    return;
  }
  const res = await fetch('/api/wallets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-solana-address', walletId: activeWalletObj()?.id, address }),
  });
  const data = await res.json();
  if (!data.ok) {
    showToast(data.error || (res.status === 404 ? 'Restart the server to save addresses.' : 'Could not save the address.'), 'danger');
    return;
  }
  engineState = data.state;
  renderTerminalAll();
  renderDepositPane();
  showToast('Deposit address saved.', 'good');
};


window.openOnramper = function openOnramper() {
  const target = phantomAddress() || (isRealSolanaAddress(activeWalletObj()?.solanaAddress) ? activeWalletObj().solanaAddress : null);
  const params = new URLSearchParams({ defaultCrypto: 'sol', onlyCryptos: 'sol,usdc_sol' });
  if (target) params.set('wallets', `sol:${target}`);
  window.open(`https://buy.onramper.com/?${params.toString()}`, '_blank', 'noopener');
};

// ---------------------------------------------------------------------------
// Phantom (browser extension / in-app browser). Read-only link: we only ask for
// the public key. No transaction is ever requested from the wallet.
// ---------------------------------------------------------------------------
let phantomBalanceSol = null;
let phantomListenersBound = false;

/** Clear message for a wallet-extension error (they often only say "Unexpected error"). */
function walletErrorMessage(err, name) {
  const code = err?.code ?? err?.error?.code;
  const raw = String(err?.message || err?.error?.message || err || '');
  try {
    console.warn(`[odex] ${name} error`, code, raw, err);
  } catch {
    // console unavailable
  }
  if (code === 4001 || /reject|denied|declin|cancel/i.test(raw)) return `You declined the request in ${name} — nothing happened.`;
  if (code === -32002 || /already pending|already processing/i.test(raw)) return `A ${name} request is already open — click the ${name} icon in Chrome's toolbar to finish it.`;
  if (code === 4100 || /unauthori[sz]ed|not connected/i.test(raw)) return `${name} hasn't approved this site yet — press Connect ${name} again and approve it.`;
  if (code === -32603 || /unexpected error|internal error/i.test(raw)) {
    return `${name} reported "Unexpected error". Unlock ${name}, make sure it has a Solana account${name === 'MetaMask' ? ' (MetaMask → account menu → Add account → Solana)' : ''}, then reload this page and try again.`;
  }
  return `${name}: ${raw || 'request failed'}${code !== undefined ? ` (code ${code})` : ''}`;
}

/** Phantom connect, with one retry: a stale session in the extension answers "Unexpected error". */
async function phantomConnectWithRetry(provider, opts) {
  try {
    return await provider.connect(opts);
  } catch (err) {
    const code = err?.code;
    if (code === 4001 || !(code === -32603 || /unexpected|internal/i.test(String(err?.message || '')))) throw err;
    try {
      await provider.disconnect();
    } catch {
      // already disconnected
    }
    await new Promise((r) => setTimeout(r, 400));
    return provider.connect(opts);
  }
}

/** Phantom's Chrome extension injects its provider shortly after page load; wait for it briefly. */
async function waitForPhantom(ms = 2500) {
  const start = Date.now();
  let p = getPhantomProvider();
  while (!p && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 100));
    p = getPhantomProvider();
  }
  return p;
}

function getPhantomProvider() {
  const p = window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
  return p && p.isPhantom ? p : null;
}

/** The linked browser wallet (Phantom or MetaMask), or null. Only one is linked at a time. */
function linkedWallet() {
  const ew = engineState?.settings?.externalWallets || {};
  if (ew.phantom?.address) return { provider: 'phantom', name: 'Phantom', address: ew.phantom.address };
  if (ew.metamask?.address) return { provider: 'metamask', name: 'MetaMask', address: ew.metamask.address };
  return null;
}
/** Address of the linked wallet (Phantom or MetaMask): deposit address, balance, Onramper. */
function phantomAddress() {
  return linkedWallet()?.address || null;
}

async function saveExternalWallet(action, address, provider = 'phantom') {
  const res = await fetch('/api/wallets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, provider, address }),
  });
  const data = await res.json();
  if (data.state) {
    engineState = data.state;
    renderTerminalAll();
  }
  return data;
}

async function refreshPhantomBalance() {
  const addr = phantomAddress();
  if (!addr) return;
  try {
    const res = await fetch(`/api/external-wallet/balance?address=${encodeURIComponent(addr)}`);
    const data = await res.json();
    phantomBalanceSol = data.ok ? data.sol : null;
  } catch {
    phantomBalanceSol = null;
  }
  renderPhantom();
}

function bindPhantomEvents(provider) {
  if (phantomListenersBound || !provider?.on) return;
  phantomListenersBound = true;
  provider.on('accountChanged', async (pk) => {
    if (pk) {
      await saveExternalWallet('link-external', pk.toString());
      showToast('Phantom account switched', 'good');
      refreshPhantomBalance();
    }
  });
  provider.on('disconnect', () => renderPhantom());
}

window.phantomButtonClick = async function phantomButtonClick() {
  if (linkedWallet()?.provider === 'phantom') return disconnectPhantom();
  return connectPhantom();
};

window.connectPhantom = async function connectPhantom() {
  const btn0 = document.getElementById('btn-phantom');
  if (btn0) btn0.disabled = true;
  const provider = await waitForPhantom();
  if (btn0) btn0.disabled = false;
  if (!provider) {
    phantomNotFound();
    return;
  }
  const btn = document.getElementById('btn-phantom');
  if (btn) btn.disabled = true;
  try {
    const resp = await phantomConnectWithRetry(provider);
    const address = (resp?.publicKey || provider.publicKey)?.toString();
    if (!isRealSolanaAddress(address)) throw new Error('Phantom did not return a Solana address');
    const data = await saveExternalWallet('link-external', address);
    if (!data.ok) throw new Error(data.error || 'Could not link Phantom');
    bindPhantomEvents(provider);
    showToast(`Phantom linked · ${shortAddr(address)}`, 'good');
    refreshPhantomBalance();
  } catch (err) {
    showToast(walletErrorMessage(err, 'Phantom'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.disconnectPhantom = async function disconnectPhantom() {
  try {
    await getPhantomProvider()?.disconnect?.();
  } catch {
    // extension may already be disconnected
  }
  phantomBalanceSol = null;
  await saveExternalWallet('unlink-external', null, 'phantom');
  showToast('Phantom unlinked', 'good');
};

window.watchPhantomInSignals = async function watchPhantomInSignals() {
  const addr = phantomAddress();
  if (!addr) return;
  closeModal('modal-deposit');
  goTerminalTab('signals');
  document.getElementById('watch-add-address').value = addr;
  document.getElementById('watch-add-label').value = 'My Phantom';
  await addWatchWallet();
};

function renderPhantom() {
  const lw = linkedWallet();
  const addr = lw?.address || null;
  const label = document.getElementById('btn-phantom-label');
  const btn = document.getElementById('btn-phantom');
  const box = document.getElementById('phantom-linked');
  const isPh = lw?.provider === 'phantom';
  const isMm = lw?.provider === 'metamask';
  if (label) label.textContent = isPh ? 'Disconnect Phantom' : 'Connect Phantom';
  if (btn) btn.classList.toggle('is-linked', isPh);
  const mmLabel = document.getElementById('btn-metamask-label');
  const mmBtn = document.getElementById('btn-metamask');
  if (mmLabel) mmLabel.textContent = isMm ? 'Disconnect MetaMask' : 'Connect MetaMask';
  if (mmBtn) mmBtn.classList.toggle('is-linked', isMm);
  const sendBtn = document.getElementById('btn-phantom-send');
  if (sendBtn) sendBtn.textContent = `Send from ${isMm ? 'MetaMask' : 'Phantom'}`;
  const fundTitle = document.querySelector('#phantom-fund .phantom-fund-head strong');
  if (fundTitle) fundTitle.textContent = `Fund the bot wallet from ${isMm ? 'MetaMask' : 'Phantom'}`;
  if (box) {
    box.hidden = !addr;
    if (addr) {
      box.innerHTML = `
        <span class="ws-dot"></span>
        <div class="phantom-linked-main">
          <strong>${esc(lw.name)} linked</strong>
          <span class="mono" title="${esc(addr)}">${esc(shortAddr(addr, 6, 6))}${phantomBalanceSol !== null ? ` · ${Number(phantomBalanceSol).toFixed(4)} SOL` : ''}</span>
        </div>
        <button class="btn btn-sm" onclick="watchPhantomInSignals()" title="Show this wallet's real trades in Live Signals">Watch</button>`;
    }
  }
  // Header wallet dropdown row
  const row = document.getElementById('hwd-phantom');
  if (row) {
    row.innerHTML = addr
      ? `<span class="hwd-bal-lbl">${esc(lw.name)}</span><span class="hwd-bal-num mono" title="${esc(addr)}">${esc(shortAddr(addr))}${phantomBalanceSol !== null ? ` · ${Number(phantomBalanceSol).toFixed(3)} SOL` : ''}</span>`
      : `<span class="hwd-bal-lbl">Phantom</span><button class="link-btn" onclick="toggleHeaderWalletDropdown(); openDepositModal('deposit')">Connect</button>`;
  }
}

// Re-link silently if the user already trusted this site in Phantom
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(async () => {
    renderPhantom();
    const provider = await waitForPhantom(4000);
    if (!provider) return;
    bindPhantomEvents(provider);
    if (linkedWallet()?.provider === 'phantom') {
      try {
        await provider.connect({ onlyIfTrusted: true });
      } catch {
        // not trusted yet — keep the saved link, user can reconnect
      }
      refreshPhantomBalance();
    }
  }, 600);
});

// ============================================================================
// Database (Data & storage card in Settings)
// ============================================================================
function formatBytes(n) {
  const v = Number(n || 0);
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

const SUPABASE_SQL_FALLBACK = `create table if not exists public.odex_kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.odex_kv enable row level security;`;

function renderSupabase(sb) {
  const pill = document.getElementById('sbc-pill');
  const connected = document.getElementById('sbc-connected');
  const form = document.getElementById('sbc-form');
  const sqlEl = document.getElementById('sbc-sql-text');
  if (sqlEl && !sqlEl.textContent) sqlEl.textContent = sb?.setupSql || SUPABASE_SQL_FALLBACK;
  if (!pill) return;
  const on = Boolean(sb?.configured);
  const bad = on && sb.lastError && (!sb.lastSyncAt || sb.lastErrorAt > sb.lastSyncAt);
  pill.textContent = !on ? 'Not connected' : bad ? 'Sync problem' : 'Connected';
  pill.className = `sbc-pill ${!on ? '' : bad ? 'is-bad' : 'is-on'}`;
  connected.hidden = !on;
  form.hidden = on;
  if (on) {
    document.getElementById('sbc-host').textContent = sb.host || '—';
    document.getElementById('sbc-table').textContent = sb.table || 'odex_kv';
    document.getElementById('sbc-key').textContent = sb.keyMasked || '—';
    document.getElementById('sbc-sync').textContent = sb.lastSyncAt ? timeAgo(sb.lastSyncAt) : 'pending';
    const sub = document.getElementById('sbc-sub');
    if (sub) sub.textContent = bad ? sb.lastError : 'Every save is copied to Supabase (at most every 5 seconds) and on shutdown.';
  }
}

window.supabaseConnect = async function supabaseConnect() {
  const url = document.getElementById('sbc-url').value.trim();
  const key = document.getElementById('sbc-secret').value.trim();
  const res = await fetch('/api/db/supabase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, key }) });
  const data = res.status === 404 ? { ok: false, error: 'Restart the server to enable Supabase.' } : await res.json();
  if (!data.ok) {
    if (data.tableMissing) document.querySelector('.sbc-sql')?.setAttribute('open', '');
    showToast(data.error || 'Could not connect to Supabase.', 'danger');
    return;
  }
  document.getElementById('sbc-secret').value = '';
  renderSupabase(data);
  showToast(data.pushed ? 'Supabase connected. Your data is backed up.' : 'Supabase connected.', 'good');
};

window.supabaseSyncNow = async function supabaseSyncNow() {
  const data = await (await fetch('/api/db/supabase/sync', { method: 'POST' })).json();
  renderSupabase(data);
  showToast(data.ok ? 'Synced to Supabase.' : data.error || 'Sync failed.', data.ok ? 'good' : 'danger');
};

window.supabaseRestore = async function supabaseRestore() {
  const ok = await confirmAction({
    title: 'Restore from Supabase?',
    message: 'This replaces your current follows, positions, history and settings with the copy saved in Supabase.',
    confirmLabel: 'Restore',
    tone: 'danger',
  });
  if (!ok) return;
  const data = await (await fetch('/api/db/supabase/restore', { method: 'POST' })).json();
  if (!data.ok) {
    showToast(data.error || 'Restore failed.', 'danger');
    return;
  }
  engineState = data.state;
  renderTerminalAll();
  loadDatabaseInfo();
  showToast(`Restored from Supabase: ${data.restored?.follows ?? 0} follows, ${data.restored?.history ?? 0} history entries.`, 'good');
};

window.supabaseDisconnect = async function supabaseDisconnect() {
  const ok = await confirmAction({ title: 'Disconnect Supabase?', message: 'Backups to Supabase stop and the key is removed from the server. Data already in Supabase stays there.', confirmLabel: 'Disconnect', tone: 'danger' });
  if (!ok) return;
  const data = await (await fetch('/api/db/supabase/disconnect', { method: 'POST' })).json();
  renderSupabase(data);
  showToast('Supabase disconnected.', 'good');
};

window.copySupabaseSql = async function copySupabaseSql() {
  try {
    await navigator.clipboard.writeText(document.getElementById('sbc-sql-text').textContent);
    showToast('SQL copied. Paste it into Supabase → SQL editor and run it.', 'good');
  } catch {
    showToast('Could not copy.', 'warn');
  }
};

window.loadDatabaseInfo = async function loadDatabaseInfo() {
  let info;
  try {
    info = await (await fetch('/api/db')).json();
  } catch {
    return;
  }
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  const hint = document.getElementById('db-hint');
  if (!info.ok || info.enabled === false || !info.engine) {
    set('db-engine', info.enabled === false ? 'Off' : 'Unavailable');
    if (hint) hint.textContent = info.enabled === false
      ? 'Running in memory only (ODEX_DB=off). Data is lost when the server stops.'
      : 'Restart the server to enable the database.';
    return;
  }
  if (info.cloud !== undefined) renderSupabase(info.cloud);
  else fetch('/api/db/supabase').then((r) => (r.ok ? r.json() : null)).then((sb) => sb && renderSupabase(sb)).catch(() => {});
  set('db-engine', info.engine === 'sqlite' ? 'SQLite (built into Node)' : 'JSON file');
  const file = String(info.file || '').split(/[\\/]/).slice(-2).join('/');
  set('db-file', file || '—');
  set('db-size', formatBytes(info.sizeBytes));
  set('db-saved', info.lastSavedAt ? timeAgo(info.lastSavedAt) : 'not yet');
  const c = info.counts || {};
  set('db-counts', `${c.follows ?? 0} follows · ${c.openPositions ?? 0} open · ${c.history ?? 0} history · ${c.signals ?? 0} signals`);
  if (hint) {
    hint.textContent = info.lastError
      ? info.lastError
      : info.engine === 'json'
        ? 'Using a JSON file because this Node version has no built-in SQLite (needs Node 22.5+). Everything still persists.'
        : 'Saved within a second of each change and again when the server stops. Your Alchemy key is never stored here.';
    hint.classList.toggle('pos-warn', Boolean(info.lastError));
  }
};

window.saveDatabaseNow = async function saveDatabaseNow() {
  const res = await fetch('/api/db/save', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (data.ok) showToast('Saved to database', 'good');
  else showToast(data.error || data.lastError || 'Save failed (restart the server to enable the database)', 'danger');
  loadDatabaseInfo();
};

window.restoreDatabaseBackup = async function restoreDatabaseBackup(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    showToast('That file is not valid JSON', 'danger');
    return;
  }
  const ok = await confirmAction({
    title: 'Restore this backup?',
    message: `Replaces current follows, positions, history, wallets and settings with the backup from ${backup?.exportedAt ? new Date(backup.exportedAt).toLocaleString() : 'this file'}.`,
    confirmLabel: 'Restore',
    danger: true,
  });
  if (!ok) return;
  const res = await fetch('/api/db/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup) });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) return showToast(data.error || 'Restore failed', 'danger');
  engineState = data.state;
  renderTerminalAll();
  populateSettingsInputs();
  loadLiveSignals();
  loadDatabaseInfo();
  showToast(`Backup restored · ${data.restored?.follows ?? 0} follows, ${data.restored?.history ?? 0} history entries`, 'good');
};

window.addEventListener('DOMContentLoaded', () => {
  loadDatabaseInfo();
  setInterval(() => {
    if (document.getElementById('term-config')?.classList.contains('active') && currentCfgSection === 'data') loadDatabaseInfo();
  }, 5000);
});

// ============================================================================
// Login (development): any email / 10-digit PIN, or empty, continues
// ============================================================================
const SESSION_KEY = 'odex.session';
let memorySession = null; // used when browser storage is unavailable

function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // storage blocked: fall back to this page load only
  }
  return memorySession;
}

function setSession(sess) {
  memorySession = sess;
  try {
    if (sess) localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

function showLogin(show) {
  const scr = document.getElementById('login-screen');
  if (!scr) return;
  scr.hidden = !show;
  document.body.classList.toggle('logged-out', show);
  if (show) setTimeout(() => document.getElementById('login-input')?.focus(), 50);
  renderSessionInfo();
  if (typeof syncUrl === 'function') syncUrl();
}

function renderSessionInfo() {
  const s = getSession();
  const el = document.getElementById('cfg-session');
  if (el) el.textContent = s ? (s.id === 'developer' ? 'Developer (no sign-in)' : s.id) : '—';
}

function loginMsg(text, bad = true) {
  const m = document.getElementById('login-msg');
  if (!m) return;
  m.textContent = text || '';
  m.classList.toggle('is-bad', Boolean(text) && bad);
}

window.loginContinue = function loginContinue() {
  const v = (document.getElementById('login-input')?.value || '').trim();
  let method = 'dev';
  if (v) {
    if (/^\d{10}$/.test(v.replace(/\s/g, ''))) method = 'pin';
    else if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) method = 'email';
    else {
      loginMsg('Enter an email address or a 10-digit PIN, or leave it empty to continue.');
      return;
    }
  }
  const id = method === 'pin' ? `PIN ••••••${v.replace(/\s/g, '').slice(-4)}` : v || 'developer';
  setSession({ id, method, at: Date.now() });
  loginMsg('');
  showLogin(false);
  // back to the page that was asked for (e.g. /settings/security), else the start page
  const next = nextAfterLogin && !/^\/login/.test(nextAfterLogin) ? nextAfterLogin : '/';
  nextAfterLogin = null;
  openedAtRoot = next === '/';
  landingApplied = false;
  applyRoute(next, true);
  applyUiSettings();
  showToast(method === 'dev' ? 'Welcome. Development mode: no sign-in needed yet.' : `Signed in as ${id} (development: not verified).`, 'good');
  // first visit with an email and no display name yet: use the part before @
  if (method === 'email' && engineState && !engineState.settings?.ui?.displayName) {
    fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui: { displayName: v.split('@')[0].slice(0, 32) } }) })
      .then((r) => r.json())
      .then((d) => {
        if (d.state) {
          engineState = d.state;
          renderTerminalAll();
        }
      })
      .catch(() => {});
  }
};

window.loginProvider = function loginProvider(name) {
  loginMsg(`${name} sign-in isn't connected yet in this development build. Use Continue below.`, false);
  document.getElementById('login-input')?.focus();
};

window.loginPinMode = function loginPinMode() {
  const i = document.getElementById('login-input');
  if (!i) return;
  i.placeholder = '10-digit PIN';
  i.inputMode = 'numeric';
  i.autocomplete = 'one-time-code';
  i.value = '';
  loginMsg('');
  i.focus();
};

window.logout = async function logout() {
  const ok = await confirmAction({ title: 'Sign out?', message: 'You will see the login page again. Copying keeps running on the server.', confirmLabel: 'Sign out', danger: false });
  if (!ok) return;
  setSession(null);
  const i = document.getElementById('login-input');
  if (i) {
    i.value = '';
    i.placeholder = 'Email address or 10-digit PIN';
    i.inputMode = 'text';
  }
  showLogin(true);
};


// ============================================================================
// Addresses: only /login and /settings. Everything else (tabs, wallets, history,
// docs) lives at / so the address bar stays clean. Old links (/closed, /settings/profile…)
// still open the right place, then the address is tidied to / or /settings.
// ============================================================================
const TERMINAL_ROUTES = ['positions', 'closed', 'signals', 'wallets', 'history'];
const SETTINGS_ROUTES = ['copytrades', 'trading', 'data', 'profile', 'security', 'notifications'];
let routeApplying = false;
let nextAfterLogin = null;
let openedAtRoot = location.pathname === '/' || location.pathname === '';
let lastHomeTab = 'positions';

function pathForState() {
  if (!getSession()) return '/login';
  if (document.getElementById('view-dax')?.classList.contains('active')) return '/dax';
  if (currentTermTab === 'config' && !document.getElementById('view-docs')?.classList.contains('active')) return '/settings';
  return '/';
}

function setTitle(p) {
  const key = p.split('?')[0].split('/').filter(Boolean)[0] || '';
  document.title = key === 'login' ? 'Log in · Odex Mirror' : key === 'settings' ? 'Settings · Odex Mirror' : key === 'dax' ? 'Dax · Odex Mirror' : 'Odex Mirror';
}

function syncUrl(replace = false) {
  if (routeApplying) return;
  if (currentTermTab && currentTermTab !== 'config') lastHomeTab = currentTermTab;
  let p = pathForState();
  if (p === '/login' && nextAfterLogin && nextAfterLogin !== '/') p += `?next=${encodeURIComponent(nextAfterLogin)}`;
  setTitle(p);
  if (location.pathname + location.search === p) return;
  try {
    // into or out of Settings is a step Back can undo; the login page replaces
    history[replace || p.startsWith('/login') ? 'replaceState' : 'pushState']({}, '', p);
  } catch {
    // some embedded previews block history changes
  }
}

/** Show the page for an address. */
function applyRoute(pathname, push = false) {
  const clean = (pathname || '/').split('?')[0].replace(/\/+$/, '') || '/';
  const [a, b] = clean.split('/').filter(Boolean);
  if (!getSession()) {
    if (a !== 'login') nextAfterLogin = clean;
    else {
      const q = new URLSearchParams(location.search).get('next');
      if (q && q.startsWith('/') && !q.startsWith('//')) nextAfterLogin = q;
    }
    routeApplying = true;
    showLogin(true);
    routeApplying = false;
    syncUrl(true);
    return;
  }
  routeApplying = true;
  try {
    showLogin(false);
    if (a === 'settings') {
      goTerminalTab('config');
      openSettingsSection(SETTINGS_ROUTES.includes(b) ? b : currentCfgSection);
    } else if (a === 'copytrades' || a === 'copytrade' || a === 'follows') {
      goTerminalTab('config');
      openSettingsSection('copytrades');
    } else if (TERMINAL_ROUTES.includes(a)) goTerminalTab(a); // old link
    else if (a === 'docs') switchMainView('docs'); // old link
    else if (a === 'dax') openDax();
    else goTerminalTab(lastHomeTab || 'positions'); // "/" (Back from Settings returns to the tab you were on)
  } finally {
    routeApplying = false;
  }
  syncUrl(true);
}

window.addEventListener('popstate', () => applyRoute(location.pathname));
applyRoute(location.pathname);

// ============================================================================
// PnL calendar: realized PnL per day (paper or real), from the server's sell log
// ============================================================================
const pnlCal = { year: null, month: null, mode: 'paper', best: false, currency: 'usd', data: null };

window.openPnlCalendar = function openPnlCalendar() {
  const now = new Date();
  if (!pnlCal.year) {
    pnlCal.year = uiPrefs().timeZone === 'utc' ? now.getUTCFullYear() : now.getFullYear();
    pnlCal.month = (uiPrefs().timeZone === 'utc' ? now.getUTCMonth() : now.getMonth()) + 1;
    pnlCal.mode = engineState?.settings?.paperTrading === false ? 'real' : 'paper';
  }
  document.getElementById('modal-pnl-calendar')?.classList.add('open');
  loadPnlCalendar();
};

window.setPnlCalMode = function setPnlCalMode(mode) {
  pnlCal.mode = mode === 'real' ? 'real' : 'paper';
  loadPnlCalendar();
};

window.togglePnlCalCurrency = function togglePnlCalCurrency() {
  pnlCal.currency = pnlCal.currency === 'sol' ? 'usd' : 'sol';
  renderPnlCalendar();
};

window.shiftPnlCal = function shiftPnlCal(d) {
  let m = pnlCal.month + d;
  let y = pnlCal.year;
  if (m < 1) {
    m = 12;
    y -= 1;
  } else if (m > 12) {
    m = 1;
    y += 1;
  }
  pnlCal.year = y;
  pnlCal.month = m;
  loadPnlCalendar();
};

window.pnlCalToday = function pnlCalToday() {
  pnlCal.year = null;
  openPnlCalendar();
};

window.togglePnlBest = function togglePnlBest() {
  pnlCal.best = !pnlCal.best;
  renderPnlCalendar();
};

async function loadPnlCalendar() {
  const tz = uiPrefs().timeZone === 'utc' ? 0 : new Date(pnlCal.year, pnlCal.month - 1, 15).getTimezoneOffset();
  renderPnlCalendar(true);
  try {
    const r = await fetch(`/api/pnl/calendar?year=${pnlCal.year}&month=${pnlCal.month}&tz=${tz}&mode=${pnlCal.mode}`);
    const d = await r.json();
    pnlCal.data = d.ok ? d : null;
  } catch {
    pnlCal.data = null;
  }
  renderPnlCalendar();
}

/** Short day amount for narrow screens: −$6.2, +$48, +$1.2K. */
function pnlCalShort(v) {
  const a = Math.abs(v);
  const sign = v < 0 ? '\u2212' : '+';
  const body = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a.toFixed(2);
  return `${sign}$${body.replace(/\.0([KM]?)$/, '$1')}`;
}

function fmtCalSol(v) {
  const a = Math.abs(v);
  if (!a) return '0.00';
  if (a >= 100) return a.toFixed(1);
  if (a >= 1) return a.toFixed(2);
  if (a >= 0.01) return a.toFixed(3);
  return a.toFixed(4);
}

function signedCalSol(v) {
  if (!v) return '0.00 SOL';
  const sign = v < 0 ? '\u2212' : '+';
  return `${sign}${fmtCalSol(v)} SOL`;
}

function pnlCalShortSol(v) {
  if (!v) return '0 SOL';
  const a = Math.abs(v);
  const sign = v < 0 ? '\u2212' : '+';
  const body = a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a.toFixed(2);
  return `${sign}${body} SOL`;
}

function renderPnlCalendar(loading = false) {
  const { year, month, mode, best, currency = 'usd' } = pnlCal;
  if (!year) return;
  const d = loading ? null : pnlCal.data;
  const isSol = currency === 'sol';
  const solPrice = Number(engineState?.chains?.solana?.nativePriceUsd) || 108.45;

  document.querySelectorAll('.pnlc-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  document.getElementById('pnlc-month').textContent = label;
  document.getElementById('pnlc-best-btn').classList.toggle('active', best);

  const curBtn = document.getElementById('pnlc-cur-btn');
  if (curBtn) {
    const usdEl = curBtn.querySelector('.cur-usd');
    const solEl = curBtn.querySelector('.cur-sol');
    if (usdEl && solEl) {
      usdEl.classList.toggle('active', !isSol);
      solEl.classList.toggle('active', isSol);
    }
    curBtn.title = isSol ? 'Current: SOL (click to switch to USD)' : 'Current: USD (click to switch to SOL)';
  }

  const total = d?.total ?? 0;
  const tot = document.getElementById('pnlc-total');
  const totalStr = isSol
    ? (total ? signedCalSol(total / solPrice) : '0.00 SOL')
    : (total ? signedUsd(total) : '$0.00');
  tot.innerHTML = `Total PnL for the month: <strong class="${total > 0 ? 'pos-up' : total < 0 ? 'pos-down' : ''}">${totalStr}</strong>`;

  const w = d?.wins || { count: 0, usd: 0 };
  const l = d?.losses || { count: 0, usd: 0 };
  const winValStr = isSol
    ? (w.usd ? `${fmtCalSol(w.usd / solPrice)} SOL` : '0.00 SOL')
    : formatUsd(w.usd);
  const lossValStr = isSol
    ? (l.usd ? `${fmtCalSol(Math.abs(l.usd) / solPrice)} SOL` : '0.00 SOL')
    : formatUsd(Math.abs(l.usd));

  document.getElementById('pnlc-wins').textContent = `${w.count} / ${winValStr}`;
  document.getElementById('pnlc-losses').textContent = `${l.count} / ${lossValStr}`;
  const sum = w.usd + Math.abs(l.usd);
  document.getElementById('pnlc-bar-w').style.width = sum ? `${(w.usd / sum) * 100}%` : '0%';
  document.getElementById('pnlc-bar-l').style.width = sum ? `${(Math.abs(l.usd) / sum) * 100}%` : '0%';

  const firstDow = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
  const daysIn = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const now = new Date();
  const utc = uiPrefs().timeZone === 'utc';
  const todayKey = utc ? `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}` : `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  let html = '';
  for (let i = 0; i < firstDow; i++) html += '<div class="pnlc-cell is-pad"></div>';
  for (let day = 1; day <= daysIn; day++) {
    const c = d?.days?.[day];
    const v = c?.pnl || 0;
    const tone = v > 0 ? 'is-up' : v < 0 ? 'is-down' : '';
    const mark = best && d?.best?.day === day ? ' is-best' : ''; // trophy highlights the best day only
    const isToday = `${year}-${month}-${day}` === todayKey ? ' is-today' : '';
    const vSol = v ? v / solPrice : 0;
    const valDisplay = isSol ? (v ? signedCalSol(vSol) : '0.00 SOL') : (v ? signedUsd(v) : '$0.00');
    const valShortDisplay = isSol ? (v ? pnlCalShortSol(vSol) : '0 SOL') : (v ? pnlCalShort(v) : '$0');
    const pnlTip = isSol ? (v ? signedCalSol(vSol) : '0.00 SOL') : (v ? signedUsd(v) : '$0.00');
    const tip = c ? `${c.trades} sell${c.trades === 1 ? '' : 's'} · ${c.wins} win${c.wins === 1 ? '' : 's'}, ${c.losses} loss${c.losses === 1 ? '' : 'es'} (${pnlTip})` : 'No sells';
    html += `<div class="pnlc-cell ${tone}${mark}${isToday}" title="${tip}"><span class="pnlc-day">${day}</span><span class="pnlc-val">${valDisplay}</span><span class="pnlc-val-s">${valShortDisplay}</span>${c?.trades ? `<span class="pnlc-n">${c.trades}</span>` : ''}</div>`;
  }
  document.getElementById('pnlc-grid').innerHTML = html;
  const note = document.getElementById('pnlc-note');
  if (note) {
    const bestStr = d?.best ? (isSol ? signedCalSol(d.best.pnl / solPrice) : signedUsd(d.best.pnl)) : '';
    const worstStr = d?.worst ? (isSol ? signedCalSol(d.worst.pnl / solPrice) : signedUsd(d.worst.pnl)) : '';

    note.textContent = loading
      ? 'Loading…'
      : best && d?.best
        ? `Best day: ${d.best.day} ${label.split(' ')[0]} (${bestStr})`
        : mode === 'real'
          ? (isSol ? 'Real trading isn\'t switched on yet, so real-SOL results stay at 0.00 SOL until it is.' : 'Real trading isn\'t switched on yet, so real-SOL results stay at $0 until it is.')
          : `Realized PnL from paper sells, by day (${utc ? 'UTC' : 'your time zone'}).`;
  }
}

// Real-trading panel: load once on start, then keep it fresh while Settings is open
setTimeout(() => window.refreshRealPanel?.(), 1500);
setInterval(() => {
  const card = document.getElementById('real-trading-card');
  if (card && card.offsetParent !== null) window.refreshRealPanel?.();
}, 20_000);


// ---------------------------------------------------------------------------
// Phantom: no extension (open in the Phantom app on phones / install on desktop),
// and funding the real-trading bot wallet with a SOL transfer Phantom signs and sends.
// The site never sees a private key: Phantom shows the exact transfer for approval.
// ---------------------------------------------------------------------------
function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}

function phantomNotFound() {
  if (isMobileDevice()) {
    // Phones have no extensions: reopen this page inside the Phantom app's browser
    showToast('Opening this page in the Phantom app…', 'good');
    window.location.href = `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;
    return;
  }
  showToast('Phantom extension not found in this browser. Install it from phantom.com (opened in a new tab), then reload this page.', 'warn');
  window.open('https://phantom.com/download', '_blank', 'noopener');
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}
function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58_ALPHABET.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of str) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
function pubkeyBytes(addr) {
  const b = b58decode(addr);
  if (b.length !== 32) throw new Error('not a Solana address');
  return b;
}

/** Legacy transaction message: one System Program transfer of `lamports` from → to. */
function buildSolTransferMessage(from, to, lamports, blockhash) {
  const SYSTEM = new Uint8Array(32); // 11111111111111111111111111111111
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true); // Transfer
  dv.setBigUint64(4, BigInt(lamports), true);
  const parts = [
    Uint8Array.from([1, 0, 1]), // 1 signer (payer), 0 read-only signers, 1 read-only account (System Program)
    Uint8Array.from([3]), pubkeyBytes(from), pubkeyBytes(to), SYSTEM,
    pubkeyBytes(blockhash),
    Uint8Array.from([1, 2, 2, 0, 1, 12]), // 1 instruction: program #2, accounts [0, 1], 12 bytes of data
    data,
  ];
  const len = parts.reduce((a, p) => a + p.length, 0);
  const msg = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    msg.set(p, o);
    o += p.length;
  }
  return msg;
}

let botWalletInfo = null; // { address, at }
async function loadBotWallet(force = false) {
  if (!force && botWalletInfo && Date.now() - botWalletInfo.at < 30_000) return botWalletInfo.address;
  try {
    const r = await fetch('/api/real/status');
    const d = await r.json();
    botWalletInfo = { address: d.ok && d.configured && isRealSolanaAddress(d.address) ? d.address : null, at: Date.now() };
  } catch {
    botWalletInfo = { address: null, at: Date.now() };
  }
  return botWalletInfo.address;
}

function fundMsg(text, kind = '') {
  const el = document.getElementById('phantom-fund-msg');
  if (!el) return;
  el.className = `phantom-fund-msg${kind ? ` is-${kind}` : ''}`;
  el.innerHTML = text;
}

async function renderPhantomFund() {
  const box = document.getElementById('phantom-fund');
  if (!box) return;
  const bot = await loadBotWallet();
  box.hidden = !bot;
  if (!bot) return;
  const lbl = document.getElementById('phantom-fund-bot');
  lbl.textContent = `Bot ${shortAddr(bot, 4, 4)}`;
  lbl.title = bot;
}

{
  const baseRenderDeposit = window.renderDepositPane;
  window.renderDepositPane = function renderDepositPaneWithFund() {
    baseRenderDeposit();
    renderPhantomFund();
  };
}

window.phantomFundMax = async function phantomFundMax() {
  const addr = phantomAddress();
  if (!addr) return showToast('Connect Phantom first.', 'warn');
  await refreshPhantomBalance();
  if (phantomBalanceSol === null) return showToast('Could not read your Phantom balance.', 'danger');
  // keep a little SOL in Phantom for the network fee
  const max = Math.max(0, Math.floor((phantomBalanceSol - 0.001) * 1e4) / 1e4);
  document.getElementById('phantom-fund-amt').value = max > 0 ? String(max) : '';
};

let phantomSendBusy = false;
window.sendSolFromPhantom = async function sendSolFromPhantom() {
  if (phantomSendBusy) return;
  if (linkedWallet()?.provider === 'metamask') return sendSolFromMetaMask();
  const amt = Number(document.getElementById('phantom-fund-amt')?.value);
  if (!(amt > 0)) return fundMsg('Enter how much SOL to send.', 'bad');
  const btn = document.getElementById('btn-phantom-send');
  phantomSendBusy = true;
  if (btn) btn.disabled = true;
  try {
    const bot = await loadBotWallet(true);
    if (!bot) throw new Error('The bot wallet is not set up (ODEX_TRADER_KEY in .env).');
    const provider = await waitForPhantom();
    if (!provider) {
      phantomNotFound();
      return;
    }
    fundMsg('Waiting for Phantom…');
    const resp = await phantomConnectWithRetry(provider);
    const from = (resp?.publicKey || provider.publicKey)?.toString();
    if (!isRealSolanaAddress(from)) throw new Error('Phantom did not return a Solana address');
    if (from === bot) throw new Error('This Phantom account is the bot wallet itself.');
    if (phantomAddress() !== from) {
      await saveExternalWallet('link-external', from);
      bindPhantomEvents(provider);
    }
    // enough SOL? (amount + ~0.000005 SOL network fee)
    const balRes = await fetch(`/api/external-wallet/balance?address=${encodeURIComponent(from)}`).then((r) => r.json()).catch(() => null);
    if (balRes?.ok && balRes.sol < amt + 0.00001) throw new Error(`Phantom has ${Number(balRes.sol).toFixed(4)} SOL — not enough to send ${amt} SOL plus the network fee.`);
    const bh = await fetch('/api/solana/blockhash').then((r) => r.json());
    if (!bh?.ok) throw new Error(bh?.error || 'Could not reach the Solana network.');
    const lamports = Math.round(amt * 1e9);
    const message = buildSolTransferMessage(from, bot, lamports, bh.blockhash);
    fundMsg(`Approve sending <strong>${amt} SOL</strong> to the bot wallet in Phantom…`);
    const out = await provider.request({ method: 'signAndSendTransaction', params: { message: b58encode(message) } });
    const sig = out?.signature || out?.publicKey || null;
    if (!sig) throw new Error('Phantom did not return a transaction id.');
    const link = `<a href="https://solscan.io/tx/${encodeURIComponent(sig)}" target="_blank" rel="noopener">Solscan</a>`;
    fundMsg(`Sent — confirming on-chain… (${link})`);
    let status = 'pending';
    for (let i = 0; i < 30 && status === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await fetch(`/api/solana/tx-status?sig=${encodeURIComponent(sig)}`).then((r) => r.json()).catch(() => null);
      if (st?.ok) status = st.status;
    }
    if (status === 'confirmed') {
      fundMsg(`${amt} SOL arrived in the bot wallet. (${link})`, 'good');
      showToast(`Bot wallet funded · ${amt} SOL`, 'good');
      document.getElementById('phantom-fund-amt').value = '';
    } else if (status === 'failed') {
      fundMsg(`The transfer failed on-chain — no SOL was moved. (${link})`, 'bad');
    } else {
      fundMsg(`Still confirming — check it on ${link}.`);
    }
    refreshPhantomBalance();
    fetch('/api/real/status').catch(() => {}); // refreshes the bot wallet balance on the server
  } catch (err) {
    fundMsg(esc(walletErrorMessage(err, 'Phantom')), 'bad');
  } finally {
    phantomSendBusy = false;
    if (btn) btn.disabled = false;
  }
};


// ---------------------------------------------------------------------------
// MetaMask (Solana). MetaMask exposes its Solana account through the Wallet Standard
// (the shared interface Solana wallets register in the page), not window.solana.
// Read-only link for deposits/balance; sending SOL to the bot wallet is approved in MetaMask.
// ---------------------------------------------------------------------------
const standardWallets = new Set();
{
  const register = (...wallets) => {
    for (const w of wallets) if (w) standardWallets.add(w);
    return () => wallets.forEach((w) => standardWallets.delete(w));
  };
  try {
    window.addEventListener('wallet-standard:register-wallet', (e) => {
      try {
        e.detail({ register });
      } catch {
        // a wallet that registers badly is ignored
      }
    });
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register } }));
  } catch {
    // very old browser
  }
}

function findMetaMaskSolana() {
  for (const w of standardWallets) {
    if (/metamask/i.test(w?.name || '') && (w.chains || []).some((c) => String(c).startsWith('solana:')) && w.features?.['standard:connect']) return w;
  }
  return null;
}
async function waitForMetaMask(ms = 2500) {
  const until = Date.now() + ms;
  let w = findMetaMaskSolana();
  while (!w && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
    w = findMetaMaskSolana();
  }
  return w;
}

function metamaskNotFound() {
  if (window.ethereum?.isMetaMask) {
    showToast("MetaMask is installed, but its Solana account isn't available. Update MetaMask to the latest version (Solana is built in), unlock it, then try again.", 'warn');
    return;
  }
  if (isMobileDevice()) {
    showToast('Opening this page in the MetaMask app…', 'good');
    window.location.href = `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}`;
    return;
  }
  showToast('MetaMask extension not found in this browser. Install it from metamask.io (opened in a new tab), then reload this page.', 'warn');
  window.open('https://metamask.io/download/', '_blank', 'noopener');
}

/** The chain id this wallet uses for Solana mainnet (MetaMask uses the full network id). */
const SOLANA_MAINNET_IDS = ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana:mainnet', 'solana:mainnet-beta'];
function solanaMainnetChain(wallet, account) {
  const offered = [...(account?.chains || []), ...(wallet?.chains || [])].map(String);
  for (const id of SOLANA_MAINNET_IDS) if (offered.includes(id)) return id;
  return offered.find((c) => c.startsWith('solana:') && !/devnet|testnet|EtWTRAB|4uhcVJy/i.test(c)) || SOLANA_MAINNET_IDS[0];
}

async function metamaskConnectAccount() {
  const w = await waitForMetaMask();
  if (!w) {
    metamaskNotFound();
    return null;
  }
  const res = await w.features['standard:connect'].connect();
  const accounts = res?.accounts?.length ? res.accounts : w.accounts || [];
  const account = accounts.find((a) => isRealSolanaAddress(a?.address)) || null;
  if (!account) throw new Error('MetaMask did not return a Solana account');
  return { wallet: w, account };
}

window.metamaskButtonClick = async function metamaskButtonClick() {
  if (linkedWallet()?.provider === 'metamask') return disconnectMetaMask();
  return connectMetaMask();
};

window.connectMetaMask = async function connectMetaMask() {
  const btn = document.getElementById('btn-metamask');
  if (btn) btn.disabled = true;
  try {
    const got = await metamaskConnectAccount();
    if (!got) return;
    const data = await saveExternalWallet('link-external', got.account.address, 'metamask');
    if (!data.ok) throw new Error(data.error || 'Could not link MetaMask');
    showToast(`MetaMask linked · ${shortAddr(got.account.address)}`, 'good');
    refreshPhantomBalance();
  } catch (err) {
    showToast(walletErrorMessage(err, 'MetaMask'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.disconnectMetaMask = async function disconnectMetaMask() {
  try {
    await findMetaMaskSolana()?.features?.['standard:disconnect']?.disconnect?.();
  } catch {
    // already disconnected
  }
  phantomBalanceSol = null;
  await saveExternalWallet('unlink-external', null, 'metamask');
  showToast('MetaMask unlinked', 'good');
};

async function sendSolFromMetaMask() {
  const amt = Number(document.getElementById('phantom-fund-amt')?.value);
  if (!(amt > 0)) return fundMsg('Enter how much SOL to send.', 'bad');
  const btn = document.getElementById('btn-phantom-send');
  phantomSendBusy = true;
  if (btn) btn.disabled = true;
  try {
    const bot = await loadBotWallet(true);
    if (!bot) throw new Error('The bot wallet is not set up (ODEX_TRADER_KEY in .env).');
    fundMsg('Waiting for MetaMask…');
    const got = await metamaskConnectAccount();
    if (!got) return;
    const from = got.account.address;
    if (from === bot) throw new Error('This MetaMask account is the bot wallet itself.');
    if (phantomAddress() !== from) await saveExternalWallet('link-external', from, 'metamask');
    const feature = got.wallet.features['solana:signAndSendTransaction'];
    if (!feature?.signAndSendTransaction) throw new Error('This MetaMask version cannot send Solana transactions — update MetaMask.');
    const balRes = await fetch(`/api/external-wallet/balance?address=${encodeURIComponent(from)}`).then((r) => r.json()).catch(() => null);
    if (balRes?.ok && balRes.sol < amt + 0.00001) throw new Error(`MetaMask has ${Number(balRes.sol).toFixed(4)} SOL — not enough to send ${amt} SOL plus the network fee.`);
    const bh = await fetch('/api/solana/blockhash').then((r) => r.json());
    if (!bh?.ok) throw new Error(bh?.error || 'Could not reach the Solana network.');
    const message = buildSolTransferMessage(from, bot, Math.round(amt * 1e9), bh.blockhash);
    // a full unsigned transaction: 1 empty signature slot + the message
    const tx = new Uint8Array(1 + 64 + message.length);
    tx[0] = 1;
    tx.set(message, 65);
    fundMsg(`Approve sending <strong>${amt} SOL</strong> to the bot wallet in MetaMask…`);
    const out = await feature.signAndSendTransaction({ account: got.account, transaction: tx, chain: solanaMainnetChain(got.wallet, got.account) });
    const raw = Array.isArray(out) ? out[0]?.signature : out?.signature;
    const sig = raw instanceof Uint8Array ? b58encode(raw) : typeof raw === 'string' ? raw : null;
    if (!sig) throw new Error('MetaMask did not return a transaction id.');
    const link = `<a href="https://solscan.io/tx/${encodeURIComponent(sig)}" target="_blank" rel="noopener">Solscan</a>`;
    fundMsg(`Sent — confirming on-chain… (${link})`);
    let status = 'pending';
    for (let i = 0; i < 30 && status === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await fetch(`/api/solana/tx-status?sig=${encodeURIComponent(sig)}`).then((r) => r.json()).catch(() => null);
      if (st?.ok) status = st.status;
    }
    if (status === 'confirmed') {
      fundMsg(`${amt} SOL arrived in the bot wallet. (${link})`, 'good');
      showToast(`Bot wallet funded · ${amt} SOL`, 'good');
      document.getElementById('phantom-fund-amt').value = '';
    } else if (status === 'failed') fundMsg(`The transfer failed on-chain — no SOL was moved. (${link})`, 'bad');
    else fundMsg(`Still confirming — check it on ${link}.`);
    refreshPhantomBalance();
    fetch('/api/real/status').catch(() => {});
  } catch (err) {
    fundMsg(esc(walletErrorMessage(err, 'MetaMask')), 'bad');
  } finally {
    phantomSendBusy = false;
    if (btn) btn.disabled = false;
  }
}


// ---------------------------------------------------------------------------
// Trader settings (edit an existing follow: mode, sizing, TP/SL, limits, pump-only)
// ---------------------------------------------------------------------------
window.onEditFollowSizing = function onEditFollowSizing() {
  const t = document.getElementById('ef-sizing-type').value;
  document.getElementById('ef-sizing-label').textContent = t === 'percent' ? '% of balance' : t === 'proportional' ? 'Max per copy ($)' : 'Amount ($)';
};

window.onEditFollowMode = function onEditFollowMode() {
  const id = document.getElementById('ef-id').value;
  const f = engineState?.follows?.find((x) => x.id === id);
  const mode = document.getElementById('ef-mode').value;
  const on = Object.values(f?.exitRules || {}).filter((r) => r && r.enabled).length;
  const hint = document.getElementById('ef-mode-hint');
  hint.className = 'ef-hint';
  const mirrorRow = document.getElementById('ef-mirror-sells-row');
  if (mirrorRow) mirrorRow.hidden = mode !== 'auto-exit';
  const mirrorSells = mode === 'auto-exit' && Boolean(document.getElementById('ef-mirror-sells')?.checked);
  if (mode === 'auto-exit') hint.textContent = on ? `Your ${on} exit rule${on === 1 ? '' : 's'} decide when to sell${mirrorSells ? ', and you also sell the moment the trader sells.' : "; the trader's sells are not copied."}` : 'No exit rules are on yet — the recommended 5 rules will be switched on when you save.';
  else if (mode === 'mirror') {
    hint.textContent = "Sells only when the trader sells. If they never sell (or a big sell crashes the price first), nothing protects you — set a stop loss.";
    hint.className = 'ef-hint is-warn';
  } else hint.textContent = 'Holds until your take profit or stop loss is hit.';
};

window.openEditFollowModal = function openEditFollowModal(id) {
  const f = engineState?.follows?.find((x) => x.id === id);
  if (!f) return;
  const set = (k, v) => {
    const el = document.getElementById(k);
    if (el) el.value = v === null || v === undefined ? '' : v;
  };
  set('ef-id', f.id);
  document.getElementById('ef-who').textContent = `${f.traderWallet.slice(0, 4)}…${f.traderWallet.slice(-4)}`;
  set('ef-name', f.name || '');
  set('ef-mode', f.mode);
  set('ef-sizing-type', f.sizing?.type || 'fixed');
  set('ef-sizing-amount', f.sizing?.amount ?? 50);
  set('ef-tp', f.tpPct);
  set('ef-sl', f.slPct);
  set('ef-min-trade', f.minTradeUsd);
  set('ef-max-open', f.maxOpenPositions);
  set('ef-max-risk', f.maxAtRiskUsd);
  const po = f.filtersOverride?.pumpOnly;
  set('ef-pump', po === true ? 'true' : po === false ? 'false' : '');
  const on = Object.values(f.exitRules || {}).filter((r) => r && r.enabled).length;
  document.getElementById('ef-rules-count').textContent = `${on}/5`;
  document.getElementById('ef-msg').textContent = '';
  set('ef-max-chase', f.maxChasePct);
  set('ef-topups', f.copyTopUps === true ? 'true' : f.copyTopUps === false ? 'false' : '');
  const ms = document.getElementById('ef-mirror-sells');
  if (ms) ms.checked = f.mirrorSells === true;
  set('ef-max-sol-day', f.maxRealSolPerDay ?? '');
  set('ef-reentry', f.reentryCooldownMin ?? '');
  loadEditFollowSolLimits(f);
  syncEditFollowCopyAll();
  onEditFollowSizing();
  onEditFollowMode();
  document.getElementById('modal-edit-follow').classList.add('open');
};

// Daily real-SOL limits in the trader Settings: this trader's own + the overall one
async function loadEditFollowSolLimits(f) {
  const all = document.getElementById('ef-max-sol-day-all');
  const hint = document.getElementById('ef-sol-day-hint');
  if (!all) return;
  all.dataset.loaded = '0';
  all.value = '';
  all.placeholder = 'Loading…';
  try {
    const st = await (await fetch('/api/real/status')).json();
    const day = st?.caps?.maxSolPerDay;
    all.value = day === undefined || day === null ? '' : String(day);
    all.dataset.initial = all.value;
    all.dataset.loaded = '1';
    all.placeholder = '0 = no limit';
    if (hint) {
      const spentAll = Number(st?.spent24hSol || 0);
      const spentMe = (Array.isArray(f.realSpendLog) ? f.realSpendLog : []).filter((x) => x && x.t >= Date.now() - 86400000).reduce((a, x) => a + (Number(x.sol) || 0), 0);
      hint.textContent = `Used in the last 24 h: ${spentMe.toFixed(3)} SOL by this trader, ${spentAll.toFixed(3)} SOL by all traders. Real buys stop once a limit is used up; sells are never blocked.${st?.envCaps && Number(st.envCaps.maxSolPerDay) !== Number(day) ? ` (Railway variable: ${st.envCaps.maxSolPerDay} SOL — this setting wins.)` : ''}`;
    }
  } catch {
    all.placeholder = 'Could not load';
  }
}

window.openExitRulesFromEdit = function openExitRulesFromEdit() {
  const id = document.getElementById('ef-id').value;
  closeModal('modal-edit-follow');
  openExitRulesModal(id);
};

window.saveEditFollow = async function saveEditFollow() {
  const id = document.getElementById('ef-id').value;
  const val = (k) => document.getElementById(k).value.trim();
  const num = (k) => (val(k) === '' ? null : Number(val(k)));
  const msg = document.getElementById('ef-msg');
  const amount = Number(val('ef-sizing-amount'));
  const type = val('ef-sizing-type');
  if (!(amount > 0) || (type === 'percent' && amount > 100)) {
    msg.textContent = type === 'percent' ? '% of balance must be between 0 and 100.' : 'Size must be greater than zero.';
    return;
  }
  const sl = num('ef-sl');
  if (sl !== null && !(sl > 0 && sl <= 100)) {
    msg.textContent = 'Stop loss must be between 1 and 100%.';
    return;
  }
  const pump = val('ef-pump');
  const body = {
    name: val('ef-name') || '-',
    mode: val('ef-mode'),
    sizing: { type, amount },
    tpPct: num('ef-tp'),
    slPct: sl,
    minTradeUsd: num('ef-min-trade'),
    maxOpenPositions: num('ef-max-open'),
    maxAtRiskUsd: num('ef-max-risk'),
    filtersOverride: { pumpOnly: pump === '' ? null : pump === 'true' },
    maxChasePct: num('ef-max-chase'),
    copyTopUps: val('ef-topups') === '' ? null : val('ef-topups') === 'true',
    mirrorSells: Boolean(document.getElementById('ef-mirror-sells')?.checked),
    maxRealSolPerDay: num('ef-max-sol-day'),
    reentryCooldownMin: num('ef-reentry'),
  };
  if (body.reentryCooldownMin !== null && !(body.reentryCooldownMin >= 0 && body.reentryCooldownMin <= 1440)) {
    msg.textContent = 'Skip re-entries must be 0–1440 minutes (leave it empty to copy every re-entry).';
    return;
  }
  if (body.maxRealSolPerDay !== null && !(body.maxRealSolPerDay > 0)) {
    msg.textContent = "The trader's daily SOL limit must be above 0 (leave it empty for no limit).";
    return;
  }
  // the overall daily limit (all traders) is saved separately, only when it was changed
  const allEl = document.getElementById('ef-max-sol-day-all');
  const allNew = allEl && allEl.dataset.loaded === '1' && allEl.value.trim() !== allEl.dataset.initial ? allEl.value.trim() : null;
  if (allNew !== null) {
    const v = allNew === '' ? '' : Number(allNew);
    if (v !== '' && !(v >= 0 && v <= 1000)) {
      msg.textContent = 'The overall daily limit must be between 0 and 1000 SOL (0 = no limit).';
      return;
    }
    const r = await fetch('/api/real/caps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxSolPerDay: v }) });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) {
      msg.textContent = d.error || 'Could not save the overall daily limit.';
      return;
    }
    allEl.dataset.initial = allNew;
  }
  if (body.maxChasePct !== null && !(body.maxChasePct >= 1)) {
    msg.textContent = 'Max chase must be at least 1% (leave it empty to use the account setting).';
    return;
  }
  const btn = document.getElementById('ef-save');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/follows/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) {
      msg.textContent = data.error || 'Could not save.';
      return;
    }
    engineState = data.state;
    renderTerminalAll();
    closeModal('modal-edit-follow');
    showToast('Trader settings saved', 'good');
  } catch {
    msg.textContent = 'Could not reach the server.';
  } finally {
    btn.disabled = false;
  }
};


// ---------------------------------------------------------------------------
// Integrations (Settings → Integrations): Telegram + Discord trade alerts
// ---------------------------------------------------------------------------
const INTG = { telegram: { short: 'tg', name: 'Telegram' } };
const INTG_EVENTS = [['copies', 'Copied buys'], ['sells', 'Sells & PnL'], ['problems', 'Problems']];
let intgState = null;

function intgMsg(app, text, kind = '') {
  const el = document.getElementById(`intg-${INTG[app].short}-msg`);
  if (el) {
    el.className = `intg-msg${kind ? ` is-${kind}` : ''}`;
    el.textContent = text || '';
  }
}

function renderDaxAi() {
  const c = intgState?.dax;
  if (!c) return;
  const pill = document.getElementById('intg-dax-pill');
  if (pill) {
    pill.className = `intg-pill${c.configured ? (c.lastError ? ' is-bad' : ' is-on') : ''}`;
    pill.textContent = c.configured ? (c.lastError ? 'Error' : c.provider === 'gemini' ? 'Gemini AI' : 'Full AI') : 'Basic mode';
  }
  const key = document.getElementById('intg-dax-key');
  if (key && !key.value) key.placeholder = c.keyMasked ? `Saved: ${c.keyMasked}` : c.source === 'railway' ? 'Using API key from environment' : 'AIza… (Gemini) or sk-ant-… (Claude)';
  const model = document.getElementById('intg-dax-model');
  if (model && c.model && document.activeElement !== model) model.value = c.model;
  const usage = document.getElementById('intg-dax-usage');
  if (usage) usage.textContent = c.configured ? `${c.requests || 0} question${c.requests === 1 ? '' : 's'} since restart` : '';
  const msg = document.getElementById('intg-dax-msg');
  if (msg && c.lastError && !msg.textContent) {
    msg.className = 'intg-msg is-bad';
    msg.textContent = `Last error: ${c.lastError}`;
  }
}
function daxAiMsg(text, kind = '') {
  const el = document.getElementById('intg-dax-msg');
  if (el) {
    el.className = `intg-msg${kind ? ` is-${kind}` : ''}`;
    el.textContent = text || '';
  }
}
async function daxAiPost(sub, body) {
  const res = await fetch(`/api/integrations/dax${sub ? `/${sub}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({ ok: false, error: `server answered ${res.status}` }));
  if (data.dax) intgState = { ...(intgState || {}), dax: data.dax };
  renderDaxAi();
  loadDaxChatStatus();
  return data;
}
window.daxAiSave = async function daxAiSave() {
  const el = document.getElementById('intg-dax-key');
  const apiKey = el.value.trim();
  if (!apiKey) return daxAiMsg('Paste your Gemini (AIza…) or Claude (sk-ant-…) API key first.', 'bad');
  const d = await daxAiPost('', { apiKey });
  if (!d.ok) return daxAiMsg(d.error, 'bad');
  el.value = '';
  daxAiMsg(`Saved — Dax is now powered by ${d.dax?.provider === 'gemini' ? 'Google Gemini AI' : 'Claude AI'}. Press Test to check the key.`, 'good');
};
window.daxAiModel = async function daxAiModel(model) {
  const d = await daxAiPost('', { model });
  daxAiMsg(d.ok ? 'Model saved.' : d.error, d.ok ? '' : 'bad');
};
window.daxAiTest = async function daxAiTest() {
  daxAiMsg('Testing the key…');
  const d = await daxAiPost('test');
  const who = d.dax?.provider === 'gemini' ? 'Gemini' : 'Claude';
  daxAiMsg(d.ok ? `Key works — ${who} answered "${d.reply || 'OK'}".` : `Test failed: ${d.error}`, d.ok ? 'good' : 'bad');
};
window.daxAiDisconnect = async function daxAiDisconnect() {
  const d = await daxAiPost('disconnect');
  daxAiMsg(d.ok ? (d.dax?.configured ? 'Removed — Dax now uses the environment API key.' : 'Key removed — Dax is back in basic mode.') : d.error, d.ok ? '' : 'bad');
};

function renderIntegrations() {
  if (!intgState) return;
  renderDaxAi();
  for (const app of Object.keys(INTG)) {
    const c = intgState[app] || {};
    const k = INTG[app].short;
    const pill = document.getElementById(`intg-${k}-pill`);
    if (pill) {
      const live = c.enabled && c.configured;
      pill.className = `intg-pill${live ? ' is-on' : c.lastError ? ' is-bad' : ''}`;
      pill.textContent = live ? 'Connected' : c.configured ? 'Paused' : 'Not connected';
    }
    const en = document.getElementById(`intg-${k}-enabled`);
    if (en) {
      en.checked = Boolean(c.enabled);
      en.disabled = !c.configured;
    }
    if (app === 'telegram') {
      const tok = document.getElementById('intg-tg-token');
      if (tok && !tok.value) tok.placeholder = c.tokenMasked ? `Saved: ${c.tokenMasked}` : 'Bot token, e.g. 123456789:AAH…';
      const chat = document.getElementById('intg-tg-chat');
      if (chat && document.activeElement !== chat) chat.value = c.chatId || '';
    }
    const ev = document.querySelector(`.intg-events[data-app="${app}"]`);
    if (ev) {
      ev.innerHTML = INTG_EVENTS.map(([key, label]) => `<label class="intg-ev"><input type="checkbox" ${c.events?.[key] !== false ? 'checked' : ''} onchange="intgEvent('${app}', '${key}', this.checked)" /> ${label}</label>`).join('');
    }
    if (c.lastError && !document.getElementById(`intg-${k}-msg`)?.textContent) intgMsg(app, `Last send failed: ${c.lastError.error}`, 'bad');
  }
}

window.loadIntegrations = async function loadIntegrations() {
  try {
    intgState = await (await fetch('/api/integrations')).json();
    renderIntegrations();
  } catch {
    // offline
  }
};

async function intgPost(app, sub, body) {
  const res = await fetch(`/api/integrations/${app}${sub ? `/${sub}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json();
  if (data.telegram) intgState = { ...(intgState || {}), telegram: data.telegram, discord: data.discord };
  renderIntegrations();
  return data;
}

window.intgFindTelegramChat = async function intgFindTelegramChat() {
  const token = document.getElementById('intg-tg-token').value.trim();
  intgMsg('telegram', 'Looking for your chat…');
  const d = await intgPost('telegram', 'find-chat', token ? { botToken: token } : {});
  if (!d.ok) return intgMsg('telegram', d.error, 'bad');
  document.getElementById('intg-tg-token').value = '';
  document.getElementById('intg-tg-chat').value = d.chatId;
  const t = await intgPost('telegram', '', { enabled: true });
  intgMsg('telegram', t.ok ? `Found "${d.name}" — alerts are on. Press Send test to check.` : t.error, t.ok ? 'good' : 'bad');
};

window.intgSave = async function intgSave(app) {
  const body = { botToken: document.getElementById('intg-tg-token').value.trim(), chatId: document.getElementById('intg-tg-chat').value.trim(), enabled: true };
  const d = await intgPost(app, '', body);
  if (!d.ok) return intgMsg(app, d.error, 'bad');
  document.getElementById('intg-tg-token').value = '';
  const c = d[app];
  intgMsg(app, c.configured ? 'Saved — alerts are on. Press Send test to check.' : app === 'telegram' ? 'Saved. Add the chat ID (or press Find my chat) to finish.' : 'Saved.', c.configured ? 'good' : '');
};

window.intgToggle = async function intgToggle(app, on) {
  const d = await intgPost(app, '', { enabled: on });
  intgMsg(app, d.ok ? (on ? 'Alerts on.' : 'Alerts paused.') : d.error, d.ok ? '' : 'bad');
};

window.intgEvent = async function intgEvent(app, key, on) {
  await intgPost(app, '', { events: { [key]: on } });
};

window.intgTest = async function intgTest(app) {
  intgMsg(app, 'Sending…');
  const d = await intgPost(app, 'test');
  intgMsg(app, d.ok ? `Test sent — check ${INTG[app].name}.` : d.error, d.ok ? 'good' : 'bad');
};

window.intgDisconnect = async function intgDisconnect(app) {
  const d = await intgPost(app, 'disconnect');
  intgMsg(app, d.ok ? `${INTG[app].name} disconnected.` : d.error, d.ok ? '' : 'bad');
};


// "Copy every trade": no chase limit (100000%) + every top-up copied, for this trader only
const COPY_ALL_CHASE = 100000;
window.onEditFollowCopyAll = function onEditFollowCopyAll() {
  const on = document.getElementById('ef-copyall').checked;
  document.getElementById('ef-max-chase').value = on ? String(COPY_ALL_CHASE) : '';
  document.getElementById('ef-topups').value = on ? 'true' : '';
  syncEditFollowCopyAll();
};
window.syncEditFollowCopyAll = function syncEditFollowCopyAll() {
  const chase = Number(document.getElementById('ef-max-chase').value);
  const all = chase >= 1000 && document.getElementById('ef-topups').value === 'true';
  document.getElementById('ef-copyall').checked = all;
  document.getElementById('ef-copyall-hint').hidden = !all;
};


// One-click "Follow the trader" preset: sell when they sell + early take profit + wide floor
window.applyFollowTrader = async function applyFollowTrader() {
  const id = document.getElementById('edit-follow-id')?.value;
  if (!id) return;
  const res = await fetch(`/api/follows/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ useFollowTrader: true }) });
  const data = await res.json();
  if (!data.ok) return showToast(data.error || 'Could not apply the preset.', 'danger');
  engineState = data.state;
  renderTerminalAll();
  closeModal('modal-exit-rules');
  showToast('Follow the trader applied: sell when they sell, +12% take profit, −40% floor, 5 min cap', 'good');
};

// One-click "Fast scalp" exit preset (Auto-Exit, every exit sells the whole position)
window.applyFastScalp = async function applyFastScalp() {
  const id = document.getElementById('edit-follow-id')?.value;
  if (!id) return;
  const res = await fetch(`/api/follows/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ useFastScalp: true }) });
  const data = await res.json();
  if (!data.ok) return showToast(data.error || 'Could not apply the preset.', 'danger');
  engineState = data.state;
  renderTerminalAll();
  closeModal('modal-exit-rules');
  showToast('Fast scalp applied: Auto-Exit, +12% take profit, 15% trail, −25% floor, 3 min cap', 'good');
};


// ============================================================================
// Dax, the report agent: one report of every trade section, ready to paste to Claude
// ============================================================================
const dax = { period: '24h', report: null, loading: false, settings: null };
try {
  const p = localStorage.getItem('odex.daxPeriod');
  if (['today', '24h', '7d', 'all'].includes(p)) dax.period = p;
} catch {
  // storage unavailable
}

window.openDax = function openDax() {
  switchMainView('dax');
  loadDax();
};

/** Small, safe Markdown → HTML (headings, lists, tables, code, bold, italics) for Dax's report. */
function daxMarkdownHtml(md) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1<i>$2</i>');
  const out = [];
  const lines = String(md || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const code = [];
      for (i += 1; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      out.push(`<pre>${esc(code.join('\n'))}</pre>`);
    } else if (l.startsWith('|')) {
      const rows = [];
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
      i -= 1;
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r, k) => k !== 1 || !/^\|[\s|:-]+\|$/.test(r));
      out.push(`<table><thead><tr>${cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^[-*•] /.test(l)) {
      const items = [];
      for (; i < lines.length && /^[-*•] /.test(lines[i]); i++) items.push(`<li>${inline(lines[i].slice(2))}</li>`);
      i -= 1;
      out.push(`<ul>${items.join('')}</ul>`);
    } else if (/^#{1,3} /.test(l)) {
      const n = l.match(/^#+/)[0].length;
      out.push(`<h${n}>${inline(l.slice(n + 1))}</h${n}>`);
    } else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('');
}

window.loadDax = async function loadDax(period) {
  if (period) {
    dax.period = period;
    try {
      localStorage.setItem('odex.daxPeriod', period);
    } catch {
      // ignore
    }
  }
  document.querySelectorAll('#dax-period .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.p === dax.period));
  const meta = document.getElementById('dax-meta');
  if (meta) meta.textContent = 'Dax is writing the report…';
  dax.loading = true;
  try {
    const d = await (await fetch(`/api/dax/report?period=${encodeURIComponent(dax.period)}`, { cache: 'no-store' })).json();
    if (!d.ok) throw new Error(d.error || 'report failed');
    dax.report = d;
    dax.settings = d.dax || null;
    renderDax();
  } catch (err) {
    if (meta) meta.textContent = `Dax could not write the report: ${err.message}`;
  } finally {
    dax.loading = false;
  }
};

function renderDaxShare() {
  const on = Boolean(engineState?.settings?.daxShare?.enabled);
  const btn = document.getElementById('dax-share-btn');
  const off = document.getElementById('dax-share-off');
  const url = document.getElementById('dax-share-url');
  const copy = document.getElementById('dax-share-copy');
  if (btn) btn.textContent = on ? 'New report link' : 'Create report link for Claude';
  if (off) off.hidden = !on;
  if (url) {
    url.hidden = !dax.shareUrl;
    url.textContent = dax.shareUrl || '';
  }
  if (copy) copy.hidden = !dax.shareUrl;
  if (on && !dax.shareUrl && url) {
    url.hidden = false;
    url.textContent = 'A report link is on (shown only when created — press New report link to get a fresh one)';
  }
}
window.createDaxShare = async function createDaxShare() {
  try {
    const d = await (await fetch('/api/dax/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    if (!d.ok) return showToast(d.error || 'Could not create the link', 'danger');
    dax.shareUrl = d.url;
    if (engineState?.settings) engineState.settings.daxShare = { enabled: true };
    renderDaxShare();
    copyDaxShare();
  } catch {
    showToast('Could not create the link', 'danger');
  }
};
window.copyDaxShare = async function copyDaxShare() {
  if (!dax.shareUrl) return;
  try {
    await navigator.clipboard.writeText(dax.shareUrl);
    showToast('Report link copied — paste it to Claude. Anyone with it can read this report.', 'good');
  } catch {
    showToast('Copy the link from the box', 'good');
  }
};
window.disableDaxShare = async function disableDaxShare() {
  try {
    await fetch('/api/dax/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    dax.shareUrl = null;
    if (engineState?.settings) engineState.settings.daxShare = null;
    renderDaxShare();
    showToast('Report link turned off — the old link no longer works', 'good');
  } catch {
    showToast('Could not turn the link off', 'danger');
  }
};

function renderDax() {
  renderDaxShare();
  const r = dax.report;
  if (!r) return;
  const tone = { bad: 'bad', warn: 'warn', good: 'good' };
  const f = document.getElementById('dax-findings');
  if (f) f.innerHTML = (r.findings || []).map((x) => `<div class="dax-find ${tone[x.level] || ''}"><i></i><span>${esc(x.text)}</span></div>`).join('');
  const meta = document.getElementById('dax-meta');
  if (meta) meta.textContent = `${r.period.label} · written ${new Date(r.generatedAt).toLocaleString()} · ${r.markdown.length.toLocaleString()} characters`;
  const rep = document.getElementById('dax-report');
  if (rep) rep.innerHTML = daxMarkdownHtml(r.markdown.replace(/^## Dax's findings[\s\S]*?(?=\n## )/m, ''));
  // daily report settings
  const s = dax.settings;
  const hour = document.getElementById('dax-hour');
  if (hour && !hour.options.length) hour.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00 UTC</option>`).join('');
  if (s) {
    const cb = document.getElementById('dax-daily');
    if (cb) cb.checked = Boolean(s.daily);
    if (hour) hour.value = String(s.hourUtc ?? 8);
    const note = document.getElementById('dax-daily-note');
    if (note) note.textContent = s.telegram || s.discord ? `→ ${[s.telegram ? 'Telegram' : null, s.discord ? 'Discord' : null].filter(Boolean).join(' + ')}` : '(connect Telegram or Discord in Settings → Integrations)';
    const send = document.getElementById('dax-send');
    if (send) send.disabled = !(s.telegram || s.discord);
  }
}

window.copyDaxReport = async function copyDaxReport() {
  if (!dax.report) await loadDax();
  if (!dax.report) return;
  try {
    await navigator.clipboard.writeText(dax.report.markdown);
    showToast('Dax report copied — paste it into your chat with Claude', 'good');
  } catch {
    // clipboard blocked: select the text instead
    const ta = document.createElement('textarea');
    ta.value = dax.report.markdown;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('Dax report copied', 'good');
    } catch {
      showToast('Could not copy — use Download .md instead', 'danger');
    }
    ta.remove();
  }
};

window.downloadDaxReport = function downloadDaxReport() {
  if (!dax.report) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([dax.report.markdown], { type: 'text/markdown' }));
  a.download = `dax-report-${dax.period}-${new Date(dax.report.generatedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
};

window.sendDaxReport = async function sendDaxReport() {
  const btn = document.getElementById('dax-send');
  if (btn) btn.disabled = true;
  try {
    const d = await (await fetch('/api/dax/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period: dax.period }) })).json();
    if (!d.ok) return showToast(d.error || 'Dax could not send the report', 'danger');
    const to = [d.sent?.telegram ? 'Telegram' : null, d.sent?.discord ? 'Discord' : null].filter(Boolean).join(' + ');
    showToast(`Dax sent the report to ${to}`, 'good');
  } catch {
    showToast('Dax could not send the report', 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.saveDaxDaily = async function saveDaxDaily() {
  const daily = Boolean(document.getElementById('dax-daily')?.checked);
  const hourUtc = Number(document.getElementById('dax-hour')?.value || 8);
  try {
    const d = await (await fetch('/api/dax/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ daily, hourUtc }) })).json();
    if (!d.ok) return showToast(d.error || 'Could not save', 'danger');
    dax.settings = d.dax;
    renderDax();
    showToast(daily ? `Dax will send the last 24 h report every day at ${String(hourUtc).padStart(2, '0')}:00 UTC` : 'Daily Dax report off', 'good');
  } catch {
    showToast('Could not save the daily report setting', 'danger');
  }
};

// ============================================================================
// Dax chat: text, voice messages and hands-free voice calls
// Voice uses the browser's own speech recognition + speech (Chrome / Edge); the answers come
// from the server (Claude with read-only tools when ANTHROPIC_API_KEY is set, else basic mode).
// ============================================================================
const daxc = { open: false, msgs: [], busy: false, status: null, rec: null, recOn: false, call: null };
const DAX_CHIPS = ['What is the delay right now?', 'Why were trades skipped?', 'Why did my last real trades lose?', 'How much did we make today?', 'What are my open positions?', 'How much SOL is left in the bot wallet?'];
// The conversation lives on the server (it survives redeploys and is the same on every device)
async function loadDaxHistory() {
  try {
    const d = await (await fetch('/api/dax/history', { cache: 'no-store' })).json();
    if (Array.isArray(d.msgs)) {
      daxc.msgs = d.msgs.slice(-60);
      renderDaxChat();
    }
  } catch {
    // offline: keep what is shown
  }
}
try {
  localStorage.removeItem('odex.daxChat'); // old browser-only copy
} catch {
  // ignore
}
setTimeout(loadDaxHistory, 800);
function saveDaxChat() {
  // saved by the server with every question and answer
}
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const voiceSupported = Boolean(SpeechRec && window.speechSynthesis);

window.openDaxAiSettings = function openDaxAiSettings() {
  goTerminalTab('config');
  openSettingsSection('integrations');
  setTimeout(() => {
    const card = document.querySelector('.intg-card[data-app="dax"]');
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('intg-dax-key')?.focus();
  }, 80);
};

async function loadDaxChatStatus() {
  try {
    daxc.status = await (await fetch('/api/dax/chat/status', { cache: 'no-store' })).json();
  } catch {
    daxc.status = null;
  }
  const st = document.getElementById('dc-status');
  if (st) {
    if (daxc.status?.ai) {
      const prov = daxc.status.provider === 'gemini' ? 'Gemini AI' : 'Claude AI';
      st.textContent = `Online · ${prov} smart agent`;
      st.title = `Model: ${daxc.status.model || ''}`;
    } else {
      st.innerHTML = `Online · answers from your Odex records · <button type="button" onclick="openDaxAiSettings()" style="background:none;border:none;color:#818cf8;padding:0;font-size:inherit;font-weight:600;cursor:pointer;text-decoration:underline;">Connect Gemini AI</button>`;
      st.title = 'Connect a Gemini API key in Settings → Integrations for full smart agent reasoning';
    }
  }
  document.getElementById('dax-fab')?.classList.toggle('is-basic', !daxc.status?.ai);
}

window.toggleDaxChat = function toggleDaxChat(force) {
  daxc.open = typeof force === 'boolean' ? force : !daxc.open;
  const box = document.getElementById('dax-chat');
  const fab = document.getElementById('dax-fab');
  if (box) box.hidden = !daxc.open;
  if (fab) fab.setAttribute('aria-expanded', daxc.open ? 'true' : 'false');
  if (daxc.open) {
    loadDaxChatStatus();
    renderDaxChat();
    setTimeout(() => document.getElementById('dc-text')?.focus(), 30);
  } else if (daxc.call) endDaxCall();
  for (const id of ['dc-mic', 'dc-call-btn']) {
    const b = document.getElementById(id);
    if (b && !voiceSupported) {
      b.disabled = true;
      b.title = 'Voice needs Chrome or Edge (this browser has no speech recognition)';
    }
  }
};

function renderDaxChat(typing = false) {
  const box = document.getElementById('dc-msgs');
  if (!box) return;
  const hello = `<div class="dc-msg dax">Hi, I'm Dax 👋 I read every trade, skip and exit the bot makes. Ask me why a trade lost, how a trader is doing, or what to change — type, send a voice message, or call me.</div>`;
  box.innerHTML =
    (daxc.msgs.length ? '' : hello) +
    daxc.msgs
      .map((m) => {
        if (m.role === 'user') return `<div class="dc-msg me">${esc(m.text)}${m.voice ? '<span class="dc-meta">🎙 voice</span>' : ''}</div>`;
        if (m.role === 'error') return `<div class="dc-msg err">${esc(m.text)}</div>`;
        return `<div class="dc-msg dax">${daxMarkdownHtml(m.text).replace(/<table>/g, '<div class="dax-tbl-wrap"><table>').replace(/<\/table>/g, '</table></div>')}</div>`;
      })
      .join('') +
    (typing ? '<div class="dc-typing"><img src="/dax/dax-side.png" alt="" />Dax is looking at your trades…</div>' : '');
  box.scrollTop = box.scrollHeight;
  const chips = document.getElementById('dc-chips');
  if (chips) chips.innerHTML = daxc.msgs.length ? '' : DAX_CHIPS.map((c) => `<button type="button" onclick="sendDaxMessage(${esc(JSON.stringify(c))})">${esc(c)}</button>`).join('');
  const send = document.getElementById('dc-send');
  if (send) send.disabled = daxc.busy;
}

/** Ask Dax. Returns the reply text (or null). voice = short spoken-style answer. */
async function askDax(text, { voice = false } = {}) {
  daxc.msgs.push({ role: 'user', text, voice });
  daxc.busy = true;
  renderDaxChat(true);
  let reply = null;
  try {
    const r = await fetch('/api/dax/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice }) });
    const d = await r.json().catch(() => ({}));
    if (d.ok) {
      reply = d.text;
      daxc.msgs.push({ role: 'assistant', text: d.text, mode: d.mode });
    } else daxc.msgs.push({ role: 'error', text: d.error || 'Dax could not answer.' });
  } catch {
    daxc.msgs.push({ role: 'error', text: 'Dax could not be reached — check your connection.' });
  } finally {
    daxc.busy = false;
    saveDaxChat();
    renderDaxChat();
  }
  return reply;
}

window.sendDaxMessage = async function sendDaxMessage(preset) {
  const ta = document.getElementById('dc-text');
  const text = String(typeof preset === 'string' ? preset : ta?.value || '').trim();
  if (!text || daxc.busy) return;
  if (ta && typeof preset !== 'string') {
    ta.value = '';
    ta.style.height = 'auto';
  }
  await askDax(text);
};

window.clearDaxChat = function clearDaxChat() {
  daxc.msgs = [];
  renderDaxChat();
  fetch('/api/dax/history', { method: 'DELETE' }).catch(() => {});
};

// ---------- speech out ----------
function daxVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const lang = (navigator.language || 'en').slice(0, 2);
  return voices.find((v) => v.lang?.startsWith(lang) && /natural|neural|online|google/i.test(v.name)) || voices.find((v) => v.lang?.startsWith(lang)) || null;
}
function daxSpeak(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    const plain = String(text || '').replace(/[*_#`|>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!plain) return resolve();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(plain.slice(0, 1200));
    const v = daxVoice();
    if (v) u.voice = v;
    u.lang = v?.lang || navigator.language || 'en-US';
    u.rate = 1.03;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

// ---------- speech in ----------
function listenOnce({ onInterim } = {}) {
  return new Promise((resolve, reject) => {
    if (!SpeechRec) return reject(new Error('unsupported'));
    const rec = new SpeechRec();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let final = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      onInterim?.((final + ' ' + interim).trim());
    };
    rec.onerror = (e) => reject(new Error(e.error || 'speech error'));
    rec.onend = () => resolve(final.trim());
    try {
      rec.start();
    } catch (err) {
      reject(err);
    }
    daxc.rec = rec;
  });
}
function micErrorText(err) {
  const m = String(err?.message || err);
  if (/not-allowed|service-not-allowed|denied/i.test(m)) return 'Microphone blocked — allow microphone access for this site in the browser (lock icon in the address bar).';
  if (/no-speech/i.test(m)) return null;
  if (/unsupported/i.test(m)) return 'Voice needs Chrome or Edge.';
  if (/network/i.test(m)) return "The browser's speech service could not be reached.";
  return `Voice problem: ${m}`;
}

// Voice message: talk → it is sent → Dax answers in text and out loud
window.toggleDaxDictation = async function toggleDaxDictation() {
  const btn = document.getElementById('dc-mic');
  const ta = document.getElementById('dc-text');
  if (daxc.recOn) {
    daxc.rec?.stop();
    return;
  }
  if (daxc.busy) return;
  daxc.recOn = true;
  btn?.classList.add('is-rec');
  if (ta) ta.placeholder = 'Listening… speak now';
  try {
    const said = await listenOnce({ onInterim: (t) => ta && (ta.value = t) });
    if (ta) ta.value = '';
    if (said) {
      const reply = await askDax(said, { voice: true });
      if (reply) daxSpeak(reply);
    }
  } catch (err) {
    const t = micErrorText(err);
    if (t) showToast(t, 'danger');
  } finally {
    daxc.recOn = false;
    btn?.classList.remove('is-rec');
    if (ta) ta.placeholder = 'Ask Dax about your trades…';
  }
};

// Voice call: hands-free loop listen → Dax thinks → Dax speaks → listen again
function setCallState(state, text) {
  const face = document.getElementById('dc-call-face');
  const img = document.getElementById('dc-call-img');
  const st = document.getElementById('dc-call-state');
  if (face) face.className = `dc-call-face ${state}`;
  if (img) img.src = state === 'thinking' ? '/dax/dax-side.png' : '/dax/dax.png';
  if (st) st.textContent = text;
}
window.startDaxCall = async function startDaxCall() {
  if (!voiceSupported) return showToast('Voice calls need Chrome or Edge.', 'danger');
  if (daxc.call) return;
  const call = { active: true, muted: false };
  daxc.call = call;
  document.getElementById('dc-call').hidden = false;
  const heard = document.getElementById('dc-call-heard');
  setCallState('speaking', 'Dax');
  await daxSpeak('Hi, Dax here. What do you want to know about your trades?');
  let quiet = 0;
  while (call.active) {
    if (call.muted) {
      setCallState('', 'Muted');
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    setCallState('listening', 'Listening…');
    let said = '';
    try {
      said = await listenOnce({ onInterim: (t) => heard && (heard.textContent = t) });
    } catch (err) {
      const t = micErrorText(err);
      if (t) {
        showToast(t, 'danger');
        break;
      }
    }
    if (!call.active) break;
    if (!said) {
      quiet += 1;
      if (quiet >= 3) {
        setCallState('speaking', 'Dax');
        await daxSpeak("I'll hang up for now. Call me any time.");
        break;
      }
      continue;
    }
    quiet = 0;
    if (/^(bye|goodbye|hang up|end (the )?call|stop)\b/i.test(said)) {
      setCallState('speaking', 'Dax');
      await daxSpeak('Okay, talk soon.');
      break;
    }
    if (heard) heard.textContent = `“${said}”`;
    setCallState('thinking', 'Dax is checking your trades…');
    const reply = await askDax(said, { voice: true });
    if (!call.active) break;
    setCallState('speaking', 'Dax');
    if (heard) heard.textContent = reply || '';
    await daxSpeak(reply || 'Sorry, I could not get an answer just now.');
  }
  endDaxCall();
};
window.endDaxCall = function endDaxCall() {
  if (daxc.call) daxc.call.active = false;
  daxc.call = null;
  try {
    daxc.rec?.abort();
  } catch {
    // ignore
  }
  window.speechSynthesis?.cancel();
  const el = document.getElementById('dc-call');
  if (el) el.hidden = true;
  const m = document.getElementById('dc-call-mute');
  if (m) {
    m.classList.remove('on');
    m.textContent = 'Mute';
  }
};
window.toggleDaxCallMute = function toggleDaxCallMute() {
  if (!daxc.call) return;
  daxc.call.muted = !daxc.call.muted;
  if (daxc.call.muted) {
    try {
      daxc.rec?.abort();
    } catch {
      // ignore
    }
  }
  const m = document.getElementById('dc-call-mute');
  if (m) {
    m.classList.toggle('on', daxc.call.muted);
    m.textContent = daxc.call.muted ? 'Unmute' : 'Mute';
  }
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && daxc.open && !document.querySelector('.modal-backdrop.open')) toggleDaxChat(false);
});


// ---------------------------------------------------------------------------
// Rent reclaim: SOL locked in the bot wallet's empty token accounts (≈0.002 SOL per coin)
// ---------------------------------------------------------------------------
const rentState = { preview: null, at: 0, loading: false };
function rentLineHtml() {
  const p = rentState.preview;
  if (!p) {
    if (Date.now() - rentState.at > 60_000) setTimeout(previewRent, 0);
    return 'Locked rent: checking…';
  }
  if (!p.ok) return `Locked rent: ${esc(p.error || 'unknown')}`;
  return p.found ? `Locked rent: <b>${p.foundSol.toFixed(4)} SOL</b> in ${p.found} empty token account${p.found === 1 ? '' : 's'} — reclaimed automatically after sells` : 'Locked rent: none — every empty token account is closed';
}
async function previewRent() {
  if (rentState.loading) return;
  rentState.loading = true;
  rentState.at = Date.now();
  try {
    rentState.preview = await (await fetch('/api/real/reclaim-rent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: true }) })).json();
  } catch {
    rentState.preview = { ok: false, error: 'could not check' };
  } finally {
    rentState.loading = false;
  }
  const el = document.getElementById('bw-rent');
  if (el) el.innerHTML = rentLineHtml();
}
window.reclaimRentNow = async function reclaimRentNow() {
  const btn = document.getElementById('bw-rent-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Reclaiming…';
  }
  try {
    const r = await (await fetch('/api/real/reclaim-rent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).json();
    if (!r.ok) showToast(r.error || 'Could not reclaim rent', 'danger');
    else if (!r.found) showToast('Nothing to reclaim — no empty token accounts', 'good');
    else showToast(`Reclaimed ${r.reclaimedSol.toFixed(4)} SOL from ${r.closed} empty token account${r.closed === 1 ? '' : 's'}${r.failed ? ` (${r.failed} could not be closed)` : ''}`, r.closed ? 'good' : 'danger');
  } catch {
    showToast('Could not reclaim rent', 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Reclaim rent';
    }
    rentState.preview = null;
    rentState.at = 0;
    previewRent();
  }
};
