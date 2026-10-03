// ─────────────────────────────────────────────────────────
// 友だち名簿（2026-10-04 新設／仕様カード projects/line_list/仕様カード_2026-10-04.md）
//
// 【目的】いつ・誰が・どの入口（合言葉）から友だちになり、今も残っているか（ブロックしていないか）を残す。
//
// 【保存方式】stepDelivery.js・zumenSession.js と同じ。
//   RAILWAY_VOLUME_MOUNT_PATH（または STEP_DATA_DIR）に friends.json を原子的に保存する（tmp→rename）。
//   どちらも未設定なら persistent=false のままメモリだけで動く（再起動で消える。/health で確認できる）。
//
// 【絶対条件】
//   ・このモジュールの公開関数は例外を外に投げない（名簿の失敗が利用者への返信を巻き込まない）。
//   ・表示名・userId を console.log / pushLog に出さない（個人情報）。ログには件数と理由だけ。
//   ・名簿ファイルはGitに入れない（保存先はボリューム。.gitignore にも friends*.json を入れてある）。
//
// 【LINEの制約】未認証アカウントでは「過去の友だち一覧」をAPIで取れない。
//   既存の友だち（このモジュールの導入前に追加された人）は、次にメッセージを送ってきた時点で
//   followedAt=null（＝不明）として名簿に入る。
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

function dataDir() {
  return process.env.STEP_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
}

// 形: { version, friends: { [userId]: {
//   displayName, followedAt, lastFollowedAt, firstSeenAt, entry, entryAt,
//   lastMessageAt, blockedAt, lastBlockedAt, refollowCount, messageCount } } }
const store = { version: 1, friends: {} };

let storeFile = '';
let persistent = false;
let persistReason = 'not_initialized';

function loadStore() {
  const dir = dataDir();
  if (!dir) {
    persistent = false;
    persistReason = 'no_volume_configured';
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    storeFile = path.join(dir, 'friends.json');
    if (fs.existsSync(storeFile)) {
      const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      if (parsed && parsed.friends && typeof parsed.friends === 'object') {
        store.friends = parsed.friends;
      }
    }
    if (!saveStore()) {
      persistent = false;
      persistReason = 'write_probe_failed';
      return;
    }
    persistent = true;
    persistReason = 'ok';
  } catch (e) {
    persistent = false;
    persistReason = 'io_error';
    console.error('[FRIENDS] 名簿の読み込みに失敗:', e && e.message);
  }
}

function saveStore() {
  if (!storeFile) return false;
  try {
    const tmp = storeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, storeFile);
    return true;
  } catch (e) {
    console.error('[FRIENDS] 名簿の保存に失敗:', e && e.message);
    persistent = false;
    persistReason = 'save_failed';
    return false;
  }
}

function init() {
  try {
    loadStore();
  } catch (e) {
    persistent = false;
    persistReason = 'init_error';
  }
  console.log('[FRIENDS] 名簿の永続化:', persistent, '理由:', persistReason);
  if (!persistent) {
    console.warn(
      '[FRIENDS][警告] 永続化なし。友だち名簿が再起動で消えます。' +
        'Railwayでボリュームを追加するか、STEP_DATA_DIR を設定してください。'
    );
  }
}

// ── 入口（最初に一致した合言葉）の判定 ─────────────────────
// 🔴 rules/keywords_master.md の確定表と、index.js の getReply() の判定順に合わせた表。
//    上から順に最初に一致したものを採る（getReply の分岐順と同じ。例：「快眠」と「相談」が
//    同じ文にあれば、getReply が快眠を返すので入口も快眠）。
//    ・休眠中の「ミネラル」「空き家」は入れない（Bot側で無効化済み＝合言葉として機能しない）。
//    ・マイID（オーナー用の診断）、ステップ配信の返信語（実家の話／本の話／出版の話）は入口ではない。
//    ・合言葉に当たらない一般の文は null（入口は未確定のまま。次に合言葉が来たら記録する）。
//    合言葉を増やしたら index.js と keywords_master.md と、この表の3点を揃えること。
const ENTRY_RULES = [
  { label: '図面', test: (t) => /図面|ずめん|ズメン/.test(t) },
  { label: '副業本', test: (t) => t.includes('副業') },
  { label: 'インスタ', test: (t) => /インスタ|instagram|Instagram/.test(t) },
  { label: 'note', test: (t) => t.includes('note') || t.includes('ノート') },
  { label: '香り', test: (t) => t.includes('香り') || t.includes('建材') },
  {
    label: '快眠',
    test: (t) =>
      t.includes('快眠') ||
      t.includes('アロマ本') ||
      ((t.includes('doTERRA') || t.includes('ドテラ')) && !/相談|そうだん|コンサル/.test(t)),
  },
  { label: '設計図', test: (t) => t.includes('設計図') || t.includes('テンプレート') },
  { label: '外壁修繕', test: (t) => /外壁|修繕|屋根/.test(t) },
  { label: '貧乏脳', test: (t) => /貧乏脳|金持ち脳|チェックリスト|口癖カード/.test(t) },
  { label: 'リフォーム本', test: (t) => /リフォーム本|見積書チェッカー|見積もりチェッカー|見積チェッカー|100万円/.test(t) },
  { label: '個別相談希望', test: (t) => t.includes('個別相談希望') || t.includes('リフォーム相談') },
  { label: '相談希望', test: (t) => t.includes('相談希望') || t.includes('そうだん希望') },
  { label: '相談', test: (t) => t.includes('相談') || t.includes('コンサル') || t.includes('個別') },
  { label: '点検表', test: (t) => /点検表|てんけん表|点検ひょう|テンケン表|てんけんひょう/.test(t) },
  { label: '体の点検', test: (t) => /体の点検|からだの点検|カラダの点検|体のてんけん/.test(t) },
  { label: 'AI社長', test: (t) => /AI社長|ＡＩ社長|AIシャチョウ|ＡＩシャチョウ|エーアイ社長/.test(t) },
  { label: '箱舟', test: (t) => /箱舟|はこぶね|ハコブネ|方舟/.test(t) },
  { label: '名刺', test: (t) => /名刺|舞台裏|本づくり|本作り/.test(t) },
];

