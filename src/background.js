// 受け取った予約を Google カレンダーに登録する。
//
// 二重登録の防止は3段構え:
//   1. chrome.storage に登録済みレッスンIDを記録する
//   2. Calendar 側を iCalUID で検索して既存イベントがないか確かめる
//   3. それでも競合したら insert が 409 を返すので、成功扱いにする
// 1 だけだと拡張を入れ直したときに重複するため、2 と 3 を併用している。

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TIME_ZONE = 'Asia/Tokyo';

// 登録済みの記録を残しておく期間。
// 記録は二重登録を防ぐためのもので、そもそも開始時刻が未来のレッスンしか登録しない。
// 十分に過ぎたレッスンの記録は、持っていても再登録の判定に使われることがない。
const RECORD_RETENTION_DAYS = 90;

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

async function deleteEvent(token, settings, lessonId) {
  const existing = await findExistingEvent(token, settings, lessonId);
  if (!existing) return false;

  const response = await callApi(
    token,
    `/calendars/${encodeURIComponent(settings.calendarId)}/events/${encodeURIComponent(existing.id)}`,
    { method: 'DELETE' }
  );
  // 410/404 は既に消えている場合。消えていること自体が目的なので成功として扱う
  if (!response.ok && ![404, 410].includes(response.status)) {
    throw new Error(`Calendar API ${response.status}`);
  }
  return true;
}

// 予約中の一覧から消えたレッスンは、キャンセルされたものとみなしてカレンダーからも消す。
// ただし開始時刻を過ぎたものは対象外。受講を終えたレッスンも「予約中」ではなくなるため、
// 時刻で線を引かないと、受け終わったレッスンの予定まで消えてしまう。
async function removeCancelled(token, settings, reservedLessonIds, syncedLessons) {
  const reserved = new Set(reservedLessonIds);
  const removed = [];

  for (const [lessonId, record] of Object.entries(syncedLessons)) {
    if (reserved.has(lessonId)) continue;
    if (!record.start || new Date(record.start).getTime() <= Date.now()) continue;

    try {
      await deleteEvent(token, settings, lessonId);
      delete syncedLessons[lessonId];
      removed.push(record);
    } catch (error) {
      console.error('[Kimini] キャンセル分の削除に失敗しました', lessonId, error);
    }
  }
  return removed;
}

// 古い記録を捨てる。開始時刻が分からない壊れた記録も、ここで一緒に片付ける。
// そうした記録はキャンセル判定でも毎回読み飛ばされるだけで、放っておくと残り続ける。
function pruneSyncedLessons(syncedLessons) {
  const threshold = Date.now() - RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;

  for (const [lessonId, record] of Object.entries(syncedLessons)) {
    const at = new Date(record.start || record.syncedAt || '').getTime();
    if (Number.isNaN(at) || at < threshold) {
      delete syncedLessons[lessonId];
      pruned += 1;
    }
  }
  return pruned;
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message,
  });
}

async function handleReservations(reservations, fromConfirmation, reservedLessonIds) {
  const settings = await getSettings();
  if (!settings.enabled) return;

  const { syncedLessons = {} } = await chrome.storage.local.get('syncedLessons');
  const pending = reservations.filter((r) => !syncedLessons[r.lessonId]);

  // キャンセルの確認は、予約中の一覧を取り切れたときだけ行う（content.js 側で保証している）
  const canCheckCancellations = Array.isArray(reservedLessonIds);
  if (!pending.length && !canCheckCancellations) return;

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

  let removed = [];
  if (canCheckCancellations) {
    try {
      removed = await removeCancelled(token, settings, reservedLessonIds, syncedLessons);
    } catch (error) {
      console.error('[Kimini] キャンセルの確認に失敗しました', error);
    }
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

  pruneSyncedLessons(syncedLessons);
  await chrome.storage.local.set({ syncedLessons });

  if (created.length === 1) {
    const r = created[0];
    const when = r.start.replace('T', ' ').slice(0, 16);
    notify('カレンダーに登録しました', `${when} ${r.teacher}`);
  } else if (created.length > 1) {
    notify('カレンダーに登録しました', `${created.length}件のレッスンを追加しました`);
  }

  if (removed.length === 1) {
    const r = removed[0];
    const when = String(r.start).replace('T', ' ').slice(0, 16);
    notify('カレンダーから削除しました', `${when} ${r.teacher || ''}`.trim());
  } else if (removed.length > 1) {
    notify('カレンダーから削除しました', `${removed.length}件のレッスンを削除しました`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'kimini-reservations') return;
  handleReservations(message.reservations, message.fromConfirmation, message.reservedLessonIds)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error('[Kimini]', error);
      sendResponse({ ok: false, error: String(error) });
    });
  return true; // 非同期に応答する
});
