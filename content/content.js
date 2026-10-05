// content/content.js
// Injects two independent overlays into the page: the avatar and the
// task/XP widget. Persists state via chrome.storage.local.

const STATE_KEY = 'studbudState';
const SETTINGS_KEY = 'studbudSettings';

const IDLE_AVATAR_SRC = chrome.runtime.getURL('idle_evol_1.png');
const FOCUS_AVATAR_SRC = chrome.runtime.getURL('active_evol_1.png');


const DEFAULT_SETTINGS = {
  avatarHidden: false,
  excludedSites: [],
};

// Basic flat-vector placeholder art per stage, matching the widget's indigo
// accent palette. Not final pixel art — swap `art` for real assets later
// without touching anything else (render() only ever reads .art / .label).
// Index = evolution stage (0, 1, 2). Adjust "min" xp thresholds as needed.
const EVOLUTION_STAGES = [
  {
    min: 0,
    label: 'Egg',
    idle: 'idle_evol_1.png',
    focus: 'active_evol_1.png',
  },
  
  {
    min: 50,
    label: 'Hatchling',
    idle: 'idle_evol_2.png',
    focus: 'active_evol_2.png',
      
  },
  {
    min: 150,
    label: 'Fledgling',
    art: `
      <svg viewBox="0 0 64 64" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="18" cy="36" rx="9" ry="13" fill="#818cf8" stroke="#4338ca" stroke-width="1.5" transform="rotate(-18 18 36)"/>
        <ellipse cx="46" cy="36" rx="9" ry="13" fill="#818cf8" stroke="#4338ca" stroke-width="1.5" transform="rotate(18 46 36)"/>
        <path d="M32 50 L26 58 L38 58 Z" fill="#6366f1"/>
        <circle cx="32" cy="32" r="20" fill="#6366f1" stroke="#4338ca" stroke-width="2"/>
        <path d="M26 14 L32 4 L36 14 Z" fill="#fbbf24"/>
        <circle cx="25" cy="29" r="4.5" fill="#ffffff"/>
        <circle cx="39" cy="29" r="4.5" fill="#ffffff"/>
        <circle cx="26" cy="30" r="2" fill="#1a1a1a"/>
        <circle cx="40" cy="30" r="2" fill="#1a1a1a"/>
        <path d="M28 37 L36 37 L32 42 Z" fill="#fbbf24"/>
      </svg>`,
  },
];

const FOCUS_DURATION_MS = 25 * 60 * 1000; // 25 minutes
const FOCUS_BONUS_XP = 5;

const DEFAULT_STATE = {
  currentTask: null,       // string or null (the pasted assignment text)
  taskTitle: null,         // short AI-generated name for the task (falls back to currentTask)
  subtasks: [],            // [{ kind, text, detail, done, ...kind-specific }]; kind is 'do' | 'copy' | 'citation' (missing = 'do')
  clarify: null,           // { round, questions, answers } while the server is asking for missing details, else null
  analysesUsed: 0,         // successful assignment analyses (beta cap, see ANALYSIS_LIMIT)
  currentSubtaskIndex: 0,  // which subtask is currently shown
  xp: 0,
  evolutionStage: 0,       // derived from xp, but stored to detect stage-up transitions
  taskWidgetMinimized: false,
  avatarMinimized: false,
  focusSession: null,      // { startedAt } while a focus timer is running, else null
};

function getStageForXp(xp) {
  let stageIndex = 0;
  for (let i = 0; i < EVOLUTION_STAGES.length; i++) {
    if (xp >= EVOLUTION_STAGES[i].min) stageIndex = i;
  }
  return stageIndex;
}

function getNextThreshold(stageIndex) {
  const next = EVOLUTION_STAGES[stageIndex + 1];
  return next ? next.min : null; // null means already at max stage
}

let state = { ...DEFAULT_STATE };

init();

async function init() {
  const settings = await loadSettings();
  const hostname = window.location.hostname.toLowerCase();
  const isExcluded = settings.excludedSites.some(
    (site) => hostname === site || hostname.endsWith('.' + site)
  );
  if (isExcluded) return; // don't inject anything on excluded sites

  state = await loadState();
  buildAvatar();
  buildTaskWidget();
  render();

  if (state.focusSession) {
    startFocusTicking(); // resume countdown after a reload/navigation
  }

  if (settings.avatarHidden) {
    document.getElementById('studbud-avatar').classList.add('studbud-hidden');
  }
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY], (result) => {
      resolve(result[SETTINGS_KEY] ? { ...DEFAULT_SETTINGS, ...result[SETTINGS_KEY] } : { ...DEFAULT_SETTINGS });
    });
  });
}

// Live-apply settings and state changes made in other tabs, so progress
// (subtasks, XP, current step, focus session) stays consistent everywhere
// without requiring a manual reload.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes[SETTINGS_KEY]) {
    const avatar = document.getElementById('studbud-avatar');
    if (avatar) {
      const newSettings = changes[SETTINGS_KEY].newValue || DEFAULT_SETTINGS;
      avatar.classList.toggle('studbud-hidden', !!newSettings.avatarHidden);
    }
  }

  if (changes[STATE_KEY] && changes[STATE_KEY].newValue) {
    const hadFocusSession = !!state.focusSession;
    state = { ...DEFAULT_STATE, ...changes[STATE_KEY].newValue };

    if (state.focusSession && !hadFocusSession) {
      startFocusTicking(); // a focus session was started in another tab
    } else if (!state.focusSession && hadFocusSession) {
      stopFocusTicking(); // it was stopped/completed elsewhere
    }

    render();
  }
});

