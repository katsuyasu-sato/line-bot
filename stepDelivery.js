// ─────────────────────────────────────────────────────────
// ステップ配信モジュール（登録後 1日目 / 3日目 / 7日目）
//
// 【設計の前提（すべてLINE公式ドキュメントで確認済み）】
//  ・コミュニケーションプラン（旧フリープラン）の無料通数は月200通。
//    https://developers.line.biz/ja/docs/messaging-api/pricing/
//  ・通数は「1リクエスト × 宛先人数」で数える。1リクエストに最大5個のメッセージ
//    オブジェクトを載せても1通のまま（吹き出し3つ×5人＝15通ではなく5通）。
//    https://developers.line.biz/ja/tips/2026/05/28/how-to-count-messages/
//    → 各ステップは吹き出しを分けて読みやすくしてよい。分けても料金は変わらない。
//      ただし「日をまたぐ」と別リクエストになるので、ステップ数＝1人あたりの通数。
//  ・応答メッセージ（reply）は通数にカウントされない（無料・無制限）。
//    → 4通目以降は作らない。7日目で「言葉を送ってください」と返信誘導に切り替え、
//      以降のやり取りをすべて通数ゼロで回す。これが200通の枠を守る核心。
//  ・ブロック済みユーザーへの送信はカウントされない（実際に届いた分だけ課金対象）。
//  ・無料枠を超えるとエラーが返り、メッセージは送信されない（＝相談通知も落ちる）。
//    → 送信前に必ずLINEの残通数APIを見る。残りが予備枠を下回るときは送らない。
//
// 【安全装置】
//  ・STEP_DELIVERY_ENABLED が 'true' でない限り、絶対に送信しない（既定オフ）。
//  ・STEP_DELIVERY_DRY_RUN が 'false' でない限り、ログに出すだけで送信しない（既定ドライラン）。
//  ・登録日時を永続化できない環境では送信しない（再起動のたびに同じ人へ再送してしまうため）。
//
// 【このモジュールは index.js の既存動作を変更しない】
//  ・例外は必ず内部で握りつぶす。ステップ配信の失敗が webhook の返信を巻き込まないこと。
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// ── 設定（すべて環境変数。既定値は「送らない」側に倒す）──────────
function envBool(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return String(v).toLowerCase() === 'true';
}
function envInt(name, defaultValue) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : defaultValue;
}

const CONF = {
  // 🔴 本番で配信をオンにするための唯一のスイッチ。既定は false（オフ）。
  enabled: () => envBool('STEP_DELIVERY_ENABLED', false),
  // 🔴 既定は true（ドライラン＝送信せずログだけ）。false にして初めて実送信。
  dryRun: () => envBool('STEP_DELIVERY_DRY_RUN', true),
  // 永続ディレクトリ。Railwayでボリュームを付けると RAILWAY_VOLUME_MOUNT_PATH が自動で入る。
  dataDir: () => process.env.STEP_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '',
  // 永続化できないまま送ることを許すか（既定 false ＝ 許さない）。
  allowEphemeral: () => envBool('STEP_ALLOW_EPHEMERAL', false),
  // 送信する時刻（日本時間の「時」）。夜間・早朝に通知が鳴らないようにする。
  sendHourJST: () => envInt('STEP_SEND_HOUR_JST', 9),
  // 残通数がこの数を下回ったら送らない（相談通知など「絶対に落とせないpush」のための予備枠）。
  quotaReserve: () => envInt('STEP_QUOTA_RESERVE', 60),
  // 1回のtickで送る上限（暴走時の被害を限定する）。
  maxSendsPerTick: () => envInt('STEP_MAX_SENDS_PER_TICK', 50),
  // 配信予定日をこの日数以上すぎたステップは「もう送らない」ものとして飛ばす。
  // （長期停止からの復帰時に、過去分がまとめて飛ぶ事故を防ぐ）
  catchUpLimitDays: () => envInt('STEP_CATCHUP_LIMIT_DAYS', 3),
  // tickの間隔（ミリ秒）。既定1時間。
  tickIntervalMs: () => envInt('STEP_TICK_INTERVAL_MS', 60 * 60 * 1000),
};

