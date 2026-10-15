// content/content.js
// Injects two independent overlays into the page: the avatar and the
// task/XP widget. Persists state via chrome.storage.local.

const STATE_KEY = 'studbudState';
const SETTINGS_KEY = 'studbudSettings';

// Avatar name lives in its own key (not STATE_KEY) so "Reset progress" in the
// popup, which only removes STATE_KEY, cannot erase it.
const AVATAR_KEY = 'studbudAvatar';
const DEFAULT_NAME = 'Hoot';
const MAX_NAME_LEN = 16;
const DEFAULT_AVATAR = { name: DEFAULT_NAME, chosen: false }; // chosen = student has answered the naming prompt
let avatarProfile = { ...DEFAULT_AVATAR };

function cleanName(raw) {
  const n = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
  return n || DEFAULT_NAME;
}

function loadAvatarProfile() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AVATAR_KEY], (result) => {
      resolve(result[AVATAR_KEY] ? { ...DEFAULT_AVATAR, ...result[AVATAR_KEY] } : { ...DEFAULT_AVATAR });
    });
  });
}

function saveAvatarProfile() {
  chrome.storage.local.set({ [AVATAR_KEY]: avatarProfile });
}

function commitName(raw) {
  avatarProfile = { name: cleanName(raw), chosen: true };
  saveAvatarProfile();
  render();
}

const IDLE_AVATAR_SRC = chrome.runtime.getURL('idle_evol_1.png');
const FOCUS_AVATAR_SRC = chrome.runtime.getURL('active_evol_1.png');


const DEFAULT_SETTINGS = {
  avatarHidden: false,
  extensionDisabled: false,
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
    idle: "idle_evol_3.png",
    focus: "active_evol_3.png",
  },
];

const FOCUS_DURATION_MS = 25 * 60 * 1000; // 25 minutes
const FOCUS_BONUS_XP = 5;

const DEFAULT_STATE = {
  currentTask: null,       // string or null (the pasted assignment text)
  taskTitle: null,         // short AI-generated name for the task (falls back to currentTask)
  assignmentType: null,    // type returned by the breakdown ('essay', 'problem_set', ...); sent to avatar chat as context
  subtasks: [],            // [{ kind, text, detail, done, ...kind-specific }]; kind is 'do' | 'copy' | 'citation' | 'question' (missing = 'do'); worksheet questions carry gid/group/ask
  clarify: null,           // { round, questions, answers } while the server is asking for missing details, else null
  analysesUsed: 0,         // LEGACY: the beta cap now lives in `usage` (own storage key); this value is only read once to migrate old installs
  planStartedAt: null,     // ms timestamp when the current plan was created (for completion-time analytics)
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

let mounted = false; // true while the avatar + task widget are injected on this page

function isExcludedSite(settings) {
  const hostname = window.location.hostname.toLowerCase();
  return settings.excludedSites.some(
    (site) => hostname === site || hostname.endsWith('.' + site)
  );
}

async function init() {
  const settings = await loadSettings();
  if (settings.extensionDisabled || isExcludedSite(settings)) return; // inject nothing
  await mountStudBud(settings);
}

async function mountStudBud(settings) {
  if (mounted) return;
  mounted = true; // set first so a second call during the awaits below can't double-mount

  state = await loadState();
  avatarProfile = await loadAvatarProfile();
  const storedUsage = await loadUsage();
  usage = storedUsage || { ...DEFAULT_USAGE, analysesUsed: state.analysesUsed || 0 }; // migrate existing installs once
  if (!storedUsage) saveUsage();
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

function unmountStudBud() {
  if (!mounted) return;
  mounted = false;
  stopFocusTicking();
  clearBubbleFadeTimer();
  bubbleSeq++;  // drop in-flight avatar/stuck replies
  expandSeq++;  // drop in-flight expand replies
  const avatar = document.getElementById('studbud-avatar');
  if (avatar) avatar.remove();
  const widget = document.getElementById('studbud-task-widget');
  if (widget) widget.remove();
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
    const newSettings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
    if (newSettings.extensionDisabled) {
      unmountStudBud();
    } else if (!mounted && !isExcludedSite(newSettings)) {
      mountStudBud(newSettings); // re-enabled: mount live, no reload needed
    }
    const avatar = document.getElementById('studbud-avatar');
    if (avatar) avatar.classList.toggle('studbud-hidden', !!newSettings.avatarHidden);
  }

  if (!mounted) return; // nothing injected here (disabled or excluded site): ignore state/usage/profile changes

  if (changes[AVATAR_KEY] && changes[AVATAR_KEY].newValue) {
    avatarProfile = { ...DEFAULT_AVATAR, ...changes[AVATAR_KEY].newValue };
    if (document.getElementById('studbud-avatar')) render();
  }

  if (changes[USAGE_KEY] && changes[USAGE_KEY].newValue) {
    usage = { ...DEFAULT_USAGE, ...changes[USAGE_KEY].newValue };
    if (document.getElementById('studbud-task-widget')) render();
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

// ---------- Beta usage counters ----------
// Kept OUTSIDE the saved plan state so resetting progress (popup) cannot reset the beta cap.
// Reinstalling the extension still resets it: only a server-side count could stop that.

const USAGE_KEY = 'studbudUsage';
const DEFAULT_USAGE = {
  analysesUsed: 0,       // successful assignment analyses, compared against ANALYSIS_LIMIT
  completedPlans: 0,     // plans taken through the last step (shown on the upgrade wall)
  limitHit: false,       // true once the wall has been shown (limit_hit event is sent once)
  useChoice: null,       // 'yes' | 'no': "would you use StudBud on your next assignment" asked on the limit wall
  payChoice: null,       // 'yes' | 'maybe' | 'no': "would you pay", asked only after useChoice === 'yes'
  priceChoice: null,     // 'lt3' | '3' | '5' | '8' once the student named a monthly price (older installs may hold 'none')
  reuseAnswer: null,     // 'yes' | 'no' if the completion feedback card was answered; the wall then skips its own use question
  waitlistJoined: false, // true once the student submitted an email for the unlimited-access waitlist (the email itself is never kept here)
  feedbackDone: false,         // true once feedback was submitted: never ask again
  feedbackAsks: 0,             // times the feedback card has been shown (max FEEDBACK_MAX_ASKS)
  feedbackLastKey: null,       // context of the latest ask ('plan:<planStartedAt>' | 'limit'); a re-render of the same context is not a new ask
  feedbackDismissedKey: null,  // context the student dismissed with "Not now"
  avatarMessages: 0,           // successful avatar chat replies (sent with feedback as context)
};
let usage = { ...DEFAULT_USAGE };

function loadUsage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([USAGE_KEY], (result) => {
      resolve(result[USAGE_KEY] ? { ...DEFAULT_USAGE, ...result[USAGE_KEY] } : null);
    });
  });
}

