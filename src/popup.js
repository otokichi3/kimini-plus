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

// 予約済みのレッスンの取り込み。
//
// 実際の処理は service worker 側にある。ポップアップは閉じると動作が止まるため、
// こちらでタブを開くと、閉じられたときにタブが残ってしまう。
// ポップアップが閉じられても取り込みは最後まで走り、結果を受け取れないだけになる。
const importButton = document.getElementById('import');
const importStatus = document.getElementById('importStatus');

function describe(result) {
  if (!result) return '結果を確認できませんでした';
  switch (result.status) {
    case 'disabled':
      return '自動登録がオフになっています';
    case 'needsAuth':
      return 'Googleアカウントの連携が必要です';
    case 'needsKiminiLogin':
      return 'Kimini にログインしてからお試しください';
    case 'busy':
      return '取り込み中です';
    case 'timeout':
      return '時間内に確認できませんでした';
    case 'error':
      return `失敗しました: ${result.message || ''}`;
    case 'ok': {
      const parts = [];
      if (result.created) parts.push(`${result.created}件を登録`);
      if (result.removed) parts.push(`${result.removed}件を削除`);
      return parts.length ? `${parts.join('、')}しました` : '変更はありませんでした';
    }
    default:
      return '結果を確認できませんでした';
  }
}

importButton.addEventListener('click', async () => {
  importButton.disabled = true;
  importStatus.textContent = '確認しています…';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'kimini-manual-sync' });
    importStatus.textContent = describe(response && response.result);
  } catch (error) {
    importStatus.textContent = `失敗しました: ${error.message}`;
  } finally {
    importButton.disabled = false;
  }
});

document.getElementById('reset').addEventListener('click', async () => {
  await chrome.storage.local.remove('syncedLessons');
  showStatus('消去しました');
});

load();
