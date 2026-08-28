const DEFAULTS = {
  calendarId: 'primary',
  reminderMinutes: 10,
  titleTemplate: 'Kimini英会話 - {teacher}',
  enabled: true,
};

const fields = ['calendarId', 'reminderMinutes', 'titleTemplate'];
const statusEl = document.getElementById('status');

function showStatus(text) {
  statusEl.textContent = text;
  setTimeout(() => { statusEl.textContent = ''; }, 4000);
}

async function load() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  for (const key of fields) document.getElementById(key).value = settings[key];
  document.getElementById('enabled').checked = settings.enabled;
}

document.getElementById('save').addEventListener('click', async () => {
  const settings = { enabled: document.getElementById('enabled').checked };
  for (const key of fields) settings[key] = document.getElementById(key).value;
  settings.calendarId = settings.calendarId.trim() || 'primary';
  settings.reminderMinutes = Number(settings.reminderMinutes);
  await chrome.storage.sync.set(settings);
  showStatus('保存しました');
});

document.getElementById('connect').addEventListener('click', () => {
  chrome.identity.getAuthToken({ interactive: true }, (token) => {
    if (chrome.runtime.lastError || !token) {
      showStatus(`連携できませんでした: ${chrome.runtime.lastError?.message || '不明なエラー'}`);
      return;
    }
    showStatus('連携しました');
  });
});

document.getElementById('reset').addEventListener('click', async () => {
  await chrome.storage.local.remove('syncedLessons');
  showStatus('消去しました');
});

load();