function saveUsage() {
  chrome.storage.local.set({ [USAGE_KEY]: usage });
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
      // crypto.randomUUID is undefined on non-secure (http) pages, so fall back to random hex.
      const id = crypto.randomUUID
        ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      chrome.storage.local.set({ [ANON_ID_KEY]: id }, () => resolve(id));
    });
  });
}

// Every breakdown request carries the anonymous install id so the server can apply a per-user daily cap.
function sendBreakdown(payload, callback) {
  getAnonId().then((userId) => {
    chrome.runtime.sendMessage({ type: 'BREAKDOWN_TASK', payload: { ...payload, userId } }, callback);
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
    <div id="studbud-avatar-meta">
      <span id="studbud-avatar-name"></span>
      <div id="studbud-avatar-xp"></div>
    </div>
    <div id="studbud-bubble" class="studbud-hidden" title="">
      <button id="studbud-bubble-close" type="button" aria-label="Close">✕</button>
      <div class="studbud-bubble-echo studbud-hidden"></div>
      <div class="studbud-bubble-reply studbud-hidden" role="status" aria-live="polite"></div>
      <div class="studbud-stuck-area studbud-hidden" role="status" aria-live="polite"></div>
      <button type="button" class="studbud-stuck-btn studbud-stuck-btn-secondary studbud-stuck-entry studbud-hidden">I'm stuck on this step</button>
      <div class="studbud-bubble-inputrow">
        <input id="studbud-bubble-input" class="studbud-field-input" type="text" maxlength="${AVATAR_CHAT_MAX_LEN}" placeholder="Ask about this step…" aria-label="Ask your study buddy" autocomplete="off" />
        <div class="studbud-bubble-count studbud-hidden"></div>
      </div>
    </div>
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

  wireBubble();
}

// ---------- Avatar chat bubble ----------
// One exchange at a time, anchored above the avatar. Clicking the avatar face opens it.
// UI-only state (module variables, not saved state), like the intake drafts. The server
// (api/avatar.js) classifies each message; the client only uses `category` to decide
// whether the reply fades ('banter') or stays pinned (everything else).
// Replies are rendered with textContent only: they come from a model.

const AVATAR_ID = 'owl';                 // persona key on the server (PERSONAS in api/avatar.js)
const AVATAR_CHAT_MAX_LEN = 500;         // keep in sync with MAX_MESSAGE in api/avatar.js
const AVATAR_CHAT_TIMEOUT_MS = 15000;
const AVATAR_HISTORY_MAX = 6;            // keep in sync with MAX_HISTORY in api/avatar.js
const BANTER_FADE_MIN_MS = 6000;         // banter fades after max(6s, words x 0.35s). Tune from beta behavior.
const BANTER_FADE_MS_PER_WORD = 350;
const FADE_RESUME_MS = 3000;             // delay after hover/focus ends before a pending fade restarts
const FADE_ANIM_MS = 400;                // keep in sync with the opacity transition in content.css
const BUBBLE_TAIL_OFFSET_PX = 32;        // bubble tail sits this far right of the avatar's centre, in front of the mouth. Tune to the art.

const BUBBLE_TEXT = {
  network: 'Signal lost. Try that again in a second.',
  timeout: 'That took too long. Try again.',
  limit: 'Out of messages for today. Back tomorrow.',
};

const bubble = {
  open: false,
  sending: false,
  limited: false,   // true once the server says the daily cap is reached
  history: [],      // [{ role: 'user'|'avatar', text }], cleared whenever the step changes
  last: null,       // { message, category, reply } of the one exchange on display
  stuck: null,      // "I'm stuck" flow: { phase, kind, level, result, history, error, retryable, reported }, cleared whenever the step changes
};
let bubbleSeq = 0;           // invalidates stale responses (step change, timeout)
let bubbleFadeTimer = null;
let bubbleFadePending = false;
let lastStepKey = null;

function wireBubble() {
  const face = document.getElementById('studbud-avatar-face');
  const box = document.getElementById('studbud-bubble');
  const input = document.getElementById('studbud-bubble-input');

  face.addEventListener('click', toggleBubble);
  document.getElementById('studbud-bubble-close').addEventListener('click', closeBubble);
  box.querySelector('.studbud-stuck-entry').addEventListener('click', startStuck);

  // Keep keystrokes from reaching host-page shortcuts (Docs, Canvas, etc.)
  ['keydown', 'keypress', 'keyup'].forEach((evt) => input.addEventListener(evt, (e) => e.stopPropagation()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      sendAvatarMessage();
    } else if (e.key === 'Escape') {
      closeBubble();
    }
  });
  input.addEventListener('input', updateBubbleCount);

  // A pending banter fade pauses while the student hovers the bubble, has the input focused, or is typing.
  box.addEventListener('mouseenter', pauseBubbleFade);
  box.addEventListener('mouseleave', resumeBubbleFade);
  input.addEventListener('focus', pauseBubbleFade);
  input.addEventListener('blur', resumeBubbleFade);
}

function toggleBubble() {
  if (state.avatarMinimized) return;
  if (bubble.open) closeBubble();
  else openBubble();
}

function openBubble() {
  if (state.avatarMinimized) return;
  bubble.open = true;
  bubbleFadePending = false; // a restored reply never auto-fades again
  clearBubbleFadeTimer();
  renderBubble();
  const input = document.getElementById('studbud-bubble-input');
  if (input && !input.disabled) input.focus();
}

function closeBubble() {
  clearBubbleFadeTimer();
  bubbleFadePending = false;
  bubble.open = false;
  renderBubble();
}

// Called from render() when the current step changes (or the plan is reset / synced from another tab).
function resetBubbleForNewStep() {
  bubbleSeq += 1; // drop any in-flight reply
  bubble.sending = false;
  bubble.history = [];
  bubble.stuck = null;
  // A distress message stays on screen until the student closes it.
  if (bubble.open && bubble.last && bubble.last.category === 'distress') {
    renderBubble();
    return;
  }
  bubble.last = null;
  clearBubbleFadeTimer();
  bubbleFadePending = false;
  bubble.open = false;
  renderBubble();
}

function renderBubble() {
  const box = document.getElementById('studbud-bubble');
  const avatar = document.getElementById('studbud-avatar');
  if (!box || !avatar) return;

  box.classList.remove('studbud-bubble-fading');
  box.classList.toggle('studbud-hidden', !bubble.open);
  avatar.classList.toggle('studbud-thinking', bubble.sending);
  if (!bubble.open) return;

  const echo = box.querySelector('.studbud-bubble-echo');
  const reply = box.querySelector('.studbud-bubble-reply');
  const input = document.getElementById('studbud-bubble-input');
  const last = bubble.last;

  const stuck = bubble.stuck;
  echo.classList.toggle('studbud-hidden', !last || !!stuck);
  reply.classList.toggle('studbud-hidden', !last || !!stuck);
  box.classList.toggle('studbud-bubble-serious', !stuck && !!last && last.category === 'distress');
  renderStuck(box);

  if (last) {
    echo.textContent = `You: ${last.message}`;
    if (bubble.sending) reply.textContent = 'Thinking…';
    else setBubbleReply(reply, last.reply, last.category === 'distress');
  }

  input.disabled = bubble.sending || bubble.limited;
  input.placeholder = bubble.limited ? 'Back tomorrow' : 'Ask about this step…';
  updateBubbleCount();

  // Point the tail at the avatar's mouth: avatar centre (its width follows the name length) plus a fixed offset.
  // The bubble's left edge lines up with the avatar's outer left edge; the tail is 12px wide, so subtract 6 to centre it.
  const tailX = avatar.offsetWidth / 2 + BUBBLE_TAIL_OFFSET_PX - 6;
  box.style.setProperty('--tail-x', `${Math.max(16, Math.min(tailX, box.offsetWidth - 28))}px`);
}

// textContent only. The one exception is the fixed distress message, where the
// findahelpline.com mention becomes a link built with DOM nodes (never innerHTML).
function setBubbleReply(el, text, withLink) {
  el.textContent = '';
  const marker = 'findahelpline.com';
  const at = withLink ? text.indexOf(marker) : -1;
  if (at === -1) {
    el.textContent = text;
    return;
  }
  const a = document.createElement('a');
  a.href = 'https://findahelpline.com';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = marker;
  el.append(text.slice(0, at), a, text.slice(at + marker.length));
}

function updateBubbleCount() {
  const input = document.getElementById('studbud-bubble-input');
  const count = document.querySelector('#studbud-bubble .studbud-bubble-count');
  if (!input || !count) return;
  const left = AVATAR_CHAT_MAX_LEN - input.value.length;
  count.textContent = `${left} characters left`;
  count.classList.toggle('studbud-hidden', left > 100);
}

function sendAvatarMessage() {
  const input = document.getElementById('studbud-bubble-input');
  const message = input.value.trim();
  if (!message || bubble.sending || bubble.limited) return;

  bubble.stuck = null; // a typed message leaves the "I'm stuck" flow
  const seq = ++bubbleSeq;
  bubble.sending = true;
  bubble.last = { message, category: null, reply: '' };
  clearBubbleFadeTimer();
  bubbleFadePending = false;
  input.value = '';
  renderBubble();

  const finish = (outcome) => {
    if (seq !== bubbleSeq) return; // step changed or timed out meanwhile
    bubbleSeq += 1;                // any later response for this request is now stale
    clearTimeout(timeout);
    bubble.sending = false;

    if (outcome.error) {
      // Failures are not added to history; the text goes back in the box so the student can retry.
      bubble.last = { message, category: 'other', reply: outcome.error };
      if (outcome.limited) bubble.limited = true;
      else input.value = message;
      renderBubble();
      return;
    }

    bubble.last = { message, category: outcome.category, reply: outcome.reply };
    bubble.history.push({ role: 'user', text: message }, { role: 'avatar', text: outcome.reply });
    bubble.history = bubble.history.slice(-AVATAR_HISTORY_MAX);
    usage.avatarMessages = (usage.avatarMessages || 0) + 1;
    saveUsage();
    renderBubble();
    // Only banter fades. Everything else stays pinned until dismissed.
    if (outcome.category === 'banter') scheduleBubbleFade(outcome.reply);
    if (!input.disabled) input.focus(); // focus pauses the fade; it resumes when the student clicks back into their work
  };

  const timeout = setTimeout(() => finish({ error: BUBBLE_TEXT.timeout }), AVATAR_CHAT_TIMEOUT_MS);

  const cur = state.subtasks[state.currentSubtaskIndex];
  getAnonId().then((userId) => {
    if (seq !== bubbleSeq) return;
    const payload = {
      userId,
      message,
      history: bubble.history.slice(-AVATAR_HISTORY_MAX),
      context: {
        avatarId: AVATAR_ID,
        avatarName: avatarProfile.name,
        assignmentType: state.assignmentType || '',
        title: state.taskTitle || '',
        stepTitle: cur ? cur.text : '',
        stepDetail: cur ? (cur.detail || cur.ask || '') : '',
        stepIndex: cur ? state.currentSubtaskIndex + 1 : 0,
        stepTotal: state.subtasks.length,
      },
    };
    try {
      chrome.runtime.sendMessage({ type: 'AVATAR_CHAT', payload }, (response) => {
        if (chrome.runtime.lastError || !response) {
          finish({ error: BUBBLE_TEXT.network });
        } else if (response.limit) {
          finish({ error: BUBBLE_TEXT.limit, limited: true });
        } else if (!response.ok || typeof response.reply !== 'string' || !response.reply) {
          finish({ error: BUBBLE_TEXT.network });
        } else {
          finish({ category: String(response.category || 'other'), reply: response.reply });
        }
      });
    } catch (e) {
      finish({ error: BUBBLE_TEXT.network }); // e.g. extension was reloaded while this tab stayed open
    }
  });
}

// ---- "I'm stuck" scaffolded help ----
// Three levels via api/stuck.js: 1 = plain-words recap + guiding question, 2 = worked example with different
// values, 3 = smaller sub-steps + a drafted question for the instructor. The student only taps buttons (no free
// text), so nothing unmoderated reaches the model. State lives in bubble.stuck and resets with the step.
// Model output is rendered with textContent only. Shares bubbleSeq with avatar chat so stale replies are dropped.

const STUCK_MAX_LEVEL = 3;
const STUCK_TIMEOUT_MS = 25000;   // worked examples may use a slower model (STUCK_L2_MODEL)
const STUCK_HISTORY_MAX = 2;      // keep in sync with MAX_HISTORY in api/stuck.js
const STUCK_KINDS = [
  { id: 'understand', label: "Don't understand the step" },
  { id: 'start', label: "Don't know where to start" },
  { id: 'apply', label: "Can't apply it" },
];
const STUCK_TEXT = {
  network: 'Signal lost. Try again in a second.',
  timeout: 'That took too long. Try again.',
  limit: 'Out of help for today. Back tomorrow.',
};

// Citation and copy steps are deterministic and have nothing to explain. Not offered while a distress message is on screen.
function stuckEligible() {
  const cur = state.subtasks[state.currentSubtaskIndex];
  if (!cur || cur.kind === 'citation' || cur.kind === 'copy') return false;
  return !(bubble.last && bubble.last.category === 'distress');
}

function startStuck() {
  if (!stuckEligible() || bubble.sending) return;
  clearBubbleFadeTimer();
  bubbleFadePending = false;
  bubble.last = null;
  bubble.stuck = { phase: 'choose', kind: null, level: 1, result: null, history: [], error: '', retryable: false, reported: false };
  renderBubble();
}

function endStuck(closeAfter) {
  bubble.stuck = null;
  if (closeAfter) closeBubble();
  else renderBubble();
}

function stuckSummary(d) {
  if (typeof d.explain === 'string') return `${d.explain} ${d.question || ''}`.trim();
  if (typeof d.example === 'string') return d.example;
  return Array.isArray(d.substeps) ? d.substeps.join(' ') : '';
}

function validStuckResponse(level, r) {
  if (level === 1) return typeof r.explain === 'string' && r.explain.length > 0;
  if (level === 2) return typeof r.example === 'string' && r.example.length > 0;
  return Array.isArray(r.substeps) && r.substeps.length >= 2;
}

function requestStuck(level, kind) {
  const s = bubble.stuck;
  const cur = state.subtasks[state.currentSubtaskIndex];
  if (!s || !cur || bubble.sending) return;

  const seq = ++bubbleSeq;
  bubble.sending = true;
  s.phase = 'loading';
  s.level = level;
  s.kind = kind;
  s.error = '';
  renderBubble();

  const finish = (outcome) => {
    if (seq !== bubbleSeq) return; // step changed, student typed a message, or timed out meanwhile
    bubbleSeq += 1;
    clearTimeout(timeout);
    bubble.sending = false;

    if (outcome.error) {
      s.phase = 'error';
      s.error = outcome.error;
      s.retryable = !outcome.limited;
    } else {
      s.phase = 'result';
      s.result = outcome.data;
      s.reported = false;
      s.history.push({ level, text: stuckSummary(outcome.data) });
      s.history = s.history.slice(-STUCK_HISTORY_MAX);
    }
    renderBubble();
  };

  const timeout = setTimeout(() => finish({ error: STUCK_TEXT.timeout }), STUCK_TIMEOUT_MS);

  getAnonId().then((userId) => {
    if (seq !== bubbleSeq) return;
    const payload = {
      userId,
      brief: state.currentTask || '',
      type: state.assignmentType || 'other',
      level,
      stuckKind: kind,
      step: { title: cur.text, detail: cur.detail || '', ask: cur.ask || '', group: cur.group || '' },
      history: s.history.slice(-STUCK_HISTORY_MAX),
    };
    try {
      chrome.runtime.sendMessage({ type: 'STUCK_HELP', payload }, (response) => {
        if (chrome.runtime.lastError || !response) {
          finish({ error: STUCK_TEXT.network });
        } else if (response.limit) {
          finish({ error: STUCK_TEXT.limit, limited: true });
        } else if (!response.ok || !validStuckResponse(level, response)) {
          finish({ error: STUCK_TEXT.network });
        } else {
          finish({ data: response });
        }
      });
    } catch (e) {
      finish({ error: STUCK_TEXT.network }); // e.g. extension was reloaded while this tab stayed open
    }
  });
}

// "This example looks wrong": anonymous counter only (level + assignment type), nothing about the content.
function reportStuck(s) {
  if (s.reported) return;
  s.reported = true;
  renderBubble();
  getAnonId().then((userId) => {
    try {
      chrome.runtime.sendMessage(
        { type: 'STUCK_HELP', payload: { userId, report: true, level: s.level, type: state.assignmentType || 'other' } },
        () => { void chrome.runtime.lastError; }
      );
    } catch (e) {
      /* ignore */
    }
  });
}

function stuckEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function stuckButton(cls, label, onClick) {
  const b = stuckEl('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function renderStuck(box) {
  const area = box.querySelector('.studbud-stuck-area');
  const entry = box.querySelector('.studbud-stuck-entry');
  const s = bubble.stuck;
  entry.classList.toggle('studbud-hidden', !!s || !stuckEligible());
  area.classList.toggle('studbud-hidden', !s);
  area.textContent = '';
  if (!s) return;

  if (s.phase === 'choose') {
    area.append(stuckEl('div', 'studbud-stuck-label', 'What are you stuck on?'));
    const row = stuckEl('div', 'studbud-type-row studbud-stuck-chips');
    STUCK_KINDS.forEach((k) => row.append(stuckButton('studbud-type-btn', k.label, () => requestStuck(1, k.id))));
    area.append(row, stuckButton('studbud-link-btn', 'Cancel', () => endStuck(false)));
    return;
  }

  if (s.phase === 'loading') {
    area.append(stuckEl('div', 'studbud-stuck-progress', `Help ${s.level} of ${STUCK_MAX_LEVEL}`));
    area.append(stuckEl('div', 'studbud-stuck-label', 'Thinking…'));
    return;
  }

  if (s.phase === 'error') {
    area.append(stuckEl('div', 'studbud-error', s.error));
    if (s.retryable) area.append(stuckButton('studbud-stuck-btn studbud-stuck-btn-primary', 'Try again', () => requestStuck(s.level, s.kind)));
    area.append(stuckButton('studbud-link-btn', 'Cancel', () => endStuck(false)));
    return;
  }

  // phase === 'result'
  const d = s.result;
  area.append(stuckEl('div', 'studbud-stuck-progress', `Help ${s.level} of ${STUCK_MAX_LEVEL}`));
  const body = stuckEl('div', 'studbud-bubble-reply studbud-bubble-long');

  if (s.level === 1) {
    body.append(stuckEl('div', 'studbud-stuck-label', 'The step, in plain words'));
    body.append(stuckEl('div', '', d.explain));
    if (d.question) body.append(stuckEl('div', 'studbud-stuck-question', d.question));
  } else if (s.level === 2) {
    body.append(stuckEl('div', 'studbud-stuck-label', 'A different example'));
    body.append(stuckEl('div', 'studbud-stuck-example', d.example));
    body.append(stuckEl('div', 'studbud-note', 'Now go back to your own step and try the same method.'));
  } else {
    body.append(stuckEl('div', 'studbud-stuck-label', 'Smaller steps'));
    const ol = stuckEl('ol', 'studbud-stuck-substeps');
    d.substeps.forEach((t) => ol.append(stuckEl('li', '', t)));
    body.append(ol);
    if (d.draft) {
      body.append(stuckEl('div', 'studbud-stuck-label', 'Still stuck? Ask your instructor'));
      body.append(stuckEl('div', 'studbud-copy-box studbud-stuck-draft', d.draft));
      const copyBtn = stuckButton('studbud-secondary-btn', 'Copy question', () => {
        flashCopyResult(copyBtn, copyRich(escapeHtml(d.draft), d.draft), 'Copy question');
      });
      body.append(copyBtn);
    }
  }
  if (d.quip) body.append(stuckEl('div', 'studbud-stuck-quip', d.quip));
  area.append(body);

  if (s.level === 2) {
    const report = stuckButton('studbud-stuck-report', s.reported ? 'Thanks, noted.' : 'This example looks wrong', () => reportStuck(s));
    report.disabled = s.reported;
    area.append(report);
  }

  const actions = stuckEl('div', 'studbud-stuck-actions');
  actions.append(stuckButton('studbud-stuck-btn studbud-stuck-btn-primary', 'Got it', () => endStuck(true)));
  if (s.level < STUCK_MAX_LEVEL) {
    actions.append(stuckButton('studbud-stuck-btn studbud-stuck-btn-secondary', 'Still stuck', () => requestStuck(s.level + 1, s.kind)));
  }
  area.append(actions);
}

// ---- Banter fade ----

function scheduleBubbleFade(text) {
  const words = text.trim().split(/\s+/).length;
  bubbleFadePending = true;
  startBubbleFadeTimer(Math.max(BANTER_FADE_MIN_MS, words * BANTER_FADE_MS_PER_WORD));
}

function startBubbleFadeTimer(ms) {
  clearBubbleFadeTimer();
  bubbleFadeTimer = setTimeout(fadeOutBubble, ms);
}

function clearBubbleFadeTimer() {
  if (bubbleFadeTimer) {
    clearTimeout(bubbleFadeTimer);
    bubbleFadeTimer = null;
  }
}

function pauseBubbleFade() {
  clearBubbleFadeTimer();
  const box = document.getElementById('studbud-bubble');
  if (box) box.classList.remove('studbud-bubble-fading'); // cancels a fade already underway
}

function resumeBubbleFade() {
  if (!bubbleFadePending) return;
  const input = document.getElementById('studbud-bubble-input');
  if (input && input.value.trim()) return; // student is mid-message
  startBubbleFadeTimer(FADE_RESUME_MS);
}

function fadeOutBubble() {
  bubbleFadeTimer = null;
  const box = document.getElementById('studbud-bubble');
  if (!box || !bubble.open) return;
  box.classList.add('studbud-bubble-fading');
  bubbleFadeTimer = setTimeout(closeBubble, FADE_ANIM_MS); // last reply is kept: clicking the avatar restores it
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
      <div id="studbud-name-card" class="studbud-hidden">
        <div class="studbud-intake-title">Name your study buddy</div>
        <div class="studbud-intake-sub">You can change it later in the StudBud popup.</div>
        <input id="studbud-name-input" class="studbud-field-input" type="text" maxlength="${MAX_NAME_LEN}" value="${DEFAULT_NAME}" />
        <div id="studbud-name-count" class="studbud-note"></div>
        <button id="studbud-name-save" class="studbud-primary-btn" type="button">Save name</button>
        <button id="studbud-name-keep" class="studbud-link-btn" type="button">Keep ${DEFAULT_NAME}</button>
      </div>
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

  const nameInput = document.getElementById('studbud-name-input');
  const nameCount = document.getElementById('studbud-name-count');
  const updateNameCount = () => {
    nameCount.textContent = `${MAX_NAME_LEN - nameInput.value.length} characters left`;
  };
  nameInput.addEventListener('input', updateNameCount);
  updateNameCount();
  // Keep keystrokes from reaching host-page shortcuts (Docs, Canvas, etc.)
  ['keydown', 'keypress', 'keyup'].forEach((evt) => nameInput.addEventListener(evt, (e) => e.stopPropagation()));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitName(nameInput.value);
  });
  document.getElementById('studbud-name-save').addEventListener('click', () => commitName(nameInput.value));
  document.getElementById('studbud-name-keep').addEventListener('click', () => commitName(DEFAULT_NAME));

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
// Events: plan_created | step_completed | plan_completed | limit_hit | use_yes | use_no | pay_no |
//         pay_{yes|maybe}_{lt3|3|5|8} | waitlist_join   (must match EVENTS in api/events.js)
 
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

// ---------- Feedback card ----------
// One-time anonymous survey: "would you use this again?" (yes/no) + optional free text. Shown inline (never an
// overlay): under the finish question when a plan is completed, or on the beta-limit wall as a fallback.
// A card counts as one "ask" the first time it is shown for a context; it is asked at most FEEDBACK_MAX_ASKS
// times in total and never again after a submit. Counters live in `usage`, so "Reset progress" can't re-trigger it.

const FEEDBACK_MAX_ASKS = 2;
const FEEDBACK_MAX_LEN = 500; // keep in sync with MAX_TEXT in api/feedback.js

// UI-only drafts (module variables) so typing survives re-renders.
let fbAnswer = null; // 'yes' | 'no' | null
let fbText = '';
let fbError = '';
let fbSending = false;
let waitlistDraft = ''; // email typed but not yet submitted; survives re-renders
let fbThanks = false;

function feedbackKey(trigger) {
  return trigger === 'limit_hit' ? 'limit' : `plan:${state.planStartedAt || 0}`;
}

// Decides whether the card shows for this context, and registers the ask the first time it does.
function shouldShowFeedback(key) {
  if (usage.feedbackDone) return false;
  if (usage.feedbackDismissedKey === key) return false;
  if (usage.feedbackLastKey === key) return true; // already counted; stays visible until sent or dismissed
  if ((usage.feedbackAsks || 0) >= FEEDBACK_MAX_ASKS) return false;
  usage.feedbackAsks = (usage.feedbackAsks || 0) + 1;
  usage.feedbackLastKey = key;
  saveUsage();
  return true;
}

// Fills #studbud-feedback-slot (present in the completed-plan view and the limit wall).
// trigger: 'completion' | 'limit_hit'
function mountFeedback(trigger) {
  const slot = document.getElementById('studbud-feedback-slot');
  if (!slot) return;

  if (fbThanks) {
    slot.innerHTML = '<div class="studbud-upsell-thanks">✓ Thanks, that helps.</div>';
    return;
  }
  const key = feedbackKey(trigger);
  if (!shouldShowFeedback(key)) {
    slot.innerHTML = '';
    return;
  }

  // On the limit wall the use / pay questions were already asked, so the card is text-only there.
  const textOnly = trigger === 'limit_hit';
  slot.innerHTML = `
    <div class="studbud-feedback">
      <div class="studbud-field-label">Quick feedback</div>
      ${textOnly ? '' : `<div class="studbud-note">Would you use StudBud on your next assignment?</div>
      <div class="studbud-fb-row">
        <button type="button" class="studbud-type-btn" data-fb="yes">Yes</button>
        <button type="button" class="studbud-type-btn" data-fb="no">No</button>
      </div>`}
      <textarea id="studbud-fb-text" class="studbud-field-input" rows="3" maxlength="${FEEDBACK_MAX_LEN}" placeholder="${textOnly ? 'What would make StudBud better? (optional)' : 'What should we fix or keep? (optional)'}"></textarea>
      <div class="studbud-note">Responses are completely anonymous. Thank you for your time!</div>
      ${fbError ? `<div class="studbud-error">${escapeHtml(fbError)}</div>` : ''}
      <button id="studbud-fb-send" type="button" class="studbud-primary-btn" disabled>Send feedback</button>
      <button id="studbud-fb-skip" type="button" class="studbud-link-btn">Not now</button>
    </div>`;

  const textEl = document.getElementById('studbud-fb-text');
  const send = document.getElementById('studbud-fb-send');
  textEl.value = fbText;

  const sync = () => {
    slot.querySelectorAll('[data-fb]').forEach((b) => b.classList.toggle('studbud-fb-selected', b.dataset.fb === fbAnswer));
    send.disabled = fbSending || (!fbAnswer && !fbText.trim());
    send.textContent = fbSending ? 'Sending…' : 'Send feedback';
  };

  slot.querySelectorAll('[data-fb]').forEach((b) => {
    b.addEventListener('click', () => {
      fbAnswer = fbAnswer === b.dataset.fb ? null : b.dataset.fb;
      sync();
    });
  });
  textEl.addEventListener('input', () => {
    fbText = textEl.value;
    sync();
  });
  // Keep keystrokes from reaching host-page shortcuts (Docs, Canvas, etc.)
  ['keydown', 'keypress', 'keyup'].forEach((evt) => textEl.addEventListener(evt, (e) => e.stopPropagation()));
  send.addEventListener('click', () => submitFeedback(trigger, sync));
  document.getElementById('studbud-fb-skip').addEventListener('click', () => dismissFeedback(key));
  sync();
}

async function submitFeedback(trigger, sync) {
  const text = fbText.trim();
  if (fbSending || (!fbAnswer && !text)) return;
  fbSending = true;
  fbError = '';
  sync();

  let anonId = null;
  try {
    anonId = await getAnonId();
  } catch (e) {
    /* server rejects a missing id; the student sees the retry message */
  }
  const payload = {
    anonId,
    trigger,
    reuse: fbAnswer,
    text,
    assignmentType: state.assignmentType || null,
    stepsTotal: state.subtasks.length,
    stepsCompleted: state.subtasks.filter((s) => s.done).length,
    plansCompleted: usage.completedPlans || 0,
    analysesUsed: usage.analysesUsed || 0,
    avatarMessages: usage.avatarMessages || 0,
    asks: usage.feedbackAsks || 0,
  };

  const fail = () => {
    fbSending = false;
    fbError = "Couldn't send. Try again.";
    mountFeedback(trigger); // drafts are kept
  };
  try {
    chrome.runtime.sendMessage({ type: 'SUBMIT_FEEDBACK', payload }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok) {
        fail();
        return;
      }
      fbSending = false;
      usage.feedbackDone = true;
      if (fbAnswer) usage.reuseAnswer = fbAnswer; // the limit wall will not ask the same question again
      saveUsage();
      fbThanks = true;
      fbAnswer = null;
      fbText = '';
      mountFeedback(trigger);
    });
  } catch (e) {
    fail(); // e.g. extension was reloaded while this tab stayed open
  }
}

