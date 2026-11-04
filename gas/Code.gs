/**
 * PUG テニス練習 出欠管理 API（Google Apps Script）
 *
 * ・スタンドアロンのApps Scriptとして、SPREADSHEET_ID のスプレッドシートを読み書きします
 * ・初回は setup() を一度だけ実行してください（列を追加したときも再実行してOK）
 * ・監視（日次レポート・不審操作の通知）を使うときは installTriggers() を一度実行してください
 * ・LINEから受け取る情報は「表示名」と内部判別用の userId のみです
 * ・参加費は金額の設定と表示のみ（支払いの記録・確認は行いません）
 */

// ===== 設定 =====
const LINE_CHANNEL_ID = '2012327263'; // PUG 練習出欠（LINEログインチャネル）。秘密情報ではありません
const SPREADSHEET_ID = '1Lh9l6DW1c2YRP4In2J7ZR9OyTKi6bNAHhL1jwCSGGGY'; // スプレッドシート「PUG 練習出欠」
const TZ = 'Asia/Tokyo';
const REPORT_TO = '';        // 通知の送り先（カンマ区切り）。空欄なら実行アカウント（チーム用アカウント）
const LOG_KEEP_DAYS = 90;    // 操作ログの保存日数
const LIMITS = { dates: 62, slots: 10, capacity: 999, fee: 100000, name: 50, comment: 100, place: 50, note: 200 };

let ssCache_ = null;
function ss_() { return ssCache_ || (ssCache_ = SpreadsheetApp.openById(SPREADSHEET_ID)); }

const SHEETS = {
  events:   { name: '開催日',   headers: ['eventId', '日付', '場所', 'メモ', '登録日時', 'ゲスト公開'] },
  slots:    { name: '時間枠',   headers: ['slotId', 'eventId', '開始', '終了', '定員(0=無制限)', '参加費(円)'] },
  entries:  { name: '出欠',     headers: ['slotId', 'userId', '表示名', '出欠', 'コメント', '更新日時'] },
  users:    { name: 'ユーザー', headers: ['userId', '表示名', '最終アクセス', '管理者', '区分'] },
  settings: { name: '設定',     headers: ['項目', '値', '説明'] },
  logs:     { name: '操作ログ', headers: ['日時', 'userId', '表示名', '区分', '操作', '対象', '結果', '詳細'] },
};
// 文字列書式にする列数（チェックボックス列より左だけ）
const TEXT_COLS = { events: 5, users: 3 };
// ユーザー区分：初めて開いた人はゲスト。管理者が「メンバー」に切り替えると全日程が見える
const MEMBER = 'メンバー';
const GUEST = 'ゲスト';
const ADMIN_LABEL = '管理者';
const DEFAULT_SETTINGS = [
  ['朝の参加費', '300', 'ナイター開始より前に始まる枠の参加費（円）'],
  ['ナイター参加費', '500', 'ナイター開始以降に始まる枠の参加費（円）'],
  ['ナイター開始', '17:00', 'この時刻以降に始まる枠をナイター料金にする'],
];
const STATUSES = ['○', '△', '×'];
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

// ===== 初期設定（一度だけ実行） =====
function setup() {
  const ss = ss_();
  Object.keys(SHEETS).forEach(key => {
    const def = SHEETS[key];
    const sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // 日付・時刻が自動変換されないよう文字列書式に（チェックボックス列は除く）
    const textCols = TEXT_COLS[key] || def.headers.length;
    sh.getRange(1, 1, sh.getMaxRows(), textCols).setNumberFormat('@');
  });
  // ユーザーの「区分」列：文字列＋プルダウン（メンバー／ゲスト）
  const us = sheet_('users');
  us.getRange(2, 5, us.getMaxRows() - 1, 1).setNumberFormat('@').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([MEMBER, GUEST], true).setAllowInvalid(false).build());
  // 区分が空の既存ユーザー（この機能より前に登録された人）はメンバーとして移行
  readRows_('users').forEach(r => { if (!str_(r.v[4])) us.getRange(r.row, 5).setValue(MEMBER); });
  // 開催日の「ゲスト公開」列：既存の行にチェックボックスを付ける
  const evs = sheet_('events');
  readRows_('events').forEach(r => {
    const c = evs.getRange(r.row, 6);
    if (!c.getDataValidation()) c.insertCheckboxes();
  });
  // 設定シートに足りない項目を追加
  const existing = readRows_('settings').map(r => str_(r.v[0]));
  appendRows_('settings', DEFAULT_SETTINGS.filter(row => !existing.includes(row[0])));

  const blank = ss.getSheetByName('シート1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  invalidate_.apply(null, CACHED_SHEETS);
}