const BASE_URL = 'https://kind-cooperation-production.up.railway.app';

// ── ステップ本文 ────────────────────────────────────────
// 【文面の制約】敬体／罫線（---）を入れない／ブランド名・製品名・勧誘語を書かない／
// 　医学的な効能を断定しない／不動産・税金・法律の断定的な助言をしない。
// 　建築士として「見えた事実」だけを書く。
//
// ⚠️ build() は「1リクエストで送るメッセージオブジェクトの配列」を返す。
//    配列の要素は最大5個まで。何個入れても消費するのは1人あたり1通。
//    文字の壁を作らないため、あえて吹き出しを分けている（料金は変わらない）。
const STEPS = [
  {
    key: 'day1',
    day: 1,
    label: '1日目：実家で見る3か所（役に立つものを先に渡す）',
    purpose: '売り込まない。建築士として見える事実だけを渡し、「この人の話は使える」と思ってもらう。',
    exit: 'なし（意図的に出口を置かない）',
    build: () => [
      {
        type: 'text',
        text:
          '昨日は友だち追加をありがとうございました。カツヤスです。\n' +
          '\n' +
          'いきなり売り込みはしません。\n' +
          '\n' +
          'まず、私が家を見るときに最初に確認する場所を3つだけお伝えします。ご実家に帰られたとき、5分あれば見られるところです。',
      },
      {
        type: 'text',
        text:
          '【1】基礎の外側\n' +
          '\n' +
          'コンクリートの表面を見ます。髪の毛ほどの細い線が縦に入っているのは、よくあることです。\n' +
          '\n' +
          '私が目を留めるのは、幅のある線が斜めに走っている場合のほうです。',
      },
      {
        type: 'text',
        text:
          '【2】雨どいと、その真下の地面\n' +
          '\n' +
          '雨どいが外れていたり詰まっていたりすると、雨水が毎回おなじ場所に落ちます。\n' +
          '\n' +
          'その真下の地面がえぐれていないかを見ます。',
      },
      {
        type: 'text',
        text:
          '【3】北側の、壁と基礎が接するあたり\n' +
          '\n' +
          '日が当たらない面です。黒ずんでいるところ、触ってやわらかいところがあれば、覚えておいてください。',
      },
      {
        type: 'text',
        text:
          'その場で判断しなくて大丈夫です。写真を撮っておくだけで十分です。\n' +
          '\n' +
          'あとで誰かに相談するとき、その写真がいちばん役に立ちます。\n' +
          '\n' +
          'カツヤス',
      },
    ],
  },
  {
    key: 'day3',
    day: 3,
    label: '3日目：順番の話（等身大の失敗談）＋ 本へ軽く',
    purpose: '「片付けから入ると損をする」という順番の知恵を渡す。本はついでに置くだけで押さない。',
    exit: 'Kindle（ボタン1つ。押さない書き方にする）',
    build: () => [
      {
        type: 'text',
        text:
          'カツヤスです。\n' +
          '\n' +
          '実家をどうするか、という話になると、たいてい最初に片付けが始まります。気持ちはよく分かります。物が減らないと、話が前に進まない気がするからです。\n' +
          '\n' +
          'ただ、私が現場で見てきたかぎり、片付けを先に済ませてしまうと、あとで困ることがあります。',
      },
      {
        type: 'text',
        text:
          '物が無くなると、家の履歴も一緒に消えるからです。\n' +
          '\n' +
          'いつ屋根を直したか。どこを増築したか。図面はどこにあったか。\n' +
          '\n' +
          'それを知っているのは、たいてい押し入れの奥の封筒だったりします。捨てたあとで「あれが要る」と言われるのが、いちばんつらい。',
      },
      {
        type: 'text',
        text:
          'ですので、片付けを始める前に、これだけやっておくことをおすすめします。\n' +
          '\n' +
          '・各部屋を、扉のところから1枚ずつ写真に撮る\n' +
          '\n' +
          '・図面、確認済証、工事の見積書らしき紙は、中身が分からなくても一箇所にまとめておく\n' +
          '\n' +
          '・親御さんが元気なうちに「どこを直したか」だけ聞いておく\n' +
          '\n' +
          'これで、あとから何を聞かれても答えられます。',
      },
      {
        type: 'flex',
        altText: '順番を間違えて損をした話は、本にも書きました',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            paddingAll: '20px',
            contents: [
              {
                type: 'text',
                wrap: true,
                size: 'sm',
                text:
                  '私自身、順番を間違えて損をしたことは何度もあります。そのあたりの話は本にも書きました。\n' +
                  '\n' +
                  '読んでいただかなくても構いません。ここに置いておくだけにします。\n' +
                  '\n' +
                  'カツヤス',
              },
            ],
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            paddingAll: '16px',
            contents: [
              {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: {
                  type: 'uri',
                  label: '本の一覧を見る',
                  uri: 'https://www.amazon.co.jp/dp/B0GX32SBKC',
                },
              },
            ],
          },
        },
      },
    ],
  },
  {
    key: 'day7',
    day: 7,
    label: '7日目：押さずに閉じる。以降は返信（無料）に切り替える',
    purpose:
      'ここでプッシュ配信を終わらせる。続きが要る人だけ言葉を送ってもらい、以降のやり取りを返信＝無料通数ゼロで回す。',
    exit: '相談／Kindle／出版代行の3つを、本人に選ばせる（押し売りにしない）',
    build: () => [
      {
        type: 'text',
        text:
          '一週間になりました。カツヤスです。\n' +
          '\n' +
          'この一週間で、二つお伝えしました。実家で見る3か所と、片付けの前に写真を撮る話です。\n' +
          '\n' +
          'まだ何もしていなくても、それで構いません。実家のことは、期限が来るまで動けないのが普通です。私もそうでした。',
      },
      {
        type: 'text',
        text:
          'ここから先は、私からは押しません。\n' +
          '\n' +
          '必要になったときに、下の言葉のどれかをこのトークに送ってください。その話だけをお返しします。',
      },
      {
        type: 'text',
        text:
          '「実家の話」\n' +
          'ご実家の写真や状況を送っていただければ、建築士として建物に見えることをお伝えします。売る・貸す・壊すの判断は私はしません。今どうなっているか、それだけです。\n' +
          '\n' +
          '「本の話」\n' +
          '私がこれまでに書いた本の一覧をお送りします。\n' +
          '\n' +
          '「出版の話」\n' +
          'ご自身の経験を本にしてみたい方向けの話です。',
      },
      {
        type: 'text',
        text:
          '何も送っていただかなくても大丈夫です。私からの連絡はこれで終わりにします。しつこく続きません。\n' +
          '\n' +
          'カツヤス',
      },
    ],
  },
];

