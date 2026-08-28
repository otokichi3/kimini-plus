// 受け取った予約を Google カレンダーに登録する。
//
// 二重登録の防止は3段構え:
//   1. chrome.storage に登録済みレッスンIDを記録する
//   2. Calendar 側を iCalUID で検索して既存イベントがないか確かめる
//   3. それでも競合したら insert が 409 を返すので、成功扱いにする
// 1 だけだと拡張を入れ直したときに重複するため、2 と 3 を併用している。

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TIME_ZONE = 'Asia/Tokyo';

const DEFAULTS = {
  calendarId: 'primary',
  reminderMinutes: 10,
  titleTemplate: 'Kimini英会話 - {teacher}',
  enabled: true,
};

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

function iCalUidFor(lessonId) {
  return `kimini-lesson-${lessonId}@kimini-calendar-sync`;
}

async function getToken(interactive) {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        resolve(null);
        return;
      }
      resolve(token);
    });
  });
}

async function callApi(token, path, options = {}) {
  const response = await fetch(`${CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    // 期限切れのトークンはキャッシュから捨てて、呼び出し側にリトライさせる
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    const error = new Error('unauthorized');
    error.unauthorized = true;
    throw error;
  }
  return response;
}

function buildEvent(reservation, settings) {
  const title = settings.titleTemplate
    .replace('{teacher}', reservation.teacher || '講師未定')
    .replace('{course}', reservation.course || '')
    .replace('{material}', reservation.material || '');

  const descriptionLines = [];
  if (reservation.course) descriptionLines.push(`コース: ${reservation.course}`);
  if (reservation.material) descriptionLines.push(`教材: ${reservation.material}`);
  if (reservation.teacher) descriptionLines.push(`講師: ${reservation.teacher}`);
  descriptionLines.push('', `レッスンの詳細: ${reservation.lessonUrl}`);

  const event = {
    iCalUID: iCalUidFor(reservation.lessonId),
    summary: title,
    description: descriptionLines.join('\n'),
    source: { title: 'Kimini英会話', url: reservation.lessonUrl },
    start: { dateTime: reservation.start, timeZone: TIME_ZONE },
    end: { dateTime: reservation.end, timeZone: TIME_ZONE },
  };

  if (Number(settings.reminderMinutes) >= 0) {
    event.reminders = {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: Number(settings.reminderMinutes) }],
    };
  }
  return event;
}

async function findExistingEvent(token, settings, lessonId) {
  const params = new URLSearchParams({
    iCalUID: iCalUidFor(lessonId),
    showDeleted: 'false',
    maxResults: '1',
  });
  const response = await callApi(
    token,
    `/calendars/${encodeURIComponent(settings.calendarId)}/events?${params}`
  );
  if (!response.ok) return null;
  const data = await response.json();
  return (data.items && data.items[0]) || null;
}

async function createEvent(token, settings, reservation) {
  const response = await callApi(
    token,
    `/calendars/${encodeURIComponent(settings.calendarId)}/events`,
    { method: 'POST', body: JSON.stringify(buildEvent(reservation, settings)) }
  );

  // 同じ iCalUID のイベントが既にある場合。登録済みとみなす
  if (response.status === 409) return { alreadyExists: true };

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Calendar API ${response.status}: ${body.slice(0, 300)}`);
  }
  return { created: await response.json() };
}

async function syncReservation(token, settings, reservation) {
  const existing = await findExistingEvent(token, settings, reservation.lessonId);
  if (existing) return 'skipped';
  const result = await createEvent(token, settings, reservation);
  return result.alreadyExists ? 'skipped' : 'created';
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message,
  });
}

async function handleReservations(reservations, fromConfirmation) {
  const settings = await getSettings();
  if (!settings.enabled) return;

  const { syncedLessons = {} } = await chrome.storage.local.get('syncedLessons');
  const pending = reservations.filter((r) => !syncedLessons[r.lessonId]);
  if (!pending.length) return;

  // 予約確定の直後だけは、必要なら Google のログイン画面を出す。
  // それ以外のページでは、黙って何も起きない方がいいので非対話で試すだけにする。
  let token = await getToken(false);
  if (!token && fromConfirmation) token = await getToken(true);
  if (!token) {
    if (fromConfirmation) {
      notify('カレンダーに登録できませんでした', 'Googleアカウントの連携が必要です。拡張機能の設定を開いてください。');
    }
    return;
  }

  const created = [];
  for (const reservation of pending) {
    try {
      let outcome;
      try {
        outcome = await syncReservation(token, settings, reservation);
      } catch (error) {
        if (!error.unauthorized) throw error;
        // トークンを取り直して1度だけやり直す
        token = await getToken(fromConfirmation);
        if (!token) throw error;
        outcome = await syncReservation(token, settings, reservation);
      }

      syncedLessons[reservation.lessonId] = {
        syncedAt: new Date().toISOString(),
        start: reservation.start,
        teacher: reservation.teacher,
      };
      if (outcome === 'created') created.push(reservation);
    } catch (error) {
      console.error('[Kimini] 登録に失敗しました', reservation, error);
      if (fromConfirmation) {
        notify('カレンダーに登録できませんでした', String(error.message || error).slice(0, 200));
      }
    }
  }

  await chrome.storage.local.set({ syncedLessons });

  if (created.length === 1) {
    const r = created[0];
    const when = r.start.replace('T', ' ').slice(0, 16);
    notify('カレンダーに登録しました', `${when} ${r.teacher}`);
  } else if (created.length > 1) {
    notify('カレンダーに登録しました', `${created.length}件のレッスンを追加しました`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'kimini-reservations') return;
  handleReservations(message.reservations, message.fromConfirmation)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error('[Kimini]', error);
      sendResponse({ ok: false, error: String(error) });
    });
  return true; // 非同期に応答する
});