// ===== エントリーポイント =====
function doGet() {
  return ContentService.createTextOutput('OK');
}

function doPost(e) {
  let res;
  let req = {};
  let user = null;
  try {
    try { req = JSON.parse(e.postData.contents); } catch (_) { throw appErr_('bad_request', '不正なリクエストです'); }
    if (!req || typeof req !== 'object' || Array.isArray(req)) throw appErr_('bad_request', '不正なリクエストです');
    user = verifyIdToken_(req.idToken);
    res = handle_(req, user);
  } catch (err) {
    res = { ok: false, error: err.code || 'error', message: err.code ? err.message : 'サーバーでエラーが発生しました' };
    if (!err.code) console.error(err);
  }
  audit_(req, user, res);
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req, user) {
  const role = touchUser_(user);
  const isAdmin = role.isAdmin;
  user.kind = isAdmin ? ADMIN_LABEL : role.isMember ? MEMBER : GUEST;
  user.isNew = role.isNew;
  const requireAdmin = () => { if (!isAdmin) throw appErr_('forbidden', '管理者のみ操作できます'); };

  switch (req.action) {
    case 'list':
      break;
    case 'entry':
      withLock_(() => saveEntry_(user, req, role.isMember));
      break;
    case 'setGuestOpen':
      requireAdmin();
      withLock_(() => setGuestOpen_(str_(req.eventId), req.open === true));
      break;
    case 'createEvents':
      requireAdmin();
      withLock_(() => createEvents_(req));
      break;
    case 'deleteEvent':
      requireAdmin();
      withLock_(() => deleteEvent_(str_(req.eventId)));
      break;
    default:
      throw appErr_('bad_request', '不明な操作です');
  }
  // 操作後は常に最新の一覧を返す（画面側の通信を1回で済ませる）
  const settings = readSettings_();
  return {
    ok: true,
    today: today_(),
    me: { name: user.name, isAdmin, isMember: role.isMember },
    settings,
    events: listEvents_(user.userId, settings, role.isMember),
  };
}

// ===== LINE IDトークン検証 =====
function verifyIdToken_(idToken) {
  // 形の明らかにおかしいトークンは、LINEに問い合わせる前に弾く
  if (typeof idToken !== 'string' || idToken.length > 4096 || !JWT_RE.test(idToken)) {
    throw appErr_('auth', 'ログインが必要です');
  }
  const cache = CacheService.getScriptCache();
  const h = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  const hit = cache.get('tok_' + h);
  if (hit) return JSON.parse(hit);
  if (cache.get('bad_' + h)) throw appErr_('auth', 'ログインの有効期限が切れました');

  // 失敗が急増しているときはLINEへの問い合わせを止める（問い合わせ回数の上限を守る）
  const failKey = 'authfail_' + Math.floor(Date.now() / 60000);
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= 60) {
    alert_('auth-spike', 'ログイン失敗が急増しています',
      '直近1分間に検証できないログインが60件以上ありました。一時的に受付を制限しています。\n操作ログシートを確認してください。');
    throw appErr_('busy', '混み合っています。少し待ってからもう一度お試しください');
  }

  const r = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: LINE_CHANNEL_ID },
    muteHttpExceptions: true,
  });
  const p = r.getResponseCode() === 200 ? JSON.parse(r.getContentText()) : null;
  if (!p || p.aud !== LINE_CHANNEL_ID || !p.sub) {
    cache.put('bad_' + h, '1', 300);
    cache.put(failKey, String(fails + 1), 120);
    throw appErr_('auth', 'ログインの有効期限が切れました');
  }
  const user = { userId: str_(p.sub), name: str_(p.name).slice(0, LIMITS.name) || '名前未設定' };
  // キャッシュはトークンの有効期限を超えない範囲で最大5分
  const ttl = Math.min(300, Math.floor(Number(p.exp) - Date.now() / 1000) - 10);
  if (ttl > 0) cache.put('tok_' + h, JSON.stringify(user), ttl);
  return user;
}

