// ─────────────────────────────────────────────────────────
// 『マンガ図面の向こう側』無料相談セッションの永続化（2026-09-30 新設）
//
// 【背景・監査室指摘】
//   合言葉「図面」を送った読者が、続けて別の文章（例：「築40年で屋根と外壁が心配です」）を
//   送ると、その文章の中の単語（屋根・外壁等）に他の合言葉分岐が反応してしまい、
//   ①別の案内（外壁修繕アプリ・¥20,000のリフォーム個別相談・doTERRAを含む相談メニュー等）が
//   返ってしまう ②いずれのケースもオーナーに通知が飛ばない、という2つの不具合があった。
//   これを防ぐには「この読者は今、無料相談の続きを話している」という状態を覚えておく必要がある。
//
// 【なぜ stepDelivery.js と同じ方式にしたか】
//   Railwayはプロセスの再起動・再デプロイでメモリ上の状態を必ず失う。
//   stepDelivery.js は既にこの問題に対処済みで、RAILWAY_VOLUME_MOUNT_PATH（Railwayの
//   永続ボリューム）に JSON ファイルを原子的に書く方式（tmpファイル→rename）を使っている。
//   このモジュールも同じ方式・同じディレクトリ解決ロジックを流用する（ファイル名だけ別にする）。
//
// 【永続化できない場合の挙動（既知の限界）】
//   RAILWAY_VOLUME_MOUNT_PATH（または STEP_DATA_DIR）が未設定の環境では、このモジュールは
//   persistent=false のまま、プロセスのメモリ上だけでセッションを覚える。
//   プロセスが再起動すると、進行中の無料相談セッションは失われ、次にその読者が「図面」以外の
//   文章を送ると、また他の合言葉分岐に取られる可能性がある（＝今回の不具合が再発する）。
//   ただし、進行中セッションが失われても、有料相談（¥20,000）・doTERRAへ実際に接続される
//   ことそのものは、合言葉の判定順序自体（相談系・doTERRA系は"完全一致の抜け出し許可リスト"に
//   含めていない設計）とは無関係に、他の既存の合言葉ロジックの範囲内でしか起こらない
//   （＝新たに危険な接続が生まれるわけではない。元々あった通知漏れの問題が、セッションが
//   失われた場合にだけ限定的に再発する、という整理）。
//   🔴 本番でRAILWAY_VOLUME_MOUNT_PATHが設定されているかは、/debug/step の persistent と同じ
//      考え方で /health 等から確認できるようにしている（zumenSession.getStatus()）。
//      設定されていなければ、ボリュームの追加をオーナーに依頼すること。
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

function dataDir() {
  return process.env.STEP_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
}

// 形: { version, sessions: { [userId]: { startedAt, active, endedAt? } } }
const store = {
  version: 1,
  sessions: {},
};

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
    storeFile = path.join(dir, 'zumen_sessions.json');
    if (fs.existsSync(storeFile)) {
      const raw = fs.readFileSync(storeFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.sessions) {
        store.sessions = parsed.sessions;
      }
    }
    // 書き込みできることを実際に確かめる（stepDelivery.js と同じ考え方）。
    if (!saveStore()) {
      persistent = false;
      persistReason = 'write_probe_failed';
      return;
    }
    persistent = true;
    persistReason = 'ok';
  } catch (e) {
    persistent = false;
    persistReason = 'io_error:' + (e && e.message);
    console.error('[ZUMEN] ストアの読み書きに失敗:', e && e.message);
  }
}

function saveStore() {
  if (!storeFile) return false;
  try {
    const tmp = storeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, storeFile); // 原子的に置き換える
    return true;
  } catch (e) {
    console.error('[ZUMEN] ストアの保存に失敗:', e && e.message);
    persistent = false;
    persistReason = 'save_failed:' + (e && e.message);
    return false;
  }
}

// 🔴 2026-09-30 追加（CEO裁定B-1）：最後のメッセージから14日が過ぎたら自動で終了する。
// lastMessageAt が無い古いデータは startedAt を基準にする。
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14日

// now を引数で受け取れるようにする（テストで時間を差し替えられるようにするため）。
// 省略時は実際の現在時刻を使う（本番の挙動は変わらない）。
function isActive(userId, now = Date.now()) {
  if (!userId) return false;
  const s = store.sessions[userId];
  if (!s || !s.active) return false;
  const basis = s.lastMessageAt || s.startedAt;
  const elapsed = now - Date.parse(basis);
  if (!Number.isFinite(elapsed) || elapsed > SESSION_TTL_MS) {
    // 期限切れ：自動終了として記録する（次回以降の isActive 呼び出しを軽くするため）。
    s.active = false;
    s.endedAt = new Date(now).toISOString();
    s.endedReason = 'ttl_expired';
    saveStore();
    return false;
  }
  return true;
}

// 合言葉「図面」等を受けたとき（開始・再開を兼ねる）
function start(userId) {
  if (!userId) return;
  const prev = store.sessions[userId];
  const now = new Date().toISOString();
  store.sessions[userId] = {
    startedAt: (prev && prev.startedAt) || now,
    lastMessageAt: now,
    active: true,
  };
  saveStore();
}

// セッション継続中の後続メッセージを受けたときに呼ぶ（14日タイマーを更新するだけ。active/startedAtは変えない）
function touch(userId) {
  if (!userId) return;
  const s = store.sessions[userId];
  if (s && s.active) {
    s.lastMessageAt = new Date().toISOString();
    saveStore();
  }
}

// 完全一致の別合言葉で「抜け出し」たとき、または運用上リセットしたいときに呼ぶ
function end(userId) {
  if (!userId) return;
  const s = store.sessions[userId];
  if (s) {
    s.active = false;
    s.endedAt = new Date().toISOString();
    s.endedReason = s.endedReason || 'exit';
    saveStore();
  }
}

function isPersistent() {
  return persistent;
}

function init() {
  loadStore();
  console.log('[ZUMEN] セッション永続化:', persistent, '理由:', persistReason);
  if (!persistent) {
    console.warn(
      '[ZUMEN][警告] 永続化なし。無料相談セッションを永続化できていません。' +
        'プロセスが再起動すると進行中セッションが失われます。' +
        'Railwayでボリュームを追加するか、STEP_DATA_DIR を設定してください。'
    );
  }
}

// ── テスト用（2026-09-30追加）───────────────────────────
// 本番コードから呼ばれることはない。ローカル試験で「14日後」を再現するためだけの関数。
function _testSetLastMessageAt(userId, isoString) {
  const s = store.sessions[userId];
  if (s) s.lastMessageAt = isoString;
}

// デバッグ用の状態出力（ユーザーIDは伏せる。/debug/step と同じ考え方）
function getStatus() {
  const sessions = Object.values(store.sessions);
  return {
    persistent,
    persistReason,
    storeFileConfigured: !!storeFile,
    sessionsTotal: sessions.length,
    sessionsActive: sessions.filter((s) => s.active).length,
  };
}

module.exports = { init, isActive, start, touch, end, isPersistent, getStatus, _testSetLastMessageAt };