// ── 7日目の3つの言葉への返信（reply＝無料通数を消費しない）────────
// index.js の getReply() から、既存の全分岐のあとに呼ばれる。
// 既存の合言葉より必ず後ろで判定されるため、既存の動作を上書きしない。
function stepKeywordReply(text) {
  if (typeof text !== 'string') return null;

  if (text.includes('実家の話')) {
    return {
      type: 'text',
      text:
        'ありがとうございます。カツヤスです。\n' +
        '\n' +
        'ご実家の状況を、分かる範囲でこのトークに送ってください。文章だけでも、写真だけでも構いません。\n' +
        '\n' +
        'あると助かるのは、この3つです。\n' +
        '\n' +
        '・建てたおおよその年（分からなければ「昭和のいつごろ」で十分です）\n' +
        '・いま人が住んでいるかどうか\n' +
        '・気になっている場所の写真（外からで構いません）\n' +
        '\n' +
        '建築士として、建物に何が起きているかをお伝えします。売る・貸す・解体するといった判断や、費用がいくらかかるかは、私は申し上げません。そこは持ち主の方が決めることですし、金額は現地を見た専門の業者でないと出せないからです。\n' +
        '\n' +
        'お返事は当日から翌日のうちにお送りします。\n' +
        '\n' +
        'カツヤス',
    };
  }

  if (text.includes('本の話')) {
    return {
      type: 'text',
      text:
        'ありがとうございます。カツヤスです。\n' +
        '\n' +
        '私が書いた本は、Amazonの著者ページにまとめてあります。\n' +
        '\n' +
        'https://www.amazon.co.jp/dp/B0GX32SBKC\n' +
        '\n' +
        'どれも、うまくいった話より、しくじった話のほうが多く入っています。同じ年代の方に「自分だけじゃないな」と思っていただければ、それで十分です。\n' +
        '\n' +
        '気になる題名があれば、その題名をこのトークに送ってください。中身の要点だけ先にお伝えします。買わずに済むなら、そのほうがいいと思っています。\n' +
        '\n' +
        'カツヤス',
    };
  }

  if (text.includes('出版の話')) {
    return {
      type: 'text',
      text:
        'ありがとうございます。カツヤスです。\n' +
        '\n' +
        'ご自身の経験を本にする、という話ですね。\n' +
        '\n' +
        '私は本業が建築士で、そのかたわらで本を出してきました。原稿づくりから表紙、配信の登録まで、ひととおり自分の手でやっています。その手順をそのままお引き受けすることもできますし、ご自分でやるための段取りだけをお伝えすることもできます。\n' +
        '\n' +
        'まずは、この2つを教えてください。\n' +
        '\n' +
        '・どんな経験を残しておきたいか（一行で構いません）\n' +
        '・誰に読んでほしいか\n' +
        '\n' +
        'この2つが決まっていれば、本になります。決まっていなければ、そこから一緒に考えます。\n' +
        '\n' +
        'お返事は当日から翌日のうちにお送りします。\n' +
        '\n' +
        'カツヤス',
    };
  }

  return null;
}