function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STATE_KEY], (result) => {
      resolve(result[STATE_KEY] ? { ...DEFAULT_STATE, ...result[STATE_KEY] } : { ...DEFAULT_STATE });
    });
  });
}

function saveState() {
  chrome.storage.local.set({ [STATE_KEY]: state });
}

// ---------- Coming-soon feature interest tracking ----------
// No backend endpoint exists yet (pending a Vercel KV / Supabase decision —
// see the extension's planning notes), so this logs locally so nothing is
// lost, and separately fires a message that background.js will pick up
// once RECORD_INTEREST is implemented there. Until then the message is a
// harmless no-op (background.js just doesn't have a listener for it).

const ANON_ID_KEY = 'studbudAnonId';
const INTEREST_LOG_KEY = 'studbudInterestLog';
const INTEREST_LOG_MAX = 200; // cap so local storage doesn't grow unbounded

function getAnonId() {
  return new Promise((resolve) => {
    chrome.storage.local.get([ANON_ID_KEY], (result) => {
      if (result[ANON_ID_KEY]) {
        resolve(result[ANON_ID_KEY]);
        return;
      }
      const id = crypto.randomUUID();
      chrome.storage.local.set({ [ANON_ID_KEY]: id }, () => resolve(id));
    });
  });
}

async function recordInterest(feature, integrations) {
  const anonId = await getAnonId();
  const event = {
    anonId,
    feature,               // 'parser' | 'injection_system'
    integrations: integrations || [],
    timestamp: Date.now(),
  };

  chrome.storage.local.get([INTEREST_LOG_KEY], (result) => {
    const log = result[INTEREST_LOG_KEY] || [];
    log.push(event);
    while (log.length > INTEREST_LOG_MAX) log.shift();
    chrome.storage.local.set({ [INTEREST_LOG_KEY]: log });
  });

  // TODO: once /api/interest exists, add a RECORD_INTEREST handler in
  // background.js that POSTs `event` there. This call is future-proofed
  // for that; today it's a no-op if there's no listener.
  chrome.runtime.sendMessage({ type: 'RECORD_INTEREST', event }, () => {
    void chrome.runtime.lastError; // expected until background.js implements this
  });
}

// ---------- Avatar (bottom-right corner) ----------

function buildAvatar() {
  const avatar = document.createElement('div');
  avatar.id = 'studbud-avatar';
  avatar.innerHTML = `
    <div id="studbud-avatar-face">${EVOLUTION_STAGES[0].art}</div>
    <div id="studbud-avatar-xp"></div>
    <button id="studbud-avatar-toggle" title="Minimize">–</button>
  `;
  // documentElement, not body: some pages (e.g. Google search results) apply a
  // transform to elements under <body>, which turns it into the containing
  // block for position:fixed children and breaks viewport anchoring/scroll-tracking.
  document.documentElement.appendChild(avatar);

  document.getElementById('studbud-avatar-toggle').addEventListener('click', () => {
    state.avatarMinimized = !state.avatarMinimized;
    saveState();
    render();
  });
}

// ---------- Task widget (mid-bottom-right) ----------