function dismissFeedback(key) {
  usage.feedbackDismissedKey = key;
  saveUsage();
  fbAnswer = null;
  fbText = '';
  fbError = '';
  const slot = document.getElementById('studbud-feedback-slot');
  if (slot) slot.innerHTML = '';
}

// ---------- Assignment intake (required) ----------
// A breakdown is only built from a pasted assignment. If the text lacks key
// details the server first asks up to 2 rounds of clarifying questions.

const ANALYSIS_LIMIT = 3;       // beta cap on successful analyses per install. CLIENT-SIDE ONLY: reinstalling resets it (see `usage`).
const MIN_BRIEF_CHARS = 40;    // coarse client-side floor; the model does the real sufficiency check
const MAX_BRIEF_CHARS = 8000;  // keep in sync with MAX_BRIEF in api/breakdown.js

// UI-only drafts. Module variables (not saved state) so typing survives the
// re-renders that any saveState() triggers, without writing on every keystroke.
let intakeDraft = '';
let clarifyDrafts = [];
let fieldDraft = { key: '', value: '' };
let requestInFlight = false;
let intakeError = '';
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

  sendBreakdown({ brief, answers, round }, (response) => {
    requestInFlight = false;

    if (chrome.runtime.lastError || !response || !response.ok) {
      console.error('Breakdown failed:', (response && response.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message));
      // Daily-cap messages from the server (per-user, per-network or global) say retrying now will not help, so show them as written.
      const serverMsg = response && typeof response.error === 'string' ? response.error : '';
      intakeError = /tomorrow/i.test(serverMsg) ? serverMsg : 'Could not analyze that. Your text is kept — try again.';
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
      state.assignmentType = (typeof response.type === 'string' && response.type) || null;
      let gid = 0; // worksheet outlines: each 'question' step gets a group id that its micro-steps inherit
      state.subtasks = response.steps.map((st) => toStep(st, st.kind === 'question' ? gid++ : null));
      state.currentSubtaskIndex = 0;
      if (state.subtasks[0] && state.subtasks[0].kind === 'question') startExpand(0);
      state.clarify = null;
      usage.analysesUsed = (usage.analysesUsed || 0) + 1;
      saveUsage();
      state.planStartedAt = Date.now();
      trackEvent('plan_created');
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

function toStep(s, gid) {
  const base = { kind: s.kind, text: s.title, detail: s.detail || '', done: false };
  if (s.kind === 'question') return { ...base, ask: s.ask, gid };
  if (s.kind === 'copy') return { ...base, copyText: s.text };
  if (s.kind === 'citation') return { ...base, style: s.style, n: s.n, cite: { type: null, values: {}, fieldIndex: 0 } };
  return base;
}

// ---------- Worksheet questions: expanded into micro-steps on demand ----------
// The plan for a question-based worksheet is an outline (one 'question' step per
// question). Each is expanded only where the student clicked (never from render()),
// so other open tabs cannot trigger duplicate requests.

let expandingIndex = null;   // index of the question step currently being expanded in THIS tab
let expandError = false;
let expandSeq = 0;           // invalidates stale responses after a reset

function startExpand(index) {
  const step = state.subtasks[index];
  if (!step || step.kind !== 'question' || expandingIndex !== null) return;
  const seq = ++expandSeq;
  const brief = state.currentTask;
  expandingIndex = index;
  expandError = false;

  sendBreakdown(
    { mode: 'expand', brief, label: step.text, ask: step.ask },
    (response) => {
      if (seq !== expandSeq) return; // plan was reset while this was in flight
      expandingIndex = null;

      // Another tab may already have expanded this question; if the plan changed, just redraw.
      const cur = state.subtasks[index];
      if (!cur || cur.kind !== 'question' || cur.gid !== step.gid || cur.text !== step.text || state.currentTask !== brief) {
        render();
        return;
      }
      const failed = chrome.runtime.lastError || !response || !response.ok ||
        response.status !== 'ready' || !Array.isArray(response.steps) || response.steps.length === 0;
      if (failed) {
        expandError = true;
        render();
        return;
      }
      const subs = response.steps.map((x) => ({
        kind: 'do', text: x.title, detail: x.detail || '', done: false,
        gid: step.gid, group: step.text, ask: step.ask,
      }));
      state.subtasks.splice(index, 1, ...subs);
      saveState();
      render();
    }
  );
}

function resetPlan() {
  expandSeq += 1; // drop any in-flight question expansion
  expandingIndex = null;
  expandError = false;
  state.subtasks = [];
  state.currentSubtaskIndex = 0;
  state.taskTitle = null;
  state.assignmentType = null;
  state.currentTask = null;
  state.clarify = null;
  state.planStartedAt = null;
  confirmDiscard = false;
  intakeError = '';
  fbThanks = false;
  fbAnswer = null;
  fbText = '';
  fbError = '';
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
  const nextStep = state.subtasks[state.currentSubtaskIndex];
  if (nextStep && nextStep.kind === 'question') startExpand(state.currentSubtaskIndex);

  trackEvent('step_completed');
  if (state.currentSubtaskIndex >= state.subtasks.length) {
    trackEvent('plan_completed', state.planStartedAt ? Math.round((Date.now() - state.planStartedAt) / 1000) : undefined);
    usage.completedPlans = (usage.completedPlans || 0) + 1;
    saveUsage();
  }

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
  if (!mounted) return; // in-flight responses can finish after unmount
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
avatar.title = (state.focusSession ? 'Focusing...' : stageConfig.label) +
  (state.avatarMinimized ? '' : ` · click to ask ${avatarProfile.name}`);

  const nextThreshold = getNextThreshold(newStage);
  const xpLabel = document.getElementById('studbud-avatar-xp');
  xpLabel.textContent = nextThreshold !== null
    ? `${state.xp}/${nextThreshold} XP`
    : `${state.xp} XP (max)`;

  renderAvatarName();

  if (stageChanged) {
    avatar.classList.add('studbud-evolved');
    setTimeout(() => avatar.classList.remove('studbud-evolved'), 1200);
  }

  // Chat bubble: minimizing the avatar dismisses it; any change of current step starts a fresh conversation.
  if (state.avatarMinimized && bubble.open) closeBubble();
  const curStep = state.subtasks[state.currentSubtaskIndex];
  const stepKey = curStep ? `${state.currentSubtaskIndex}:${curStep.text}` : 'none';
  if (lastStepKey !== null && stepKey !== lastStepKey) resetBubbleForNewStep();
  lastStepKey = stepKey;

  renderCurrentSubtask();
  renderMini();
}

// Name label next to the XP text, and the one-time naming card.
function renderAvatarName() {
  const nameEl = document.getElementById('studbud-avatar-name');
  if (nameEl) {
    nameEl.textContent = avatarProfile.name; // textContent only: the name is user input
    nameEl.title = avatarProfile.name;
  }
  const card = document.getElementById('studbud-name-card');
  if (card) card.classList.toggle('studbud-hidden', !!avatarProfile.chosen);
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
      <div id="studbud-feedback-slot"></div>
      <button id="studbud-new-task" class="studbud-primary-btn">Start a new assignment</button>
      ${focusSlot}`;
    document.getElementById('studbud-new-task').addEventListener('click', resetPlan);
    mountFeedback('completion');
  } else {
    renderStep(container, focusSlot);
  }
  renderFocusArea();
}

function intakeErrorHtml() {
  return intakeError ? `<div class="studbud-error">${escapeHtml(intakeError)}</div>` : '';
}

// ---- Waitlist (unlimited access) ----
// The email goes only to /api/waitlist, on its own: no install id, no usage data. Only a "joined" flag and an
// anonymous waitlist_join event are kept on this side, so the join rate can be measured without linking the two.

const WAITLIST_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function waitlistHtml() {
  if (usage.waitlistJoined) {
    return `<div class="studbud-upsell-thanks">You're on the list! We'll email you when unlimited access launches.</div>`;
  }
  return `
    <div class="studbud-waitlist">
      <input id="studbud-waitlist-email" class="studbud-field-input" type="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="you@school.edu">
      <div id="studbud-waitlist-error" class="studbud-error studbud-hidden"></div>
      <button id="studbud-waitlist-submit" class="studbud-primary-btn">Join the waitlist</button>
      <div class="studbud-note">We'll only email you when unlimited access launches.</div>
    </div>`;
}

function wireWaitlist(container) {
  const input = container.querySelector('#studbud-waitlist-email');
  const btn = container.querySelector('#studbud-waitlist-submit');
  const err = container.querySelector('#studbud-waitlist-error');
  if (!input || !btn || !err) return; // already joined
  input.value = waitlistDraft; // set as a property, not an HTML attribute: escapeHtml() does not escape quotes

  // Typing must not trigger the host page's keyboard shortcuts.
  ['keydown', 'keypress', 'keyup'].forEach((evt) => input.addEventListener(evt, (e) => e.stopPropagation()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      btn.click();
    }
  });
  input.addEventListener('input', () => {
    waitlistDraft = input.value;
    err.classList.add('studbud-hidden');
  });

  const showError = (msg) => {
    err.textContent = msg;
    err.classList.remove('studbud-hidden');
    btn.disabled = false;
    btn.textContent = 'Join the waitlist';
  };

  btn.addEventListener('click', () => {
    const email = input.value.trim();
    if (email.length > 254 || !WAITLIST_EMAIL_RE.test(email)) {
      showError('Enter a valid email address.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Joining…';
    try {
      chrome.runtime.sendMessage({ type: 'WAITLIST_JOIN', payload: { email } }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          showError(response && response.limit ? 'Too many attempts. Try again tomorrow.' : "Couldn't join. Try again in a second.");
          return;
        }
        waitlistDraft = '';
        usage.waitlistJoined = true;
        saveUsage();
        trackEvent('waitlist_join');
        render();
      });
    } catch (e) {
      showError("Couldn't join. Try again in a second."); // e.g. extension was reloaded while this tab stayed open
    }
  });
}

// Shown instead of the intake form once the beta cap is used. Never shown mid-plan.
// There is no billing yet: "Upgrade" is a demand test, so the copy says so.
function renderUpgradeWall(container, focusSlot) {
  const n = usage.completedPlans || 0;
  const value = n > 0 ? `and completed ${n} assignment${n === 1 ? '' : 's'} with StudBud! ` : '';

  if (!usage.limitHit) {
    usage.limitHit = true; // send limit_hit once per install
    saveUsage();
    trackEvent('limit_hit');
  }

  // Three questions, each shown only if the earlier answers make it relevant:
  //   use (yes/no) -> pay (yes/maybe/no, only after "yes") -> price (only after pay yes/maybe).
  // A use answer already given in the completion feedback card counts, so nobody is asked twice.
  // Each answer is recorded once, anonymously. The price event carries the pay answer: pay_<yes|maybe>_<price>.
  const use = usage.useChoice || usage.reuseAnswer;
  const pay = usage.payChoice;
  const done = use === 'no' || pay === 'no' || !!usage.priceChoice; // priceChoice also covers answers from older builds

  if (done) {
    // The waitlist is offered only to students who said yes/maybe to paying (they have a priceChoice).
    // 'none' is what older builds stored for "not interested".
    const interested = !!usage.priceChoice && usage.priceChoice !== 'none';
    container.innerHTML = `
      <div class="studbud-intake-title">Thanks — You're helping us make StudBud better!</div>
      <div class="studbud-intake-sub">Unlimited access isn't available... yet.${interested ? ' Join the waitlist to be the first to know!' : ''}</div>
      ${interested ? waitlistHtml() : ''}
      <div id="studbud-feedback-slot"></div>
      ${focusSlot}`;
    if (interested) wireWaitlist(container);
    mountFeedback('limit_hit');
    return;
  }

  const ask = (title, sub, options, onPick) => {
    container.innerHTML = `
      <div class="studbud-intake-title">${title}</div>
      ${sub ? `<div class="studbud-intake-sub">${sub}</div>` : ''}
      <div class="studbud-type-row">
        ${options.map(([v, label]) => `<button class="studbud-type-btn" data-v="${v}">${label}</button>`).join('')}
      </div>
      ${focusSlot}`;
    container.querySelectorAll('.studbud-type-btn').forEach((btn) => {
      btn.addEventListener('click', () => onPick(btn.dataset.v));
    });
  };

  if (!use) {
    ask(
      'Would you use StudBud on your next assignment?',
      `You've used all ${ANALYSIS_LIMIT} beta analyses ${value}Unlimited access isn't available... yet! Your answers help us improve StudBud!`,
      [['yes', 'Yes'], ['no', 'No']],
      (v) => {
        usage.useChoice = v;
        saveUsage();
        trackEvent(`use_${v}`);
        render();
      }
    );
    return;
  }

  if (!pay) {
    ask(
      'Would you pay for unlimited assignment upload & breakdown and unlimited StudBud chat help?',
      '',
      [['yes', 'Yes'], ['maybe', 'Maybe, depends on the price'], ['no', 'No']],
      (v) => {
        usage.payChoice = v;
        saveUsage();
        if (v === 'no') trackEvent('pay_no'); // yes / maybe are recorded together with the price below
        render();
      }
    );
    return;
  }

  ask(
    "What would you pay per month?",
    '',
    [['lt3', 'Under $3'], ['3', '$3'], ['5', '$5'], ['8', '$8 or more']],
    (v) => {
      usage.priceChoice = v;
      saveUsage();
      trackEvent(`pay_${pay}_${v}`);
      render();
    }
  );
}

function renderIntake(container, focusSlot) {
  const left = ANALYSIS_LIMIT - (usage.analysesUsed || 0);

  if (left <= 0) {
    renderUpgradeWall(container, focusSlot);
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

// "Step 3 of 9" for ordinary plans; "Question 4 of 11 · step 2 of 4" inside a worksheet question.
function progressText() {
  const steps = state.subtasks;
  const i = state.currentSubtaskIndex;
  const cur = steps[i];
  if (cur && cur.gid != null) {
    const gids = [...new Set(steps.filter((x) => x.gid != null).map((x) => x.gid))];
    const q = `Question ${gids.indexOf(cur.gid) + 1} of ${gids.length}`;
    if (cur.kind === 'question') return q;
    let start = i;
    let end = i;
    while (start > 0 && steps[start - 1].gid === cur.gid) start -= 1;
    while (end < steps.length - 1 && steps[end + 1].gid === cur.gid) end += 1;
    return `${q} · step ${i - start + 1} of ${end - start + 1}`;
  }
  return `Step ${i + 1} of ${steps.length}`;
}

function stepHeaderHtml(step) {
  const title = (state.taskTitle || state.currentTask || '').slice(0, 60);
  const group = step.kind !== 'question' && step.group ? `<div class="studbud-group">${escapeHtml(step.group)}</div>` : '';
  const ask = step.kind !== 'question' && step.ask ? `<div class="studbud-ask">${escapeHtml(step.ask)}</div>` : '';
  return `
    <div class="studbud-current-task">Current Task: ${escapeHtml(title)}</div>
    <div class="studbud-step-progress">${progressText()}</div>
    ${group}${ask}`;
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

function renderQuestionStep(container, focusSlot, step, index) {
  const loading = expandingIndex === index;
  const body = loading
    ? `<div class="studbud-loading">Breaking down ${escapeHtml(step.text.split(':')[0])}…</div>`
    : `<div class="studbud-step-text">${escapeHtml(step.text)}</div>
       <div class="studbud-step-detail">${expandError ? 'Could not load the steps for this question.' : "Steps for this question aren't loaded yet."}</div>
       <button id="studbud-expand-btn" class="studbud-primary-btn">${expandError ? 'Try again' : 'Load steps'}</button>`;
  container.innerHTML = `${stepHeaderHtml(step)}${body}${focusSlot}${planFooterHtml()}`;

  const btn = document.getElementById('studbud-expand-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      startExpand(index);
      render();
    });
  }
  wirePlanFooter();
}

function renderStep(container, focusSlot) {
  const step = state.subtasks[state.currentSubtaskIndex];
  if (step.kind === 'question') {
    renderQuestionStep(container, focusSlot, step, state.currentSubtaskIndex);
    return;
  }
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