// ===== ユーザー（初回アクセスで自動登録・管理者判定） =====
function touchUser_(user) {
  const today = today_();
  // まずはキャッシュから探す（名前の変更や今日初めてのアクセスがなければ、シートは開かない）
  const found = readRowsCached_('users').find(r => str_(r.v[0]) === user.userId);
  if (found) {
    const rename = cellText_(found.v[1]) !== user.name;
    const firstToday = str_(found.v[2]).slice(0, 10) !== today;
    if (rename || firstToday) {
      // 書き込むときは行番号がずれないよう、シートから読み直す
      const fresh = readRows_('users').find(r => str_(r.v[0]) === user.userId);
      if (fresh) {
        const sh = sheet_('users');
        if (rename) sh.getRange(fresh.row, 2).setValue(safeCell_(user.name));
        if (firstToday) sh.getRange(fresh.row, 3).setValue(now_());
        invalidate_('users');
      }
    }
    const isAdmin = isTrue_(found.v[3]);
    return { isAdmin, isMember: isAdmin || str_(found.v[4]) === MEMBER, isNew: false };
  }
  const sh = sheet_('users');
  // 初めての人はゲストとして登録（管理者がメンバーに切り替える）
  let created = false;
  withLock_(() => {
    if (readRows_('users').some(r => str_(r.v[0]) === user.userId)) return;
    appendRows_('users', [[user.userId, safeCell_(user.name), now_()]]);
    const row = sh.getLastRow();
    sh.getRange(row, 4).insertCheckboxes();
    sh.getRange(row, 5).setValue(GUEST);
    created = true;
  });
  invalidate_('users');
  return { isAdmin: false, isMember: false, isNew: created };
}

// ===== 設定（参加費） =====
function readSettings_() {
  const m = {};
  readRowsCached_('settings').forEach(({ v }) => { m[str_(v[0])] = str_(v[1]); });
  const num = (k, d) => { const n = parseInt(m[k], 10); return isNaN(n) ? d : clamp_(n, 0, LIMITS.fee); };
  return {
    morningFee: num('朝の参加費', 300),
    nightFee: num('ナイター参加費', 500),
    nightStart: fmtTime_(m['ナイター開始']) || '17:00',
  };
}

function defaultFee_(start, st) {
  return start && start >= st.nightStart ? st.nightFee : st.morningFee;
}

// 空欄なら開始時刻から自動、数値ならその金額
function parseFee_(v, start, st) {
  const s = str_(v);
  if (s === '') return defaultFee_(start, st);
  const n = parseInt(s, 10);
  return isNaN(n) ? defaultFee_(start, st) : clamp_(n, 0, LIMITS.fee);
}

// ===== 一覧 =====
function listEvents_(userId, settings, isMember) {
  const today = today_();
  const people = {};
  readRowsCached_('users').forEach(r => {
    people[str_(r.v[0])] = { name: cellText_(r.v[1]), guest: !isTrue_(r.v[3]) && str_(r.v[4]) !== MEMBER };
  });

  // メンバーは全日程、ゲストは「ゲスト公開」の日だけ
  const events = readRowsCached_('events')
    .map(({ v }) => ({ id: str_(v[0]), date: fmtDate_(v[1]), place: cellText_(v[2]), note: cellText_(v[3]), guestOpen: isTrue_(v[5]) }))
    .filter(ev => ev.id && ev.date && ev.date >= today && (isMember || ev.guestOpen))
    .sort((a, b) => a.date.localeCompare(b.date));

  const slots = readRowsCached_('slots').map(({ v }) => {
    const start = fmtTime_(v[2]);
    return {
      id: str_(v[0]), eventId: str_(v[1]), start, end: fmtTime_(v[3]),
      capacity: clamp_(parseInt(v[4], 10) || 0, 0, LIMITS.capacity),
      fee: parseFee_(v[5], start, settings),
    };
  });

  const entries = readRowsCached_('entries').map(({ v }) => {
    const p = people[str_(v[1])];
    return {
      slotId: str_(v[0]), userId: str_(v[1]), name: (p && p.name) || cellText_(v[2]), guest: !!(p && p.guest),
      status: str_(v[3]), comment: cellText_(v[4]), updatedAt: str_(v[5]),
    };
  }).filter(x => STATUSES.includes(x.status));

  events.forEach(ev => {
    ev.slots = slots
      .filter(s => s.eventId === ev.id)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(s => {
        const es = entries.filter(x => x.slotId === s.id)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)); // 回答が早い順
        const mine = es.find(x => x.userId === userId);
        return {
          id: s.id, start: s.start, end: s.end, capacity: s.capacity, fee: s.fee,
          // userId は画面に返さない
          entries: es.map(x => ({ name: x.name, status: x.status, comment: x.comment, me: x.userId === userId, guest: x.guest })),
          myStatus: mine ? mine.status : '',
          myComment: mine ? mine.comment : '',
        };
      });
  });
  return events;
}