function detectEntry(text) {
  if (typeof text !== 'string' || !text) return null;
  if (/マイID|マイid|マイＩＤ|マイＩｄ/.test(text)) return null; // オーナー用の診断
  for (const r of ENTRY_RULES) {
    if (r.test(text)) return r.label;
  }
  return null;
}

// ── 記録 ────────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString();
}

function newRecord(now) {
  return {
    displayName: null,
    followedAt: null, // 最初に友だちになった日時。null＝不明（導入前から友だち）
    lastFollowedAt: null,
    firstSeenAt: now, // 名簿に初めて載った日時
    entry: null, // 最初に一致した合言葉（以後は上書きしない）
    entryAt: null,
    lastMessageAt: null,
    blockedAt: null, // 今ブロック／削除されている場合のみ値あり
    lastBlockedAt: null,
    refollowCount: 0,
    messageCount: 0,
  };
}

function getOrCreate(userId, now) {
  if (!store.friends[userId]) store.friends[userId] = newRecord(now);
  return store.friends[userId];
}

// follow イベント。戻り値 { isNew, isRefollow, refollowCount }（通知文の出し分け用）。失敗時は null。
function recordFollow(userId) {
  try {
    if (!userId) return null;
    const now = nowIso();
    const existed = !!store.friends[userId];
    const rec = getOrCreate(userId, now);
    let isRefollow = false;
    if (existed) {
      // 既に名簿にいる人にもう一度 follow が来た＝ブロック解除、または削除後の再追加
      isRefollow = true;
      rec.refollowCount += 1;
    } else {
      rec.followedAt = now;
    }
    rec.lastFollowedAt = now;
    rec.blockedAt = null;
    saveStore();
    return { isNew: !existed, isRefollow, refollowCount: rec.refollowCount };
  } catch (e) {
    console.error('[FRIENDS] recordFollow 失敗:', e && e.message);
    return null;
  }
}

// follow の返信後に取得した表示名を入れる
function setDisplayName(userId, displayName) {
  try {
    if (!userId || !displayName || typeof displayName !== 'string') return;
    const rec = store.friends[userId];
    if (!rec) return;
    if (rec.displayName !== displayName) {
      rec.displayName = displayName;
      saveStore();
    }
  } catch (e) {
    console.error('[FRIENDS] setDisplayName 失敗:', e && e.message);
  }
}

// unfollow（ブロック・友だち削除）
function recordUnfollow(userId) {
  try {
    if (!userId) return;
    const now = nowIso();
    const rec = getOrCreate(userId, now); // follow記録がない人でもブロックされた事実は残す
    rec.blockedAt = now;
    rec.lastBlockedAt = now;
    saveStore();
  } catch (e) {
    console.error('[FRIENDS] recordUnfollow 失敗:', e && e.message);
  }
}

// message イベント（テキスト・画像・ファイル）。opts: { displayName?, text? }
// follow記録がない人は followedAt=null（不明）のまま名簿に入る。
function recordMessage(userId, opts = {}) {
  try {
    if (!userId) return;
    const now = nowIso();
    const rec = getOrCreate(userId, now);
    rec.lastMessageAt = now;
    rec.messageCount += 1;
    rec.blockedAt = null; // メッセージが届く＝友だちでいる
    if (opts.displayName && typeof opts.displayName === 'string') rec.displayName = opts.displayName;
    if (!rec.entry) {
      const entry = detectEntry(opts.text);
      if (entry) {
        rec.entry = entry;
        rec.entryAt = now;
      }
    }
    saveStore();
  } catch (e) {
    console.error('[FRIENDS] recordMessage 失敗:', e && e.message);
  }
}