// classify()（オーナー通知の要否判定）で使う。7日目の3語は問い合わせとして扱う。
function isStepKeyword(text) {
  return stepKeywordReply(text) !== null;
}

// ── 永続ストア ──────────────────────────────────────────
// 形: { version, subscribers: { [userId]: { followedAt, active, sent: {day1:ts,...}, skipped: {...} } } }
const store = {
  version: 1,
  subscribers: {},
};

let storeFile = '';
let persistent = false; // 永続化できているか
let persistReason = 'not_initialized';
let deps = { client: null, pushLog: () => {} };
let tickTimer = null;
const runLog = []; // 直近の実行結果（デバッグ用・最大50件）

function pushRunLog(entry) {
  runLog.push({ ts: new Date().toISOString(), ...entry });
  if (runLog.length > 50) runLog.shift();
}

function loadStore() {
  const dir = CONF.dataDir();
  if (!dir) {
    persistent = false;
    persistReason = 'no_volume_configured';
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    storeFile = path.join(dir, 'step_subscribers.json');
    if (fs.existsSync(storeFile)) {
      const raw = fs.readFileSync(storeFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.subscribers) {
        store.subscribers = parsed.subscribers;
      }
    }
    // 書き込みできることを実際に確かめる（読めるが書けない環境があるため。
    // ボリュームが読み取り専用・容量いっぱいのとき、ここで気づかないと
    // 「送信済みの印」が保存されず、再起動のたびに全員へ再送してしまう）
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
    console.error('[STEP] ストアの読み書きに失敗:', e && e.message);
  }
}