// ===== 出欠の登録・変更・取消 =====
function saveEntry_(user, req, isMember) {
  const slotId = str_(req.slotId);
  const status = str_(req.status); // '○' '△' '×'、空文字は取消
  if (status && !STATUSES.includes(status)) throw appErr_('bad_request', '出欠の値が不正です');
  const comment = str_(req.comment).slice(0, LIMITS.comment);

  const slot = readRows_('slots').find(r => str_(r.v[0]) === slotId);
  if (!slot) throw appErr_('not_found', 'この時間枠は見つかりません（削除された可能性があります）');
  const ev = readRows_('events').find(r => str_(r.v[0]) === str_(slot.v[1]));
  if (!ev || fmtDate_(ev.v[1]) < today_()) throw appErr_('closed', 'この練習日は受付を終了しています');
  if (!isMember && !isTrue_(ev.v[5])) throw appErr_('forbidden', 'この練習日はメンバー限定です');

  const rows = readRows_('entries');
  const mine = rows.find(r => str_(r.v[0]) === slotId && str_(r.v[1]) === user.userId);

  if (status === '○') {
    const cap = clamp_(parseInt(slot.v[4], 10) || 0, 0, LIMITS.capacity);
    if (cap > 0) {
      const others = rows.filter(r => str_(r.v[0]) === slotId && str_(r.v[3]) === '○' && str_(r.v[1]) !== user.userId).length;
      if (others >= cap) throw appErr_('full', 'この時間帯は定員に達しています');
    }
  }

  const sh = sheet_('entries');
  if (!status) {
    if (mine) sh.deleteRow(mine.row);
    invalidate_('entries');
    return;
  }
  const values = [[slotId, user.userId, safeCell_(user.name), status, safeCell_(comment), now_()]];
  if (mine) {
    sh.getRange(mine.row, 1, 1, values[0].length).setNumberFormat('@').setValues(values);
  } else {
    appendRows_('entries', values);
  }
  invalidate_('entries');
}

// ===== 管理者：複数開催日の一括登録 =====
function createEvents_(req) {
  const st = readSettings_();
  const rawDates = Array.isArray(req.dates) ? req.dates : [];
  const rawSlots = Array.isArray(req.slots) ? req.slots : [];
  if (rawDates.length > LIMITS.dates) throw appErr_('bad_request', '一度に登録できるのは' + LIMITS.dates + '日までです');
  if (rawSlots.length > LIMITS.slots) throw appErr_('bad_request', '時間枠は' + LIMITS.slots + '個までです');
  const dates = [...new Set(rawDates.map(fmtDate_))].filter(Boolean).sort();
  const slots = rawSlots.map(s => {
    const start = fmtTime_(s && s.start);
    return {
      start, end: fmtTime_(s && s.end),
      capacity: clamp_(parseInt(s && s.capacity, 10) || 0, 0, LIMITS.capacity),
      fee: parseFee_(s && s.fee, start, st),
    };
  });
  if (!dates.length) throw appErr_('bad_request', '開催日を1つ以上選んでください');
  if (!slots.length) throw appErr_('bad_request', '時間枠を1つ以上入力してください');
  if (slots.some(s => !s.start || !s.end || s.start >= s.end)) {
    throw appErr_('bad_request', '時間枠の開始・終了時刻を確認してください');
  }
  if (dates[0] < today_()) throw appErr_('bad_request', '過去の日付は登録できません');

  const place = safeCell_(str_(req.place).slice(0, LIMITS.place));
  const note = safeCell_(str_(req.note).slice(0, LIMITS.note));
  const ts = now_();
  const evRows = [];
  const slRows = [];
  dates.forEach(d => {
    const eventId = newId_('ev');
    evRows.push([eventId, d, place, note, ts]);
    slots.forEach(s => slRows.push([newId_('sl'), eventId, s.start, s.end, s.capacity, s.fee]));
  });
  const evSh = sheet_('events');
  const first = evSh.getLastRow() + 1;
  appendRows_('events', evRows);
  const guestCells = evSh.getRange(first, 6, evRows.length, 1);
  guestCells.insertCheckboxes();
  if (req.guestOpen === true) guestCells.setValue(true);
  appendRows_('slots', slRows);
  invalidate_('events', 'slots');
}

