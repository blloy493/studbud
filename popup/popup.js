// popup/popup.js

const SETTINGS_KEY = 'studbudSettings';
const STATE_KEY = 'studbudState';
const AVATAR_KEY = 'studbudAvatar'; // same key as content.js; kept separate so reset can't clear it
const DEFAULT_NAME = 'Olly';
const MAX_NAME_LEN = 16;
let initialName = DEFAULT_NAME;   // name shown when the popup opened; save only writes if it changed

const DEFAULT_SETTINGS = {
  avatarHidden: false,
  excludedSites: [],
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const settings = await loadSettings();

  document.getElementById('hide-avatar').checked = settings.avatarHidden;
  document.getElementById('excluded-sites').value = settings.excludedSites.join('\n');

  const profile = await loadAvatarProfile();
  initialName = profile.name;
  const popupNameInput = document.getElementById('avatar-name');
  const popupNameCount = document.getElementById('avatar-name-count');
  const updatePopupCount = () => {
    popupNameCount.textContent = `${MAX_NAME_LEN - popupNameInput.value.length} characters left`;
  };
  popupNameInput.value = profile.name;
  popupNameInput.addEventListener('input', updatePopupCount);
  updatePopupCount();

  document.getElementById('save-settings').addEventListener('click', saveSettings);
  document.getElementById('reset-btn').addEventListener('click', resetProgress);
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY], (result) => {
      resolve(result[SETTINGS_KEY] ? { ...DEFAULT_SETTINGS, ...result[SETTINGS_KEY] } : { ...DEFAULT_SETTINGS });
    });
  });
}

function cleanName(raw) {
  const n = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
  return n || DEFAULT_NAME;
}

function loadAvatarProfile() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AVATAR_KEY], (result) => {
      resolve(result[AVATAR_KEY] ? { name: DEFAULT_NAME, chosen: false, ...result[AVATAR_KEY] } : { name: DEFAULT_NAME, chosen: false });
    });
  });
}

function saveSettings() {
  const avatarHidden = document.getElementById('hide-avatar').checked;
  const excludedSites = document
    .getElementById('excluded-sites')
    .value.split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);

  const data = { [SETTINGS_KEY]: { avatarHidden, excludedSites } };

  // Only write the name if it was edited, so saving other settings never marks the
  // first-open naming prompt as answered.
  const nameInput = document.getElementById('avatar-name');
  const name = cleanName(nameInput.value);
  if (name !== initialName) {
    data[AVATAR_KEY] = { name, chosen: true };
    initialName = name;
  }
  nameInput.value = name;

  chrome.storage.local.set(data, () => {
    showStatus('Settings saved.');
    setTimeout(() => window.close(), 700); // brief delay so the confirmation is visible
  });
}

function resetProgress() {
  const confirmed = confirm('Reset all progress? This clears XP, evolution stage, and your current task. The buddy name is kept. This cannot be undone. Please reload page after reset.');
  if (!confirmed) return;

  chrome.storage.local.remove([STATE_KEY], () => {
    showStatus('Progress reset.');
  });
}

function showStatus(message) {
  const status = document.getElementById('status');
  status.textContent = message;
  setTimeout(() => {
    status.textContent = '';
  }, 2000);
}