// 保存できたかどうかを必ず返す。呼び出し側は戻り値を無視してはならない。
// 保存できないまま送信を続けると、送信済みの印が残らず全員へ再送してしまうため。
function saveStore() {
  if (!storeFile) return false;
  try {
    const tmp = storeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, storeFile); // 原子的に置き換える（書き込み中の停止で壊さない）
    return true;
  } catch (e) {
    console.error('[STEP] ストアの保存に失敗:', e && e.message);
    // 一度でも保存に失敗したら、以降は永続化なしとして扱う（＝送信を止める）
    persistent = false;
    persistReason = 'save_failed:' + (e && e.message);
    return false;
  }
}

// ── 時刻ユーティリティ ──────────────────────────────────
function hourJST(d = new Date()) {
  return parseInt(
    d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo', hour: '2-digit', hour12: false }),
    10
  );
}
function daysSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return -1;
  return (now - t) / (24 * 60 * 60 * 1000);
}

// ── webhook から呼ばれる記録関数 ────────────────────────
// ⚠️ 例外を外に出さない。ここで落ちても follow の返信は絶対に巻き込まない。
function recordFollow(userId) {
  try {
    if (!userId) return;
    const now = new Date().toISOString();
    const prev = store.subscribers[userId];
    if (prev && prev.active) {
      // すでに登録済みで有効なまま（重複followイベント）。上書きしない。
      return;
    }
    store.subscribers[userId] = {
      followedAt: now,
      active: true,
      sent: {},
      skipped: {},
      refollowCount: prev ? (prev.refollowCount || 0) + 1 : 0,
    };
    saveStore();
    deps.pushLog({ kind: 'step_follow_recorded', persistent });
  } catch (e) {
    console.error('[STEP] recordFollow 失敗:', e && e.message);
  }
}

// ブロック・友だち削除。以降は送らない（送っても届かず無料通数だけ減るため）。
function recordUnfollow(userId) {
  try {
    if (!userId) return;
    const s = store.subscribers[userId];
    if (!s) return;
    s.active = false;
    s.unfollowedAt = new Date().toISOString();
    saveStore();
    deps.pushLog({ kind: 'step_unfollow_recorded' });
  } catch (e) {
    console.error('[STEP] recordUnfollow 失敗:', e && e.message);
  }
}

// ── 残通数の確認 ────────────────────────────────────────
// LINEのAPIから直接取る。こちらで通数を数えて推測しない。
// 返り値: { ok, type, limit, used, remaining, detail }
async function checkQuota() {
  try {
    const quota = await deps.client.getMessageQuota();
    const consumption = await deps.client.getMessageQuotaConsumption();
    const used = (consumption && consumption.totalUsage) || 0;

    // type が 'none' のときは上限なし（＝有料プランで無制限相当）。
    if (!quota || quota.type !== 'limited') {
      return { ok: true, type: (quota && quota.type) || 'unknown', limit: null, used, remaining: null };
    }
    const limit = quota.value || 0;
    return { ok: true, type: 'limited', limit, used, remaining: limit - used };
  } catch (e) {
    return { ok: false, detail: e && e.message };
  }
}