// ===== 管理者：ゲスト公開の切り替え =====
function setGuestOpen_(eventId, open) {
  const row = readRows_('events').find(r => str_(r.v[0]) === eventId);
  if (!row) throw appErr_('not_found', 'この練習日は見つかりません（削除された可能性があります）');
  const cell = sheet_('events').getRange(row.row, 6);
  if (!cell.getDataValidation()) cell.insertCheckboxes();
  cell.setValue(open);
  invalidate_('events');
}

// ===== 管理者：開催日の削除（時間枠・回答もまとめて） =====
function deleteEvent_(eventId) {
  if (!eventId) throw appErr_('bad_request', '削除する練習日が指定されていません');
  const slotIds = readRows_('slots').filter(r => str_(r.v[1]) === eventId).map(r => str_(r.v[0]));
  deleteRowsWhere_('entries', r => slotIds.includes(str_(r.v[0])));
  deleteRowsWhere_('slots', r => str_(r.v[1]) === eventId);
  deleteRowsWhere_('events', r => str_(r.v[0]) === eventId);
  invalidate_('entries', 'slots', 'events');
}

// ===== 監視：操作ログ =====
// 書き込み操作・初回アクセス・失敗（認証失敗や権限のない操作）を「操作ログ」シートに残す。閲覧だけのアクセスは残さない
function audit_(req, user, res) {
  try {
    const action = str_(req && req.action).slice(0, 30) || '-';
    const failed = !res.ok;
    const isNew = !!(user && user.isNew);
    if (action === 'list' && !failed && !isNew) return;
    const cache = CacheService.getScriptCache();
    if (failed && res.error === 'auth') {
      // 認証失敗の記録は1分あたり20件まで（大量アクセスでシートが埋まらないように）
      const k = 'authlog_' + Math.floor(Date.now() / 60000);
      const n = Number(cache.get(k) || 0);
      cache.put(k, String(n + 1), 120);
      if (n >= 20) return;
    }
    const target = str_(req.slotId || req.eventId || (Array.isArray(req.dates) ? req.dates.length + '日分' : '')).slice(0, 60);
    let detail = '';
    if (failed) detail = str_(res.message).slice(0, 100);
    else if (isNew) detail = '初回アクセス';
    else if (action === 'entry') detail = str_(req.status) || '取消';
    else if (action === 'setGuestOpen') detail = req.open === true ? 'ゲスト公開' : 'メンバー限定';
    sheet_('logs').appendRow([
      now_(), user ? user.userId : '-', user ? safeCell_(user.name) : '-', user ? (user.kind || '-') : '-',
      action, target, failed ? res.error : 'ok', safeCell_(detail),
    ]);
    if (failed && res.error === 'forbidden') {
      alert_('forbidden', '権限のない操作がありました',
        (user ? user.name + '（' + (user.kind || '-') + '）' : '不明なユーザー') + ' が「' + action + '」を実行しようとして拒否されました。\n' +
        '操作ログシートで詳細を確認してください。');
    }
  } catch (err) {
    console.error(err);
  }
}

// ===== 監視：通知メール =====
// 同じ種類の通知は1時間に1回まで
function alert_(key, subject, body) {
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get('alert_' + key)) return;
    cache.put('alert_' + key, '1', 3600);
    MailApp.sendEmail(reportTo_(), '[PUG出欠] ' + subject, body + '\n\nスプレッドシート: https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID);
  } catch (err) {
    console.error(err);
  }
}

function reportTo_() {
  return REPORT_TO || Session.getEffectiveUser().getEmail();
}