// ── 閲覧（HTML・CSV）──────────────────────────────────
function toJst(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const j = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}`;
}

// 一覧（新しく名簿に載った順）。ownerId を渡すとオーナー本人に印を付ける。
function listRows(ownerId) {
  return Object.entries(store.friends)
    .sort((a, b) => String(b[1].firstSeenAt).localeCompare(String(a[1].firstSeenAt)))
    .map(([userId, r]) => ({
      userId,
      isOwner: !!ownerId && userId === ownerId,
      displayName: r.displayName || '（表示名を取得できていません）',
      status: r.blockedAt ? 'ブロック・削除' : '友だち',
      followedAt: r.followedAt ? toJst(r.followedAt) : '不明',
      entry: r.entry || '（まだ合言葉なし）',
      entryAt: toJst(r.entryAt),
      lastMessageAt: toJst(r.lastMessageAt),
      blockedAt: toJst(r.blockedAt || ''),
      lastBlockedAt: toJst(r.lastBlockedAt || ''),
      refollowCount: r.refollowCount || 0,
      messageCount: r.messageCount || 0,
    }));
}

const CSV_HEADER = [
  '表示名', '状態', '友だちになった日時', '入口（最初の合言葉）', '入口の日時',
  '最後のメッセージ日時', 'ブロック・削除の日時', '再追加回数', 'メッセージ数', '区分', 'userId',
];

function csvCell(v) {
  let s = String(v === undefined || v === null ? '' : v);
  // 表示名は他人が決めた文字列。Excelで式として実行されないよう先頭の記号を無効化する。
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(ownerId) {
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const r of listRows(ownerId)) {
    lines.push(
      [
        r.displayName, r.status, r.followedAt, r.entry, r.entryAt, r.lastMessageAt,
        r.blockedAt, r.refollowCount, r.messageCount, r.isOwner ? 'オーナー' : '', r.userId,
      ].map(csvCell).join(',')
    );
  }
  return '﻿' + lines.join('\r\n') + '\r\n'; // UTF-8 BOM付き（Excelで文字化けしない）
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toHtml(ownerId, csvHref) {
  const rows = listRows(ownerId);
  const total = rows.length;
  const active = rows.filter((r) => r.status === '友だち').length;
  const body = rows
    .map(
      (r) =>
        `<tr${r.status !== '友だち' ? ' class="gone"' : ''}>` +
        [
          r.displayName + (r.isOwner ? '（オーナー）' : ''), r.status, r.followedAt, r.entry,
          r.lastMessageAt, r.blockedAt || r.lastBlockedAt, r.refollowCount,
        ]
          .map((c) => `<td>${escapeHtml(c)}</td>`)
          .join('') +
        '</tr>'
    )
    .join('\n');
  return (
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow"><title>友だち名簿</title>' +
    '<style>body{font-family:sans-serif;margin:16px;font-size:18px}table{border-collapse:collapse;width:100%}' +
    'th,td{border:1px solid #999;padding:6px 8px;text-align:left}th{background:#12263f;color:#fff}' +
    'tr.gone td{background:#eee;color:#666}</style></head><body>' +
    '<h1>LINE友だち名簿</h1>' +
    `<p>名簿 ${total} 人（うち今も友だち ${active} 人）／永続化：${persistent ? 'あり' : '<b>なし（再起動で消えます）</b>'}</p>` +
    `<p><a href="${escapeHtml(csvHref)}">CSVをダウンロード（Excel用）</a></p>` +
    '<table><thead><tr><th>表示名</th><th>状態</th><th>友だちになった日時</th><th>入口（最初の合言葉）</th>' +
    '<th>最後のメッセージ</th><th>ブロック・削除</th><th>再追加回数</th></tr></thead><tbody>\n' +
    body +
    '\n</tbody></table>' +
    '<p>「友だちになった日時＝不明」は、名簿の導入前から友だちだった人です（LINEの仕様で過去の一覧は取れません）。</p>' +
    '</body></html>'
  );
}

// 状態確認用（個人情報は返さない。件数だけ）
function getStatus() {
  const all = Object.values(store.friends);
  return {
    persistent,
    persistReason,
    storeFileConfigured: !!storeFile,
    friendsTotal: all.length,
    friendsActive: all.filter((r) => !r.blockedAt).length,
  };
}

function isPersistent() {
  return persistent;
}

// ── テスト用（本番コードからは呼ばれない）────────────────
function _resetForTest() {
  store.friends = {};
  storeFile = '';
  persistent = false;
  persistReason = 'not_initialized';
}
function _getRecordForTest(userId) {
  return store.friends[userId] ? { ...store.friends[userId] } : null;
}

module.exports = {
  init, detectEntry, recordFollow, setDisplayName, recordUnfollow, recordMessage,
  listRows, toCsv, toHtml, getStatus, isPersistent, _resetForTest, _getRecordForTest,
};