// ── 配信の中核 ──────────────────────────────────────────
// force: true で時刻ゲートを無視する（テスト用）
async function runTick(options = {}) {
  const force = !!options.force;
  const result = {
    ranAt: new Date().toISOString(),
    force,
    enabled: CONF.enabled(),
    dryRun: CONF.dryRun(),
    persistent,
    hourJST: hourJST(),
    plannedBySteps: {},
    planned: 0,
    sent: 0,
    skippedStale: 0,
    reason: null,
  };

  try {
    // 時刻ゲート（日本時間の指定時にだけ動く）
    if (!force && result.hourJST !== CONF.sendHourJST()) {
      result.reason = 'not_send_hour';
      return result;
    }

    // 宛先の抽出（enabled かどうかに関わらず「誰に何が届く予定か」は必ず算出する。
    // これがドライランでの確認材料になる）
    const now = Date.now();
    const limitDays = CONF.catchUpLimitDays();
    const plan = {}; // stepKey -> [userId]

    for (const step of STEPS) {
      plan[step.key] = [];
    }

    for (const [userId, s] of Object.entries(store.subscribers)) {
      if (!s || !s.active) continue;
      const elapsed = daysSince(s.followedAt, now);
      if (elapsed < 0) continue;
      for (const step of STEPS) {
        if (s.sent && s.sent[step.key]) continue;
        if (s.skipped && s.skipped[step.key]) continue;
        if (elapsed < step.day) continue;
        // 予定日を大きく過ぎているものは「もう送らない」ことにする
        if (elapsed > step.day + limitDays) {
          s.skipped = s.skipped || {};
          s.skipped[step.key] = 'stale';
          result.skippedStale += 1;
          continue;
        }
        plan[step.key].push(userId);
      }
    }

    for (const step of STEPS) {
      result.plannedBySteps[step.key] = plan[step.key].length;
      result.planned += plan[step.key].length;
    }
    if (result.skippedStale > 0) saveStore();

    if (result.planned === 0) {
      result.reason = 'nobody_due';
      return result;
    }

    // ── ここから先は「実際に送るかどうか」の判断 ──
    if (!result.enabled) {
      result.reason = 'disabled_by_flag'; // 🔴 既定はここで必ず止まる
      pushRunLog(result);
      return result;
    }
    if (!persistent && !CONF.allowEphemeral()) {
      // 永続化できていないのに送ると、再起動のたびに同じ人へ再送してしまう。
      result.reason = 'not_persistent:' + persistReason;
      pushRunLog(result);
      return result;
    }

    // 残通数の確認（推測せずAPIで取る）
    const quota = await checkQuota();
    result.quota = quota;
    if (!quota.ok) {
      result.reason = 'quota_check_failed';
      pushRunLog(result);
      return result;
    }
    if (quota.remaining !== null) {
      const reserve = CONF.quotaReserve();
      if (quota.remaining - result.planned < reserve) {
        // 予備枠（相談通知など落とせないpush用）を割り込むので送らない
        result.reason = `quota_guard: remaining=${quota.remaining} planned=${result.planned} reserve=${reserve}`;
        pushRunLog(result);
        return result;
      }
    }

    if (result.dryRun) {
      result.reason = 'dry_run'; // 🔴 既定はここで止まる
      pushRunLog(result);
      return result;
    }

    // ── 実送信 ──
    let budget = CONF.maxSendsPerTick();
    for (const step of STEPS) {
      const targets = plan[step.key].slice(0, Math.max(0, budget));
      if (targets.length === 0) continue;
      // 1リクエストにメッセージオブジェクトは最大5個まで。超えるとAPIが400を返す。
      const messages = step.build().slice(0, 5);

      // multicast は1リクエストで最大500宛先。通数は宛先数ぶん消費するが、
      // API呼び出し回数を減らせるためレート制限に優しい。
      for (let i = 0; i < targets.length; i += 150) {
        const chunk = targets.slice(i, i + 150);
        try {
          if (chunk.length === 1) {
            await deps.client.pushMessage({ to: chunk[0], messages });
          } else {
            await deps.client.multicast({ to: chunk, messages });
          }
          const ts = new Date().toISOString();
          for (const uid of chunk) {
            const s = store.subscribers[uid];
            if (s) {
              s.sent = s.sent || {};
              s.sent[step.key] = ts;
            }
          }
          result.sent += chunk.length;
          budget -= chunk.length;
          deps.pushLog({ kind: 'step_sent', step: step.key, count: chunk.length });

          // 送信済みの印を必ず保存する。保存できないなら、これ以上送ってはいけない。
          // （印が残らないまま送り続けると、次回また同じ人へ送ってしまう）
          if (!saveStore() && !CONF.allowEphemeral()) {
            result.reason = 'aborted_save_failed:' + persistReason;
            console.error('[STEP] 送信済みの記録に失敗したため、以降の送信を中止します。');
            pushRunLog(result);
            return result;
          }
        } catch (e) {
          // 失敗した分は sent に印を付けない → 次のtickで再挑戦される
          console.error(`[STEP] ${step.key} の送信に失敗:`, e && e.message);
          deps.pushLog({ kind: 'step_send_error', step: step.key, error: e && e.message });
          result.errors = result.errors || [];
          result.errors.push({ step: step.key, error: e && e.message });
        }
      }
    }
    result.reason = 'sent';
    pushRunLog(result);
    return result;
  } catch (e) {
    result.reason = 'exception:' + (e && e.message);
    console.error('[STEP] runTick 例外:', e && e.message);
    pushRunLog(result);
    return result;
  }
}