// ===== 監視：日次レポート（毎朝8時台に自動実行） =====
function dailyReport() {
  const since = Date.now() - 86400000;
  const recent = readRows_('logs').filter(r => logTime_(r.v[0]) >= since);
  const ok = recent.filter(r => str_(r.v[6]) === 'ok');
  const failed = recent.filter(r => str_(r.v[6]) !== 'ok');
  const countBy = (rows, idx) => {
    const m = {};
    rows.forEach(r => { const k = str_(r.v[idx]); m[k] = (m[k] || 0) + 1; });
    return Object.keys(m).map(k => '  ' + k + '：' + m[k] + '件').join('\n') || '  なし';
  };
  const forbidden = failed.filter(r => str_(r.v[6]) === 'forbidden');
  const authFails = failed.filter(r => str_(r.v[6]) === 'auth').length;
  const newUsers = recent.filter(r => str_(r.v[7]) === '初回アクセス').map(r => '  ' + cellText_(r.v[2]));

  const users = readRows_('users');
  const admins = users.filter(r => isTrue_(r.v[3])).map(r => cellText_(r.v[1]));
  const members = users.filter(r => !isTrue_(r.v[3]) && str_(r.v[4]) === MEMBER).length;
  const guests = users.filter(r => !isTrue_(r.v[3]) && str_(r.v[4]) !== MEMBER).length;

  // 管理者の顔ぶれが前回から変わったか
  const props = PropertiesService.getScriptProperties();
  const prev = (props.getProperty('admins') || '').split('\n').filter(Boolean);
  const added = admins.filter(a => !prev.includes(a));
  const removed = prev.filter(a => !admins.includes(a));
  props.setProperty('admins', admins.join('\n'));
  const adminChanged = prev.length > 0 && (added.length > 0 || removed.length > 0);

  const warn = forbidden.length > 0 || authFails >= 20 || adminChanged;
  const lines = [
    'PUG 練習出欠 日次レポート（直近24時間）',
    '',
    '■ 成功した操作',
    countBy(ok, 4),
    '■ 失敗した操作（結果コード別）',
    countBy(failed, 6),
    '■ 権限のない操作：' + forbidden.length + '件',
    forbidden.map(r => '  ' + str_(r.v[0]) + ' ' + cellText_(r.v[2]) + '（' + str_(r.v[3]) + '）' + str_(r.v[4])).join('\n'),
    '■ 認証失敗：' + authFails + '件' + (authFails >= 20 ? '（多いので要確認）' : ''),
    '■ 新しく来た人：' + newUsers.length + '人（ゲストとして登録。メンバーなら区分を切り替えてください）',
    newUsers.join('\n'),
    '■ 管理者：' + admins.join('、'),
    adminChanged ? '  ⚠ 変更あり　追加：' + (added.join('、') || 'なし') + '／削除：' + (removed.join('、') || 'なし') : '',
    '■ ユーザー数：管理者 ' + admins.length + '人／メンバー ' + members + '人／ゲスト ' + guests + '人',
    '',
    'スプレッドシート: https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID,
  ].filter(l => l !== '');
  MailApp.sendEmail(reportTo_(), '[PUG出欠] 日次レポート ' + today_() + (warn ? ' ⚠要確認' : ''), lines.join('\n'));
  pruneLogs_();
}

// 保存期間を過ぎた操作ログを消す（ログは古い順に並んでいる）
function pruneLogs_() {
  const limit = Date.now() - LOG_KEEP_DAYS * 86400000;
  const rows = readRows_('logs');
  let n = 0;
  while (n < rows.length && logTime_(rows[n].v[0]) < limit) n++;
  if (n > 0) sheet_('logs').deleteRows(2, n);
}

function logTime_(v) {
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(str_(v).replace(' ', 'T') + '+09:00');
  return isNaN(t) ? 0 : t;
}

// 監視の自動実行を設定する（一度だけ実行。メール送信とトリガーの権限承認が必要）
function installTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['dailyReport', 'onSheetEdit'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(8).inTimezone(TZ).create();
  // スプレッドシートを手で編集したら、読み込みキャッシュをすぐ捨てる（ゲスト→メンバーの切り替えなどを即反映）
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(SPREADSHEET_ID).onEdit().create();
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(SPREADSHEET_ID).onChange().create();
  MailApp.sendEmail(reportTo_(), '[PUG出欠] 監視の設定が完了しました',
    '毎朝8時台に日次レポートが届きます。権限のない操作やログイン失敗の急増があれば、その都度お知らせします。\n' +
    'スプレッドシートを手で編集したときは、アプリの表示にすぐ反映されます。');
}

// スプレッドシートの手動編集（値の変更・行の追加削除）で呼ばれる。キャッシュを捨てるだけで、データには触らない
function onSheetEdit() {
  invalidate_.apply(null, CACHED_SHEETS);
}

// ===== シート操作ヘルパー =====
function sheet_(key) {
  const sh = ss_().getSheetByName(SHEETS[key].name);
  if (!sh) throw appErr_('setup', 'シートがありません。setup() を実行してください');
  return sh;
}

