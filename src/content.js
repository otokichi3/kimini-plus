// Kimini英会話のページから予約済みレッスンを抽出し、background に渡す。
//
// Kimini は SPA ではなく通常のページ遷移で動くため、XHR の傍受はできない。
// 代わりに、レッスン情報が載っているページを開いたタイミングで DOM から読み取る。
//   - /plus/lesson/reserve/result … 予約確定の直後（即時登録）
//   - /plus/calendar/ など          … 取りこぼしの補完
// レッスン詳細リンク(/plus/lesson/<id>)の id を一意キーにするので、
// 同じ予約を何度読み取っても登録は1件で済む。

const DATETIME_RE =
  /(\d{4})-(\d{2})-(\d{2})\s*\([日月火水木金土]\)\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;

// レッスン一覧には過去のレッスンも並ぶ。ラベルの付き方は状態によって違い、
//   未来の予約 … 「予約」
//   受講済み   … ラベルなし
//   不成立     … 「不成立」
// となるため、ラベルだけでは受講済みと予約を区別できない。
// 「開始時刻が未来であること」を主な条件にし、否定的なラベルを除外する。
const EXCLUDED_LABELS = ['不成立', 'キャンセル', '欠席'];

function textOf(el) {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

// レッスン詳細リンクから、その予約1件分を包む最小の要素まで遡る
function findBlock(anchor) {
  let el = anchor;
  while (el && el !== document.body) {
    if (DATETIME_RE.test(el.textContent)) {
      // 複数の予約をまとめて含む要素まで遡ってしまっていないか確認する
      const lessonLinks = el.querySelectorAll('a[href*="/plus/lesson/"]');
      const ids = new Set(
        [...lessonLinks].map((a) => (a.getAttribute('href').match(/\/plus\/lesson\/(\d+)/) || [])[1])
      );
      ids.delete(undefined);
      if (ids.size === 1) return el;
      return null;
    }
    el = el.parentElement;
  }
  return null;
}

function parseBlock(block, lessonId) {
  const m = block.textContent.match(DATETIME_RE);
  if (!m) return null;
  const [, y, mo, d, sh, sm, eh, em] = m;

  const labels = [...block.querySelectorAll('.label')].map(textOf);
  if (labels.some((l) => EXCLUDED_LABELS.some((x) => l.includes(x)))) return null;

  const teacherLink = block.querySelector('a[href*="/plus/teacher/"][class*="bold"]')
    || block.querySelector('a[href*="/plus/teacher/"]:not(:has(img))')
    || [...block.querySelectorAll('a[href*="/plus/teacher/"]')].find((a) => textOf(a));
  const teacher = textOf(teacherLink);

  const courseLink = block.querySelector('a[href*="/plus/entry/"]');
  const course = textOf(courseLink);

  // 教材名はコースリンクを含むボックス内の、コースリンク以外のリンク
  let material = '';
  if (courseLink) {
    const courseBox = courseLink.closest('div').parentElement || courseLink.parentElement;
    const other = [...courseBox.querySelectorAll('a')].find(
      (a) => a !== courseLink && textOf(a) && !a.href.includes('/plus/entry/')
    );
    material = textOf(other);
  }

  const pad = (n) => String(n).padStart(2, '0');
  const start = `${y}-${mo}-${d}T${pad(sh)}:${sm}:00`;
  let endDay = `${y}-${mo}-${d}`;
  // 24時をまたぐ枠（例 23:45-00:10）に備える
  if (Number(eh) < Number(sh)) {
    const dt = new Date(`${y}-${mo}-${d}T00:00:00`);
    dt.setDate(dt.getDate() + 1);
    endDay = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }
  const end = `${endDay}T${pad(eh)}:${em}:00`;

  // 受講済みのレッスンを拾わないよう、開始済みのものは対象外にする
  if (new Date(start).getTime() <= Date.now()) return null;

  return {
    lessonId,
    start,
    end,
    teacher,
    course,
    material,
    lessonUrl: `https://kimini.online/plus/lesson/${lessonId}`,
  };
}

// キャンセルされた予約をカレンダーから消すには、「今どれが予約中か」の完全な一覧が要る。
// 表示中のページはその一部しか映していないことがあるため、レッスン一覧の検索フォームと
// 同じ POST を投げ、予約中だけに絞った一覧を取り直す。
//
// 件数表示と取得件数が食い違うときは null を返す。ページ送りの向こうに隠れている予約が
// あるということで、そのまま消すと「見えなかっただけの予約」を削除してしまう。
async function fetchReservedLessonIds() {
  try {
    const response = await fetch('/plus/lesson/list', {
      method: 'POST',
      body: new URLSearchParams({ '.submitted': '1', status: 'reserved' }),
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!response.ok) return null;

    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const ids = [
      ...new Set(
        [...doc.querySelectorAll('a[href*="/plus/lesson/"]')]
          .map((a) => (a.getAttribute('href').match(/\/plus\/lesson\/(\d+)/) || [])[1])
          .filter(Boolean)
      ),
    ];

    const total = doc.body.textContent.replace(/\s+/g, '').match(/全(\d+)レッスン/);
    if (!total || Number(total[1]) !== ids.length) return null;

    return ids;
  } catch (error) {
    return null;
  }
}

function collectReservations() {
  const found = new Map();
  for (const a of document.querySelectorAll('a[href*="/plus/lesson/"]')) {
    const idMatch = a.getAttribute('href').match(/\/plus\/lesson\/(\d+)/);
    if (!idMatch) continue;
    const lessonId = idMatch[1];
    if (found.has(lessonId)) continue;

    const block = findBlock(a);
    if (!block) continue;

    const reservation = parseBlock(block, lessonId);
    if (reservation && reservation.teacher) found.set(lessonId, reservation);
  }
  return [...found.values()];
}

// 予約の一覧性があるページでだけキャンセルを確認する。全ページで問い合わせるのは無駄が多い。
const CANCELLATION_CHECK_PATHS = [
  '/plus/calendar',
  '/plus/lesson/list',
  '/plus/lesson/reserve/result',
];

let cancellationChecked = false;

async function run() {
  const reservations = collectReservations();
  const fromConfirmation = location.pathname.startsWith('/plus/lesson/reserve/result');

  let reservedLessonIds = null;
  if (!cancellationChecked && CANCELLATION_CHECK_PATHS.some((p) => location.pathname.startsWith(p))) {
    cancellationChecked = true;
    reservedLessonIds = await fetchReservedLessonIds();
  }

  if (!reservations.length && !reservedLessonIds) return;

  chrome.runtime.sendMessage({
    type: 'kimini-reservations',
    reservations,
    reservedLessonIds,
    // 予約確定直後だけは、未認証なら Google のログイン画面を出してでも登録しにいく
    fromConfirmation,
  });
}

run();

// 予約確定後にページ内容が差し替わる作りだった場合に備え、
// DOM の変化が落ち着いたタイミングでもう一度だけ読み直す。
let settleTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(run, 800);
});
observer.observe(document.body, { childList: true, subtree: true });
setTimeout(() => observer.disconnect(), 15000);
