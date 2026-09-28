// popup/popup.js

const SETTINGS_KEY = 'studbudSettings';
const STATE_KEY = 'studbudState';

const DEFAULT_SETTINGS = {
  avatarHidden: false,
  excludedSites: [],
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const settings = await loadSettings();

  document.getElementById('hide-avatar').checked = settings.avatarHidden;
  document.getElementById('excluded-sites').value = settings.excludedSites.join('\n');

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

function saveSettings() {
  const avatarHidden = document.getElementById('hide-avatar').checked;
  const excludedSites = document
    .getElementById('excluded-sites')
    .value.split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);

  chrome.storage.local.set({ [SETTINGS_KEY]: { avatarHidden, excludedSites } }, () => {
    showStatus('Settings saved.');
  });
}

function resetProgress() {
  const confirmed = confirm('Reset all progress? This clears XP, evolution stage, and your current task. This cannot be undone.');
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