function readRows_(key) {
  const sh = sheet_(key);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, SHEETS[key].headers.length).getValues()
    .map((v, i) => ({ row: i + 2, v }))
    .filter(r => str_(r.v[0]) !== '');
}

// ===== 読み込みキャッシュ（開くたびにシートを読み直さない） =====
// 一覧の表示に使うシートを最大 READ_CACHE_SEC 秒だけ Apps Script のキャッシュに置く。
// 書き込んだシートはその場でキャッシュを捨てる（世代番号を進める）ので、自分の操作はすぐ反映される。
// スプレッドシートを手で直接編集した場合（ゲスト→メンバーの切り替えなど）は、最大 READ_CACHE_SEC 秒で反映される。
// 書き込み処理（行番号が必要なもの）は、必ず readRows_ でシートから読み直す。
const READ_CACHE_SEC = 60;
const CACHED_SHEETS = ['events', 'slots', 'entries', 'users', 'settings'];
const CACHE_MAX_BYTES = 95000; // CacheService の1件あたりの上限（100KB）未満

function readRowsCached_(key) {
  const cache = CacheService.getScriptCache();
  const gen = cache.get('gen_' + key) || '0';
  const hit = cache.get('rows_' + key);
  if (hit) {
    try {
      const x = JSON.parse(hit);
      if (x.gen === gen) return x.rows.map(r => ({ row: r.row, v: r.v.map(reviveCell_) }));
    } catch (_) { /* 壊れていたら読み直す */ }
  }
  const rows = readRows_(key);
  try {
    const json = JSON.stringify({ gen, rows: rows.map(r => ({ row: r.row, v: r.v.map(packCell_) })) });
    if (Utilities.newBlob(json).getBytes().length < CACHE_MAX_BYTES) cache.put('rows_' + key, json, READ_CACHE_SEC);
  } catch (_) { /* キャッシュできなくても動作は同じ */ }
  return rows;
}

// 書き込んだシートのキャッシュを無効にする。読み込み途中だった別の処理が古い内容を置いても、世代が違うので使われない
function invalidate_() {
  const keys = Array.prototype.slice.call(arguments);
  try {
    const cache = CacheService.getScriptCache();
    const gen = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const put = {};
    keys.forEach(k => { put['gen_' + k] = gen; });
    cache.putAll(put, 21600);
    cache.removeAll(keys.map(k => 'rows_' + k));
  } catch (err) {
    console.error(err);
  }
}

// 日付型のセルはそのまま JSON にできないので、時刻の数値に包んで保存し、読み出し時に Date に戻す
function packCell_(c) { return c instanceof Date ? { $d: c.getTime() } : c; }
function reviveCell_(c) { return c && typeof c === 'object' && '$d' in c ? new Date(c.$d) : c; }

function appendRows_(key, rows) {
  if (!rows.length) return;
  const sh = sheet_(key);
  const start = sh.getLastRow() + 1;
  const lack = start + rows.length - 1 - sh.getMaxRows();
  if (lack > 0) sh.insertRowsAfter(sh.getMaxRows(), lack);
  sh.getRange(start, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
}

function deleteRowsWhere_(key, pred) {
  const sh = sheet_(key);
  readRows_(key).filter(pred).map(r => r.row).sort((a, b) => b - a).forEach(row => sh.deleteRow(row));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw appErr_('busy', '混み合っています。少し待ってからもう一度お試しください');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ===== 小物 =====
function appErr_(code, message) { const e = new Error(message); e.code = code; return e; }
function str_(v) { return v == null ? '' : String(v).trim(); }
function isTrue_(v) { return v === true || str_(v).toUpperCase() === 'TRUE'; }
function clamp_(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function newId_(prefix) { return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }

// 利用者が入力した文字をシートに書くとき、数式として動かないよう先頭に ' を付ける（数式インジェクション対策）
function safeCell_(v) {
  const s = str_(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
// シートから読むとき、上の ' が文字として残っていた場合に取り除く
function cellText_(v) {
  return str_(v).replace(/^'(?=[=+\-@])/, '');
}

// 手入力（2026/11/8 など）やシートの日付型にも対応して yyyy-MM-dd に揃える
function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const m = str_(v).match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : '';
}

// 9:00 などを HH:mm に揃える
function fmtTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  const m = str_(v).match(/^(\d{1,2}):(\d{2})/);
  return m && Number(m[1]) < 24 ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}