function buildTaskWidget() {
  const widget = document.createElement('div');
  widget.id = 'studbud-task-widget';
  widget.innerHTML = `
    <div id="studbud-task-header">
      <span id="studbud-task-title">StudBud</span>
      <span id="studbud-task-mini-step"></span>
      <button id="studbud-task-toggle" title="Minimize">–</button>
    </div>
    <div id="studbud-task-mini"></div>
    <div id="studbud-task-body">
      <div id="studbud-subtask-current"></div>
      <div id="studbud-upsell">
        <button id="studbud-upsell-toggle" type="button">
          <span id="studbud-upsell-toggle-arrow">▸</span> More features coming soon!
        </button>
        <div id="studbud-upsell-panel" class="studbud-hidden">
          <div class="studbud-upsell-card">
            <div class="studbud-upsell-card-title">🔒 Smart Schedule Sync</div>
            <div class="studbud-upsell-card-desc">Connect Canvas, Google Calendar, Notion, and more so StudBud knows what's due and helps you pick what to work on next.</div>
            <button class="studbud-upsell-btn" id="studbud-upsell-btn-injection" data-feature="injection_system">Coming Soon — Interested?</button>
            <div id="studbud-integration-picker" class="studbud-hidden">
              <div class="studbud-integration-picker-label">Which would you actually use?</div>
              <label class="studbud-integration-option"><input type="checkbox" value="canvas" /> Canvas</label>
              <label class="studbud-integration-option"><input type="checkbox" value="blackboard" /> Blackboard</label>
              <label class="studbud-integration-option"><input type="checkbox" value="brightspace" /> Brightspace</label>
              <label class="studbud-integration-option"><input type="checkbox" value="google_calendar" /> Google Calendar</label>
              <label class="studbud-integration-option"><input type="checkbox" value="google_classroom" /> Google Classroom</label>
              <label class="studbud-integration-option"><input type="checkbox" value="google_docs" /> Google Docs</label>
              <label class="studbud-integration-option"><input type="checkbox" value="notion" /> Notion</label>
              <label class="studbud-integration-option"><input type="checkbox" value="todoist" /> Todoist</label>
              <button id="studbud-integration-submit">Submit</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(widget);

  document.getElementById('studbud-task-toggle').addEventListener('click', () => {
    state.taskWidgetMinimized = !state.taskWidgetMinimized;
    saveState();
    render();
  });

  document.getElementById('studbud-upsell-toggle').addEventListener('click', () => {
    const panel = document.getElementById('studbud-upsell-panel');
    const arrow = document.getElementById('studbud-upsell-toggle-arrow');
    const isOpen = panel.classList.toggle('studbud-hidden') === false;
    arrow.textContent = isOpen ? '▾' : '▸';
  });

  document.getElementById('studbud-upsell-btn-injection').addEventListener('click', (e) => {
    e.currentTarget.classList.add('studbud-hidden');
    document.getElementById('studbud-integration-picker').classList.remove('studbud-hidden');
  });

  document.getElementById('studbud-integration-submit').addEventListener('click', () => {
    const picker = document.getElementById('studbud-integration-picker');
    const integrations = Array.from(
      picker.querySelectorAll('input[type="checkbox"]:checked')
    ).map((el) => el.value);
    recordInterest('injection_system', integrations);
    picker.innerHTML = '<div class="studbud-upsell-thanks">✓ Thanks — we\'ll let you know!</div>';
  });
}

 
// ---------- Beta analytics ----------
// Anonymous counters only (see api/events.js). No assignment text or answers are ever sent.
// Events: plan_created | step_completed | plan_completed | finish_yes | finish_no
 
async function trackEvent(name, elapsedSec) {
  try {
    const anonId = await getAnonId();
    chrome.runtime.sendMessage({ type: 'RECORD_EVENT', event: { anonId, name, elapsedSec } }, () => {
      void chrome.runtime.lastError; // analytics must never break the UI
    });
  } catch (e) {
    /* ignore */
  }
}

// ---------- Assignment intake (required) ----------
// A breakdown is only built from a pasted assignment. If the text lacks key
// details the server first asks up to 2 rounds of clarifying questions.

const ANALYSIS_LIMIT = 5;      // beta cap on successful analyses per install. CLIENT-SIDE ONLY: clearing extension storage resets it.
const MIN_BRIEF_CHARS = 40;    // coarse client-side floor; the model does the real sufficiency check
const MAX_BRIEF_CHARS = 8000;  // keep in sync with MAX_BRIEF in api/breakdown.js

// UI-only drafts. Module variables (not saved state) so typing survives the
// re-renders that any saveState() triggers, without writing on every keystroke.
let intakeDraft = '';
let clarifyDrafts = [];
let fieldDraft = { key: '', value: '' };
let requestInFlight = false;
let intakeError = '';
let accessRequested = false;
let confirmDiscard = false;

function onSubmitIntake() {
  const brief = intakeDraft.trim();
  if (brief.length < MIN_BRIEF_CHARS) return;
  requestBreakdown(brief, [], 0);
}

// round = number of clarification rounds the student has already answered.
function requestBreakdown(brief, answers, round) {
  requestInFlight = true;
  intakeError = '';
  render();

  chrome.runtime.sendMessage({ type: 'BREAKDOWN_TASK', payload: { brief, answers, round } }, (response) => {
    requestInFlight = false;

    if (chrome.runtime.lastError || !response || !response.ok) {
      console.error('Breakdown failed:', (response && response.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message));
      intakeError = 'Could not analyze that. Your text is kept — try again.';
      render();
      return;
    }

    if (response.status === 'needs_info' && Array.isArray(response.questions) && response.questions.length > 0) {
      state.currentTask = brief;
      state.clarify = { round: round + 1, questions: response.questions, answers };
      clarifyDrafts = [];
      saveState();
      render();
      return;
    }

    if (response.status === 'ready' && Array.isArray(response.steps) && response.steps.length > 0) {
      state.currentTask = brief;
      state.taskTitle = (response.title && String(response.title).trim()) || brief.slice(0, 60);
      state.subtasks = response.steps.map(toStep);
      state.currentSubtaskIndex = 0;
      state.clarify = null;
      state.analysesUsed = (state.analysesUsed || 0) + 1;
      intakeDraft = '';
      clarifyDrafts = [];
      saveState();
      render();
      return;
    }

    intakeError = 'Got an unexpected response. Try again.';
    render();
  });
}

function toStep(s) {
  const base = { kind: s.kind, text: s.title, detail: s.detail || '', done: false };
  if (s.kind === 'copy') return { ...base, copyText: s.text };
  if (s.kind === 'citation') return { ...base, style: s.style, n: s.n, cite: { type: null, values: {}, fieldIndex: 0 } };
  return base;
}

function resetPlan() {
  state.subtasks = [];
  state.currentSubtaskIndex = 0;
  state.taskTitle = null;
  state.currentTask = null;
  state.clarify = null;
  confirmDiscard = false;
  intakeError = '';
  saveState();
  render();
}

function completeCurrentSubtask() {
  const index = state.currentSubtaskIndex;
  if (index >= state.subtasks.length) return;

  state.subtasks[index].done = true;
  confirmDiscard = false;
  state.xp += 10;
  state.currentSubtaskIndex += 1;

  // The focus session is session-level, not step-level: it keeps running
  // across step completion and only ends on timeout or "Stop".

  // render() first: it recomputes state.evolutionStage from the new xp, so
  // saveState() persists the corrected value instead of a stale one (which
  // caused the evolve animation to falsely re-fire on the next page load).
  render();
  saveState();
  playCompleteAnimation();
}

function playCompleteAnimation() {
  const widget = document.getElementById('studbud-task-widget');
  if (!widget) return;
  const avatar = document.getElementById('studbud-avatar');
  const glowTargets = [widget, avatar].filter(Boolean);

  glowTargets.forEach((el) => el.classList.remove('studbud-step-complete'));
  void widget.offsetWidth; // force reflow so the animation restarts
  glowTargets.forEach((el) => el.classList.add('studbud-step-complete'));
  setTimeout(() => glowTargets.forEach((el) => el.classList.remove('studbud-step-complete')), 700);

  const pop = document.createElement('div');
  pop.className = 'studbud-xp-pop';
  pop.textContent = '+10 XP';
  widget.appendChild(pop);
  setTimeout(() => pop.remove(), 900);
}

// ---------- Focus sessions ----------
// Purely optional and reward-based: no site-blocking, no penalty for
// stopping early. The point is to encourage sustained work, not enforce it.

let focusTickInterval = null;

function startFocusSession() {
  state.focusSession = { startedAt: Date.now() };
  saveState();
  startFocusTicking();
  renderFocusArea();
  renderMini();
}

function stopFocusSession(awardBonus) {
  if (awardBonus) {
    state.xp += FOCUS_BONUS_XP;
  }
  state.focusSession = null;
  stopFocusTicking();
  render(); // recomputes evolutionStage from xp before it's persisted below
  saveState();
}

function startFocusTicking() {
  stopFocusTicking(); // guard against duplicate intervals
  focusTickInterval = setInterval(async () => {
    if (!state.focusSession) {
      stopFocusTicking();
      return;
    }
    const elapsed = Date.now() - state.focusSession.startedAt;
    if (elapsed >= FOCUS_DURATION_MS) {
      // Re-check storage (not just local memory) — if another open tab
      // already completed and cleared this exact session, don't double-award.
      const stillActive = await isSessionStillActive(state.focusSession.startedAt);
      if (stillActive) {
        stopFocusSession(true);
      } else {
        state.focusSession = null;
        stopFocusTicking();
        render();
      }
    } else {
      updateFocusTimerText();
    }
  }, 1000);
}

function isSessionStillActive(expectedStartedAt) {
  return new Promise((resolve) => {
    chrome.storage.local.get([STATE_KEY], (result) => {
      const stored = result[STATE_KEY];
      resolve(!!(stored && stored.focusSession && stored.focusSession.startedAt === expectedStartedAt));
    });
  });
}

function stopFocusTicking() {
  if (focusTickInterval) {
    clearInterval(focusTickInterval);
    focusTickInterval = null;
  }
}

// ---------- Render ----------

function render() {
  const avatar = document.getElementById('studbud-avatar');
  avatar.classList.toggle('minimized', state.avatarMinimized);

  const widget = document.getElementById('studbud-task-widget');
  widget.classList.toggle('minimized', state.taskWidgetMinimized);

  const avatarToggle = document.getElementById('studbud-avatar-toggle');
  avatarToggle.textContent = state.avatarMinimized ? '+' : '–';
  avatarToggle.title = state.avatarMinimized ? 'Expand' : 'Minimize';

  const taskToggle = document.getElementById('studbud-task-toggle');
  taskToggle.textContent = state.taskWidgetMinimized ? '+' : '–';
  taskToggle.title = state.taskWidgetMinimized ? 'Expand' : 'Minimize';

  const newStage = getStageForXp(state.xp);
  const stageChanged = newStage !== state.evolutionStage;
  state.evolutionStage = newStage;

  const face = document.getElementById('studbud-avatar-face');

// Get the stage object for the current XP level
const stageConfig = EVOLUTION_STAGES[newStage];

// Select either the focus or idle image for this specific stage
const currentFilename = state.focusSession ? stageConfig.focus : stageConfig.idle;
const avatarSrc = chrome.runtime.getURL(currentFilename);

face.innerHTML = `<img src="${avatarSrc}" alt="Avatar" style="width: 100%; height: 100%; object-fit: contain;" />`;
avatar.title = state.focusSession ? 'Focusing...' : stageConfig.label;

  const nextThreshold = getNextThreshold(newStage);
  const xpLabel = document.getElementById('studbud-avatar-xp');
  xpLabel.textContent = nextThreshold !== null
    ? `${state.xp}/${nextThreshold} XP`
    : `${state.xp} XP (max)`;

  if (stageChanged) {
    avatar.classList.add('studbud-evolved');
    setTimeout(() => avatar.classList.remove('studbud-evolved'), 1200);
  }

  renderCurrentSubtask();
  renderMini();
}

function renderCurrentSubtask() {
  const container = document.getElementById('studbud-subtask-current');
  const { subtasks, currentSubtaskIndex } = state;

  // #studbud-focus-area is present in every view so a running focus session stays visible.
  const focusSlot = `<div id="studbud-focus-area"></div>`;

  if (requestInFlight) {
    container.innerHTML = `<div class="studbud-loading">Analyzing your assignment…</div>${focusSlot}`;
    renderFocusArea();
    return;
  }

  if (state.clarify) {
    renderClarify(container, focusSlot);
  } else if (subtasks.length === 0) {
    renderIntake(container, focusSlot);
  } else if (currentSubtaskIndex >= subtasks.length) {
    container.innerHTML = `
      <div class="studbud-step-done">All steps done! 🎉</div>
      <button id="studbud-new-task" class="studbud-primary-btn">Start a new assignment</button>
      ${focusSlot}`;
    document.getElementById('studbud-new-task').addEventListener('click', resetPlan);
  } else {
    renderStep(container, focusSlot);
  }
  renderFocusArea();
}

function intakeErrorHtml() {
  return intakeError ? `<div class="studbud-error">${escapeHtml(intakeError)}</div>` : '';
}

function renderIntake(container, focusSlot) {
  const left = ANALYSIS_LIMIT - (state.analysesUsed || 0);

  if (left <= 0) {
    container.innerHTML = `
      <div class="studbud-intake-title">Beta limit reached</div>
      <div class="studbud-intake-sub">You've used all ${ANALYSIS_LIMIT} beta assignment analyses. Request more and we'll follow up.</div>
      <button id="studbud-more-access" class="studbud-primary-btn">${accessRequested ? '✓ Requested — thanks!' : 'Request more access'}</button>
      ${focusSlot}`;
    const btn = document.getElementById('studbud-more-access');
    btn.disabled = accessRequested;
    btn.addEventListener('click', () => {
      accessRequested = true;
      recordInterest('parser'); // reuses the existing interest event; the analyzer is now the gated beta feature
      btn.textContent = '✓ Requested — thanks!';
      btn.disabled = true;
    });
    return;
  }

  container.innerHTML = `
    <div class="studbud-intake-title">Paste your assignment</div>
    <div class="studbud-intake-sub">Include the prompt, requirements, and rubric if you have them. Your steps are built from this text.</div>
    <textarea id="studbud-task-input" rows="6" maxlength="${MAX_BRIEF_CHARS}" placeholder="Paste your full assignment instructions here"></textarea>
    <div class="studbud-intake-meta"><span id="studbud-intake-hint"></span><span>${left} of ${ANALYSIS_LIMIT} analyses left</span></div>
    ${intakeErrorHtml()}
    <button id="studbud-task-submit" class="studbud-primary-btn" disabled>Analyze assignment</button>
    ${focusSlot}`;

  const input = document.getElementById('studbud-task-input');
  const submit = document.getElementById('studbud-task-submit');
  const hint = document.getElementById('studbud-intake-hint');
  input.value = intakeDraft;

  const update = () => {
    const len = input.value.trim().length;
    submit.disabled = len < MIN_BRIEF_CHARS;
    hint.textContent = len < MIN_BRIEF_CHARS ? `${MIN_BRIEF_CHARS - len} more characters needed` : '';
  };
  input.addEventListener('input', () => {
    intakeDraft = input.value;
    update();
  });
  submit.addEventListener('click', onSubmitIntake);
  update();
}

function renderClarify(container, focusSlot) {
  const { questions } = state.clarify;
  container.innerHTML = `
    <div class="studbud-intake-title">A few details first</div>
    <div class="studbud-intake-sub">StudBud needs these to build accurate steps.</div>
    ${questions.map((q, i) => `
      <label class="studbud-field-label" for="studbud-clarify-${i}">${escapeHtml(q)}</label>
      <input id="studbud-clarify-${i}" class="studbud-field-input" type="text" maxlength="300" />`).join('')}
    ${intakeErrorHtml()}
    <button id="studbud-clarify-submit" class="studbud-primary-btn" disabled>Build my steps</button>
    <button id="studbud-clarify-cancel" class="studbud-link-btn">Start over</button>
    ${focusSlot}`;

  const submit = document.getElementById('studbud-clarify-submit');
  const update = () => {
    submit.disabled = !questions.every((_, i) => (clarifyDrafts[i] || '').trim());
  };

  questions.forEach((_, i) => {
    const input = document.getElementById(`studbud-clarify-${i}`);
    input.value = clarifyDrafts[i] || '';
    input.addEventListener('input', () => {
      clarifyDrafts[i] = input.value;
      update();
    });
  });
  update();

  submit.addEventListener('click', () => {
    const answers = [
      ...state.clarify.answers,
      ...questions.map((q, i) => ({ question: q, answer: clarifyDrafts[i].trim() })),
    ];
    requestBreakdown(state.currentTask, answers, state.clarify.round);
  });
  document.getElementById('studbud-clarify-cancel').addEventListener('click', () => {
    state.clarify = null; // intakeDraft still holds the pasted text
    intakeDraft = state.currentTask || intakeDraft;
    clarifyDrafts = [];
    intakeError = '';
    saveState();
    render();
  });
}

function stepHeaderHtml(step) {
  const title = (state.taskTitle || state.currentTask || '').slice(0, 60);
  return `
    <div class="studbud-current-task">Current Task: ${escapeHtml(title)}</div>
    <div class="studbud-step-progress">Step ${state.currentSubtaskIndex + 1} of ${state.subtasks.length}</div>`;
}

function planFooterHtml() {
  return `<button id="studbud-new-task" class="studbud-link-btn">${confirmDiscard ? 'Click again to discard this plan' : 'Start a new assignment'}</button>`;
}

function wirePlanFooter() {
  const btn = document.getElementById('studbud-new-task');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!confirmDiscard) {
      confirmDiscard = true;
      render();
      return;
    }
    resetPlan();
  });
}

function renderStep(container, focusSlot) {
  const step = state.subtasks[state.currentSubtaskIndex];
  if (step.kind === 'citation') {
    renderCitationStep(container, focusSlot, step);
    return;
  }

  const copyBlock = step.kind === 'copy' && step.copyText
    ? `<div class="studbud-copy-box">${escapeHtml(step.copyText)}</div>
       <button id="studbud-copy-btn" class="studbud-secondary-btn">Copy to clipboard</button>`
    : '';

  container.innerHTML = `
    ${stepHeaderHtml(step)}
    <div class="studbud-step-text">${escapeHtml(step.text)} <span class="studbud-step-xp">+10 XP</span></div>
    ${step.detail ? `<div class="studbud-step-detail">${escapeHtml(step.detail)}</div>` : ''}
    ${copyBlock}
    ${focusSlot}
    <button id="studbud-step-next">Next Step →</button>
    ${planFooterHtml()}
  `;

  document.getElementById('studbud-step-next').addEventListener('click', completeCurrentSubtask);
  const copyBtn = document.getElementById('studbud-copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      flashCopyResult(copyBtn, copyRich(escapeHtml(step.copyText).replace(/\n/g, '<br>'), step.copyText), 'Copy to clipboard');
    });
  }
  wirePlanFooter();
}

// Shows "Copied ✓" / "Copy failed" on the button briefly, then restores its label.
function flashCopyResult(btn, copyPromise, restoreLabel) {
  copyPromise.then((ok) => {
    btn.textContent = ok ? 'Copied ✓' : 'Copy failed — select the text and copy it manually';
    setTimeout(() => { if (btn.isConnected) btn.textContent = restoreLabel; }, 1800);
  });
}

// ---- Citation micro-steps: pick source type -> one field at a time -> formatted result ----

function renderCitationStep(container, focusSlot, step) {
  const cite = step.cite;
  const styleLabel = step.style === 'apa7' ? 'APA 7' : 'MLA 9';
  const head = `${stepHeaderHtml(step)}
    <div class="studbud-step-text">${escapeHtml(step.text)} <span class="studbud-step-xp">+10 XP</span></div>
    ${step.detail ? `<div class="studbud-step-detail">${escapeHtml(step.detail)}</div>` : ''}`;

  // 1) choose the source type
  if (!cite.type) {
    container.innerHTML = `
      ${head}
      <div class="studbud-field-label">Source ${step.n}: what kind of source is it? (${styleLabel})</div>
      <div class="studbud-type-row">
        ${CITE_TYPES.map((t) => `<button class="studbud-type-btn" data-type="${t.id}">${t.label}</button>`).join('')}
      </div>
      ${focusSlot}
      ${planFooterHtml()}`;
    container.querySelectorAll('.studbud-type-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        cite.type = btn.dataset.type;
        cite.fieldIndex = 0;
        cite.values = {};
        saveState();
        render();
      });
    });
    wirePlanFooter();
    return;
  }

  const fields = CITE_FIELDS[cite.type];
  const typeLabel = CITE_TYPES.find((t) => t.id === cite.type).label;

  // 2) one field at a time
  if (cite.fieldIndex < fields.length) {
    const f = fields[cite.fieldIndex];
    const key = `${state.currentSubtaskIndex}:${cite.fieldIndex}`;
    if (fieldDraft.key !== key) fieldDraft = { key, value: cite.values[f.key] || '' };

    const isAuthors = f.key === 'authors';
    const control = isAuthors
      ? `<textarea id="studbud-cite-input" class="studbud-field-input" rows="3" placeholder="${f.hint}"></textarea>`
      : `<input id="studbud-cite-input" class="studbud-field-input" type="text" placeholder="${f.hint}" />`;

    container.innerHTML = `
      ${head}
      <div class="studbud-step-progress">Source ${step.n} · ${typeLabel} · field ${cite.fieldIndex + 1} of ${fields.length}</div>
      <label class="studbud-field-label" for="studbud-cite-input">${f.prompt}${f.optional ? ' (optional)' : ''}</label>
      ${control}
      ${isAuthors ? '<div class="studbud-note">One author per line as Last, First. For an organization, type its name.</div><div id="studbud-author-preview" class="studbud-author-preview"></div>' : ''}
      <button id="studbud-cite-next" class="studbud-primary-btn">Next</button>
      <button id="studbud-cite-back" class="studbud-link-btn">← Back</button>
      ${focusSlot}
      ${planFooterHtml()}`;

    const input = document.getElementById('studbud-cite-input');
    const next = document.getElementById('studbud-cite-next');
    const preview = document.getElementById('studbud-author-preview');
    input.value = fieldDraft.value;

    const update = () => {
      const has = input.value.trim().length > 0;
      next.disabled = !f.optional && !has;
      next.textContent = f.optional && !has ? 'Skip' : 'Next';
      if (preview) preview.textContent = has ? `→ ${previewAuthors(step.style, input.value)}` : '';
    };
    input.addEventListener('input', () => {
      fieldDraft.value = input.value;
      update();
    });
    next.addEventListener('click', () => {
      cite.values[f.key] = input.value.trim();
      cite.fieldIndex += 1;
      saveState();
      render();
    });
    document.getElementById('studbud-cite-back').addEventListener('click', () => {
      if (cite.fieldIndex > 0) cite.fieldIndex -= 1;
      else cite.type = null;
      saveState();
      render();
    });
    update();
    wirePlanFooter();
    return;
  }

  // 3) formatted result
  const out = formatCitation(step.style, cite.type, cite.values);
  container.innerHTML = `
    ${head}
    <div class="studbud-field-label">Source ${step.n} is ready. Paste it into your document.</div>
    <div class="studbud-cite-preview">${out.html}</div>
    <div class="studbud-note">${CITE_NOTES[step.style] || ''}</div>
    <button id="studbud-cite-copy" class="studbud-primary-btn">Copy citation</button>
    <button id="studbud-step-next">Done — Next Step →</button>
    <button id="studbud-cite-back" class="studbud-link-btn">← Edit fields</button>
    ${focusSlot}
    ${planFooterHtml()}`;

  const copyBtn = document.getElementById('studbud-cite-copy');
  copyBtn.addEventListener('click', () => flashCopyResult(copyBtn, copyRich(out.html, out.text), 'Copy citation'));
  document.getElementById('studbud-step-next').addEventListener('click', completeCurrentSubtask);
  document.getElementById('studbud-cite-back').addEventListener('click', () => {
    cite.fieldIndex = fields.length - 1;
    saveState();
    render();
  });
  wirePlanFooter();
}

function renderFocusArea() {
  const container = document.getElementById('studbud-focus-area');
  if (!container) return;

  const stepsLeft = state.subtasks.length > 0 && state.currentSubtaskIndex < state.subtasks.length;
  if (!state.focusSession && !stepsLeft) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = renderFocusControls();
  wireFocusControls();
}

// Compact summary shown only while the task widget is minimized (see CSS).
// The current step sits in the header row next to "StudBud"; the timer sits below it.
function renderMini() {
  const miniStep = document.getElementById('studbud-task-mini-step');
  const mini = document.getElementById('studbud-task-mini');
  if (!miniStep || !mini) return;

  const { subtasks, currentSubtaskIndex } = state;
  let stepText = '';

  if (subtasks.length > 0) {
    stepText = currentSubtaskIndex < subtasks.length
      ? `${currentSubtaskIndex + 1}/${subtasks.length}: ${subtasks[currentSubtaskIndex].text}`
      : 'All steps done 🎉';
  }
  miniStep.textContent = stepText;
  miniStep.title = stepText; // full text on hover when truncated

  mini.innerHTML = state.focusSession
    ? `<div class="studbud-focus-timer">🎯 <span class="studbud-focus-time">${getRemainingText()}</span></div>`
    : '';
}

function getRemainingText() {
  const elapsed = Date.now() - state.focusSession.startedAt;
  const remainingMs = Math.max(0, FOCUS_DURATION_MS - elapsed);
  const mins = Math.floor(remainingMs / 60000);
  const secs = Math.floor((remainingMs % 60000) / 1000);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Per-second update: change only the time text so buttons aren't rebuilt mid-click.
function updateFocusTimerText() {
  if (!state.focusSession) return;
  const text = getRemainingText();
  document.querySelectorAll('.studbud-focus-time').forEach((el) => {
    el.textContent = text;
  });
}

function renderFocusControls() {
  if (state.focusSession) {
    return `
      <div class="studbud-focus-active">
        <span class="studbud-focus-timer">🎯 Focusing — <span class="studbud-focus-time">${getRemainingText()}</span></span>
        <button id="studbud-focus-stop">Stop</button>
      </div>
    `;
  }
  return `
    <button id="studbud-focus-start">Start 25-min focus session <span class="studbud-step-xp">+5 XP</span></button>
  `;
}

function wireFocusControls() {
  const startBtn = document.getElementById('studbud-focus-start');
  if (startBtn) startBtn.addEventListener('click', startFocusSession);

  const stopBtn = document.getElementById('studbud-focus-stop');
  if (stopBtn) stopBtn.addEventListener('click', () => stopFocusSession(false));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== BEGIN CITATION FORMATTER (pure functions: no DOM, no chrome.*) =====
// Citations are formatted here, deterministically, never by the language model.
// Known limits: titles are used exactly as typed (no automatic case conversion),
// author suffixes such as "Jr." are not special-cased, and only three source
// types per style are supported.

const CITE_TYPES = [
  { id: 'journal', label: 'Journal article' },
  { id: 'book', label: 'Book' },
  { id: 'website', label: 'Website' },
];

const CITE_FIELDS = {
  journal: [
    { key: 'authors', prompt: 'Paste the author names', hint: 'Smith, Jane' },
    { key: 'year', prompt: 'Paste the year published', hint: '2021' },
    { key: 'title', prompt: 'Paste the article title', hint: 'Article title' },
    { key: 'container', prompt: 'Paste the journal name', hint: 'Journal name' },
    { key: 'volume', prompt: 'Paste the volume number', hint: '12', optional: true },
    { key: 'issue', prompt: 'Paste the issue number', hint: '3', optional: true },
    { key: 'pages', prompt: 'Paste the page range', hint: '45-67', optional: true },
    { key: 'url', prompt: 'Paste the DOI or URL', hint: '10.1000/xyz123 or https://...', optional: true },
  ],
  book: [
    { key: 'authors', prompt: 'Paste the author names', hint: 'Smith, Jane' },
    { key: 'year', prompt: 'Paste the year published', hint: '2019' },
    { key: 'title', prompt: 'Paste the book title', hint: 'Book title' },
    { key: 'publisher', prompt: 'Paste the publisher', hint: 'Publisher name' },
  ],
  website: [
    { key: 'authors', prompt: 'Paste the author or organization', hint: 'Smith, Jane', optional: true },
    { key: 'year', prompt: 'Paste the publication year or date', hint: '2022', optional: true },
    { key: 'title', prompt: 'Paste the page title', hint: 'Page title' },
    { key: 'container', prompt: 'Paste the website name', hint: 'Website name', optional: true },
    { key: 'url', prompt: 'Paste the URL', hint: 'https://...' },
  ],
};

const CITE_NOTES = {
  apa7: 'APA uses sentence case for article, book and page titles. Check your capitalization.',
  mla9: 'MLA uses title case for titles. Check your capitalization.',
};

function citeEscape(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// One entry per line (or ';'). "Last, First Middle" is a person; a line with no comma is kept as-is (organization).
function parseAuthorLines(raw) {
  return String(raw || '')
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(',');
      if (idx === -1) return { org: true, name: line };
      const last = line.slice(0, idx).trim();
      const firsts = line.slice(idx + 1).replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
      if (!last || firsts.length === 0) return { org: true, name: line.replace(/,/g, ' ').trim() };
      return { org: false, last, firsts };
    });
}

function apaInitials(firsts) {
  return firsts
    .map((t) => t.replace(/\./g, '').split('-').filter(Boolean).map((p) => p[0].toUpperCase() + '.').join('-'))
    .filter(Boolean)
    .join(' ');
}

function withPeriod(str) {
  return /\.$/.test(str) ? str : str + '.';
}

function apaAuthors(entries) {
  const names = entries.map((a) => (a.org ? a.name : `${a.last}, ${apaInitials(a.firsts)}`));
  let out;
  if (names.length === 1) out = names[0];
  else if (names.length === 2) out = `${names[0]}, & ${names[1]}`;
  else if (names.length <= 20) out = `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  else out = `${names.slice(0, 19).join(', ')}, . . . ${names[names.length - 1]}`;
  return withPeriod(out);
}

