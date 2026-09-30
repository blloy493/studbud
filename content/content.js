// content/content.js
// Injects two independent overlays into the page: the avatar and the
// task/XP widget. Persists state via chrome.storage.local.

const STATE_KEY = 'studbudState';
const SETTINGS_KEY = 'studbudSettings';

const DEFAULT_SETTINGS = {
  avatarHidden: false,
  excludedSites: [],
};

// Placeholder emoji per stage until real avatar art exists.
// Index = evolution stage (0, 1, 2). Adjust "min" xp thresholds as needed.
const EVOLUTION_STAGES = [
  { min: 0, emoji: '🥚', label: 'Egg' },
  { min: 50, emoji: '🐣', label: 'Hatchling' },
  { min: 150, emoji: '🐥', label: 'Fledgling' },
];

const FOCUS_DURATION_MS = 25 * 60 * 1000; // 25 minutes
const FOCUS_BONUS_XP = 5;

const DEFAULT_STATE = {
  currentTask: null,       // string or null (raw text the user typed)
  taskTitle: null,         // short AI-generated name for the task (falls back to currentTask)
  subtasks: [],            // [{ text, done }]
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

// Live-apply the hide-avatar setting without requiring a page reload.
// (Site-exclusion changes still require a reload — see init().)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes[SETTINGS_KEY]) {
    const avatar = document.getElementById('studbud-avatar');
    if (avatar) {
      const newSettings = changes[SETTINGS_KEY].newValue || DEFAULT_SETTINGS;
      avatar.classList.toggle('studbud-hidden', !!newSettings.avatarHidden);
    }
  }

  // Keep multiple open tabs in sync on the focus session specifically,
  // so a session completed in one tab doesn't keep ticking in others.
  if (changes[STATE_KEY]) {
    const newFocusSession = changes[STATE_KEY].newValue && changes[STATE_KEY].newValue.focusSession;
    if (!newFocusSession && state.focusSession) {
      state.focusSession = null;
      stopFocusTicking();
      renderFocusArea();
      renderMini();
    }
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
    <div id="studbud-avatar-face">${EVOLUTION_STAGES[0].emoji}</div>
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
      <input id="studbud-task-input" type="text" placeholder="What are you working on?" />
      <button id="studbud-task-submit">Break it down</button>
      <div id="studbud-subtask-current"></div>
      <div id="studbud-upsell">
        <button id="studbud-upsell-toggle" type="button">
          <span id="studbud-upsell-toggle-arrow">▸</span> More features coming soon
        </button>
        <div id="studbud-upsell-panel" class="studbud-hidden">
          <div class="studbud-upsell-card">
            <div class="studbud-upsell-card-title">🔒 Syllabus &amp; Rubric Parser</div>
            <div class="studbud-upsell-card-desc">Drop in your syllabus, rubric, or assignment brief and get a breakdown built from the exact requirements — not a guess.</div>
            <button class="studbud-upsell-btn" id="studbud-upsell-btn-parser" data-feature="parser">Coming Soon</button>
          </div>
          <div class="studbud-upsell-card">
            <div class="studbud-upsell-card-title">🔒 Smart Schedule Sync</div>
            <div class="studbud-upsell-card-desc">Connect Canvas, Google Calendar, Notion, and more so StudBud knows what's due and helps you pick what to work on next.</div>
            <button class="studbud-upsell-btn" id="studbud-upsell-btn-injection" data-feature="injection_system">Coming Soon</button>
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

  document.getElementById('studbud-upsell-btn-parser').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    recordInterest('parser');
    btn.textContent = '✓ Thanks — noted!';
    btn.disabled = true;
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

  document.getElementById('studbud-task-submit').addEventListener('click', onSubmitTask);
  document.getElementById('studbud-task-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSubmitTask();
  });
}

function onSubmitTask() {
  const input = document.getElementById('studbud-task-input');
  const task = input.value.trim();
  if (!task) return;

  state.currentTask = task;
  state.taskTitle = null;
  state.subtasks = [];
  state.currentSubtaskIndex = 0;
  render(); // show a loading state immediately

  const submitBtn = document.getElementById('studbud-task-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Thinking...';

  chrome.runtime.sendMessage({ type: 'BREAKDOWN_TASK', task }, (response) => {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Break it down';

    if (!response || !response.ok) {
      console.error('Breakdown failed:', response && response.error);
      alert('Could not break down that task. Try again.');
      return;
    }

    // response.title is optional until the API is updated; fall back to what the user typed.
    state.taskTitle = (response.title && String(response.title).trim()) || task;
    state.subtasks = response.subtasks.map((text) => ({ text, done: false }));
    saveState();
    render();
  });

  input.value = '';
}

function completeCurrentSubtask() {
  const index = state.currentSubtaskIndex;
  if (index >= state.subtasks.length) return;

  state.subtasks[index].done = true;
  state.xp += 10;
  state.currentSubtaskIndex += 1;

  // The focus session is session-level, not step-level: it keeps running
  // across step completion and only ends on timeout or "Stop".

  saveState();
  render();
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
  saveState();
  render(); // full render so XP/evolution updates if the bonus was awarded
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
  face.textContent = EVOLUTION_STAGES[newStage].emoji;
  avatar.title = EVOLUTION_STAGES[newStage].label;

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

  // #studbud-focus-area is always present so a running focus session stays
  // visible even when there are no steps left (or no steps yet).
  const focusSlot = `<div id="studbud-focus-area"></div>`;

  if (subtasks.length === 0) {
    container.innerHTML = focusSlot;
    renderFocusArea();
    return;
  }

  if (currentSubtaskIndex >= subtasks.length) {
    container.innerHTML = `<div class="studbud-step-done">All steps done! 🎉</div>${focusSlot}`;
    renderFocusArea();
    return;
  }

  const step = subtasks[currentSubtaskIndex];
  const title = state.taskTitle || state.currentTask || '';
  container.innerHTML = `
    <div class="studbud-current-task">Current Task: ${escapeHtml(title)}</div>
    <div class="studbud-step-progress">Step ${currentSubtaskIndex + 1} of ${subtasks.length}</div>
    <div class="studbud-step-text">${escapeHtml(step.text)} <span class="studbud-step-xp">+10 XP</span></div>
    ${focusSlot}
    <button id="studbud-step-next">Next Step →</button>
  `;

  document.getElementById('studbud-step-next').addEventListener('click', completeCurrentSubtask);
  renderFocusArea();
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