// ── 起動 ────────────────────────────────────────────────
function init(dependencies) {
  deps = { pushLog: () => {}, ...dependencies };
  loadStore();

  console.log('[STEP] ステップ配信モジュール読み込み');
  console.log('[STEP] 配信フラグ STEP_DELIVERY_ENABLED:', CONF.enabled(), '（既定オフ）');
  console.log('[STEP] ドライラン STEP_DELIVERY_DRY_RUN:', CONF.dryRun(), '（既定オン）');
  console.log('[STEP] 永続化:', persistent, '理由:', persistReason);
  if (!persistent) {
    console.warn(
      '[STEP][警告] 登録日時を保存できていません。プロセスが再起動すると登録者情報は消えます。' +
        'Railwayでボリュームを追加するまで、実送信は行いません。'
    );
  }

  // Railway に cron 機能はこのサービスには付いていないため、プロセス内タイマーで回す。
  // このサービスは webhook を受ける常駐 Web サービスなので、常時起動している前提が成り立つ。
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    runTick().catch((e) => console.error('[STEP] tick 例外:', e && e.message));
  }, CONF.tickIntervalMs());
  if (tickTimer.unref) tickTimer.unref();

  // 起動直後にも1回だけ様子を見る（送信条件を満たさなければ何もしない）
  setTimeout(() => {
    runTick().catch(() => {});
  }, 30 * 1000).unref?.();
}

// ── デバッグ用の状態出力（ユーザーIDは伏せる）────────────
function getStatus() {
  const subs = Object.values(store.subscribers);
  const counts = {};
  for (const step of STEPS) {
    counts[step.key] = subs.filter((s) => s.sent && s.sent[step.key]).length;
  }
  return {
    enabled: CONF.enabled(),
    dryRun: CONF.dryRun(),
    persistent,
    persistReason,
    storeFileConfigured: !!storeFile,
    sendHourJST: CONF.sendHourJST(),
    quotaReserve: CONF.quotaReserve(),
    subscribersTotal: subs.length,
    subscribersActive: subs.filter((s) => s.active).length,
    sentCounts: counts,
    steps: STEPS.map((s) => ({ key: s.key, day: s.day, label: s.label, exit: s.exit })),
    recentRuns: runLog,
  };
}

// 文面のプレビュー（送信せずに中身だけ確認する）
function previewSteps() {
  return STEPS.map((s) => ({
    key: s.key,
    day: s.day,
    label: s.label,
    purpose: s.purpose,
    exit: s.exit,
    bubbles: s.build().length, // 吹き出しの数。何個でも消費は1人あたり1通。
    messages: s.build(),
  }));
}

module.exports = {
  init,
  recordFollow,
  recordUnfollow,
  stepKeywordReply,
  isStepKeyword,
  runTick,
  getStatus,
  previewSteps,
  checkQuota,
  STEPS,
};