function mlaAuthors(entries) {
  const first = entries[0];
  const firstName = first.org ? first.name : `${first.last}, ${first.firsts.join(' ')}`;
  let out;
  if (entries.length === 1) {
    out = firstName;
  } else if (entries.length === 2) {
    const b = entries[1];
    out = `${firstName}, and ${b.org ? b.name : `${b.firsts.join(' ')} ${b.last}`}`;
  } else {
    out = `${firstName}, et al.`;
  }
  return withPeriod(out);
}

function previewAuthors(style, raw) {
  const entries = parseAuthorLines(raw);
  if (entries.length === 0) return '';
  return style === 'mla9' ? mlaAuthors(entries) : apaAuthors(entries);
}

const normPages = (p) => String(p).trim().replace(/\s*[-–—]+\s*/g, '–');
const normUrl = (u) => (/^10\.\d{4,9}\//.test(String(u).trim()) ? 'https://doi.org/' + String(u).trim() : String(u).trim());
const endPunct = (t) => (/[.?!]$/.test(t) ? '' : '.');
const seg = (t, i) => ({ t, i: !!i });

function renderSegs(segs) {
  return {
    text: segs.map((x) => x.t).join(''),
    html: segs.map((x) => (x.i ? `<i>${citeEscape(x.t)}</i>` : citeEscape(x.t))).join(''),
  };
}

// Join segments with ', ' and end with a period (MLA container/location elements).
function mlaTail(list) {
  const out = [];
  list.forEach((x, idx) => {
    if (idx > 0) out.push(seg(', '));
    out.push(x);
  });
  out.push(seg('.'));
  return out;
}

function formatAPA(type, v) {
  const entries = parseAuthorLines(v.authors);
  const a = entries.length ? apaAuthors(entries) : '';
  const year = (v.year || '').trim() || 'n.d.';
  const title = (v.title || '').trim();
  const url = (v.url || '').trim();
  const segs = [];

  if (type === 'journal') {
    segs.push(seg(`${a} (${year}). `), seg(`${title}${endPunct(title)} `), seg(v.container.trim(), true));
    if (v.volume) segs.push(seg(', '), seg(v.volume.trim(), true));
    if (v.issue) segs.push(seg(`(${v.issue.trim()})`));
    if (v.pages) segs.push(seg(`, ${normPages(v.pages)}`));
    segs.push(seg('.'));
    if (url) segs.push(seg(` ${normUrl(url)}`));
  } else if (type === 'book') {
    segs.push(seg(`${a} (${year}). `), seg(title, true), seg(`${endPunct(title)} `), seg(withPeriod((v.publisher || '').trim())));
  } else {
    if (a) segs.push(seg(`${a} (${year}). `), seg(title, true), seg(`${endPunct(title)}`));
    else segs.push(seg(title, true), seg(`${endPunct(title)} (${year}).`));
    if (v.container) segs.push(seg(` ${withPeriod(v.container.trim())}`));
    if (url) segs.push(seg(` ${normUrl(url)}`));
  }
  return renderSegs(segs);
}

function formatMLA(type, v) {
  const entries = parseAuthorLines(v.authors);
  const a = entries.length ? mlaAuthors(entries) : '';
  const year = (v.year || '').trim();
  const title = (v.title || '').trim();
  const url = (v.url || '').trim();
  const segs = [];

  if (type === 'journal') {
    const parts = [seg(v.container.trim(), true)];
    if (v.volume) parts.push(seg(`vol. ${v.volume.trim()}`));
    if (v.issue) parts.push(seg(`no. ${v.issue.trim()}`));
    if (year) parts.push(seg(year));
    if (v.pages) {
      const np = normPages(v.pages);
      parts.push(seg(`${np.includes('–') ? 'pp.' : 'p.'} ${np}`));
    }
    if (url) parts.push(seg(normUrl(url)));
    segs.push(seg(`${a} “${title}${endPunct(title)}” `), ...mlaTail(parts));
  } else if (type === 'book') {
    segs.push(seg(`${a} `), seg(title, true), seg(`${endPunct(title)} `), seg(`${(v.publisher || '').trim()}, ${year}.`));
  } else {
    if (a) segs.push(seg(`${a} `));
    segs.push(seg(`“${title}${endPunct(title)}” `));
    const parts = [];
    if (v.container) parts.push(seg(v.container.trim(), true));
    if (year) parts.push(seg(year));
    if (url) parts.push(seg(normUrl(url)));
    segs.push(...mlaTail(parts));
  }
  return renderSegs(segs);
}

// -> { html, text }  (html has <i> for italics; text is plain)
function formatCitation(style, type, values) {
  return style === 'mla9' ? formatMLA(type, values) : formatAPA(type, values);
}
// ===== END CITATION FORMATTER =====

// Copies rich text (italics survive pasting into Docs/Word) with a plain-text fallback.
async function copyRich(html, text) {
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.documentElement.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}
