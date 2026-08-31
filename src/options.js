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
// Kimini のセッション Cookie は、設定ページ（chrome-extension: のページ）から直接 fetch しても
// 送られるとは限らない。確実なのは Kimini のページ自体に処理させることなので、
// レッスン一覧を裏でタブに開き、いつも動いている content script に任せて閉じる。
const SYNC_URL = 'https://kimini.online/plus/lesson/list?sync=manual';
const SYNC_TIMEOUT_MS = 30000;

const importButton = document.getElementById('import');
const importStatus = document.getElementById('importStatus');

function describe(result) {
  if (!result) return '結果を確認できませんでした';
  switch (result.status) {
    case 'disabled':
      return '自動登録がオフになっています';
    case 'needsAuth':
      return 'Googleアカウントの連携が必要です';
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

// content script は読み込みのたびに走るため、結果が複数回届くことがある。最初の1回だけ使う。
function waitForResult() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve(null);
    }, SYNC_TIMEOUT_MS);

    function listener(message) {
      if (message.type !== 'kimini-sync-result') return;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      resolve(message.result);
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

importButton.addEventListener('click', async () => {
  importButton.disabled = true;
  importStatus.textContent = '確認しています…';

  let tab = null;
  try {
    const waiting = waitForResult();
    tab = await chrome.tabs.create({ url: SYNC_URL, active: false });
    const result = await waiting;

    if (result) {
      importStatus.textContent = describe(result);
    } else {
      // Kimini からログインページに飛ばされていると、content script は予約を見つけられない
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      importStatus.textContent =
        current && !current.url.includes('/plus/lesson/list')
          ? 'Kimini にログインしてから、もう一度お試しください'
          : '予約が見つかりませんでした';
    }
  } catch (error) {
    importStatus.textContent = `失敗しました: ${error.message}`;
  } finally {
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
    importButton.disabled = false;
  }
});

document.getElementById('reset').addEventListener('click', async () => {
  await chrome.storage.local.remove('syncedLessons');
  showStatus('消去しました');
});

load();
