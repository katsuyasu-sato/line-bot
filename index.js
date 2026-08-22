// ─────────────────────────────────────────────────────────
// カツヤス｜50代の人生設計 LINE Bot
// 機能: 自動返信・ウェルカムメッセージ・キーワード応答
// ─────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const line = require('@line/bot-sdk');

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

// ── 起動時 環境変数チェック（値は出さない）─────────────
console.log('[BOOT] LINE_CHANNEL_SECRET is set:', !!config.channelSecret);
console.log('[BOOT] LINE_CHANNEL_ACCESS_TOKEN is set:', !!config.channelAccessToken);
if (!config.channelSecret || !config.channelAccessToken) {
  console.error('[BOOT][FATAL] LINE 環境変数が未設定。Railway の Variables を確認してください。');
}

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken || 'dummy',
});

const app = express();

// ── 静的配信（読者特典PDF等）──────────────────────────────
// public/ 配下を /present で公開。例: /present/checklist_taino_tenken.pdf
app.use('/present', express.static(path.join(__dirname, 'public')));

// ── デバッグ用リングバッファ（直近100件のイベントログ）─────
// 秘密情報は載せない（ユーザーID・トークン等は出さない）
const DEBUG_LOG_MAX = 100;
const debugLog = [];
function pushLog(entry) {
  debugLog.push({ ts: new Date().toISOString(), ...entry });
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
}

// ── Webhook エンドポイント ──────────────────────────────
// line.middleware() に頼らず、自前で署名検証 → 必ず即レスを返す。
// これによりタイムアウト原因（middlewareが例外で死んでレスを返さない）を排除。
app.post(
  '/webhook',
  express.raw({ type: '*/*' }), // 生バイナリで受け取って自前検証
  async (req, res) => {
    const signature = req.get('x-line-signature') || '';
    const rawBody = req.body; // Buffer

    // 環境変数チェック（無ければ即 500、ハングさせない）
    if (!config.channelSecret) {
      console.error('[WEBHOOK] LINE_CHANNEL_SECRET unset');
      return res.status(500).json({ error: 'LINE_CHANNEL_SECRET unset' });
    }

    // 自前 HMAC-SHA256 署名検証
    let bodyString = '';
    try {
      bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : (typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {}));
      const expected = crypto
        .createHmac('SHA256', config.channelSecret)
        .update(bodyString)
        .digest('base64');
      if (signature !== expected) {
        console.warn('[WEBHOOK] signature mismatch (signature header present:', !!signature, ')');
        pushLog({ kind: 'webhook', sig: 'mismatch', sig_present: !!signature, body_len: bodyString.length });
        // LINEの「検証」ボタンや疎通テストはここを通る。常に200を返してタイムアウトさせない。
        return res.status(200).json({ status: 'signature_mismatch_but_ok' });
      }
    } catch (e) {
      console.error('[WEBHOOK] signature verify exception:', e.message);
      pushLog({ kind: 'webhook', sig: 'verify_error', error: e.message });
      return res.status(200).json({ status: 'verify_error_but_ok' });
    }

    // JSONパース
    let body;
    try {
      body = JSON.parse(bodyString || '{}');
    } catch (e) {
      console.error('[WEBHOOK] JSON parse error:', e.message);
      return res.status(200).json({ status: 'json_parse_error_but_ok' });
    }

    const events = Array.isArray(body.events) ? body.events : [];
    pushLog({ kind: 'webhook', sig: 'ok', events: events.length, types: events.map(e => e && e.type) });

    // 先にACKを返す（LINEはタイムアウト厳しいため）
    res.status(200).json({ status: 'ok' });

    // イベント処理は非同期で実行（res送信後）
    // 各イベントごとに try/catch して、一つの失敗で他を巻き込まないようにする
    for (const ev of events) {
      handleEvent(ev).catch((err) => {
        console.error('[WEBHOOK] handleEvent error:', err && err.message);
        pushLog({ kind: 'handle_event_error', type: ev && ev.type, error: err && err.message, status: err && err.statusCode });
      });
    }
  }
);

// 万一のためのエラーハンドラ（res未送信時のみ500を即返す）
app.use((err, req, res, next) => {
  console.error('[ERROR HANDLER]', err && err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal error' });
  }
});

// ── イベント処理 ────────────────────────────────────────
async function handleEvent(event) {
  if (!event) return;

  // 友だち追加・ブロック解除 → welcome message を最速で返す
  // ⚠️ ここで getProfile() を待つと replyToken (30秒制限) が切れる可能性があるため、
  //    follow ではユーザー名を取得せず即時 reply する
  if (event.type === 'follow') {
    const messages = welcomeMessages('あなた');
    await safeReply(event.replyToken, messages, 'follow');
    return;
  }

  // テキストメッセージ処理
  if (event.type === 'message' && event.message && event.message.type === 'text') {
    const text = (event.message.text || '').trim();
    const userId = event.source && event.source.userId;

    // ── 通知テスト（オーナー本人のみ。getReply()/classify() には一切触れず、ここで完結させる）──
    // オーナーが1人で「OWNER_USER_ID の登録が正しいか」を自己診断できるようにするための分岐。
    // オーナー以外が同じ文言を送った場合はここに入らず、そのまま通常フロー（getReply）に進む。
    if (
      userId &&
      userId === process.env.OWNER_USER_ID &&
      (text.includes('通知テスト') ||
        text.includes('通知てすと') ||
        text.includes('つうちテスト') ||
        text.includes('つうちてすと'))
    ) {
      // push を先に試す（結果を返信に載せるため）。通知の失敗が返信を巻き込まない設計を守るため、
      // 想定外の例外もここで catch して 'unknown' として扱う。
      let result;
      try {
        result = await notifyOwner(buildNotifyTestPushText());
      } catch (e) {
        result = { ok: false, reason: 'unknown', detail: e && e.message };
      }
      await safeReply(event.replyToken, [buildNotifyTestReplyMessage(result)], 'notify_test');
      return;
    }

    // ユーザー名は best-effort（失敗してもデフォルト）
    let userName = 'あなた';
    try {
      const profile = await client.getProfile(event.source.userId);
      if (profile && profile.displayName) userName = profile.displayName;
    } catch (e) {
      // 取得失敗は無視
    }
    const reply = getReply(text, userName, userId);
    // getReply は単一メッセージ（オブジェクト）または複数メッセージ（配列）を返す
    const messages = Array.isArray(reply) ? reply : [reply];
    await safeReply(event.replyToken, messages, 'message');

    // ── オーナーへの通知（返信の後に実行。通知の成否は相談者への返信結果に一切影響させない）──
    // オーナー自身が送ったメッセージには通知しない（無意味・pushMessage無料枠の浪費を避けるため）
    if (userId && userId !== process.env.OWNER_USER_ID) {
      const kind = classify(text);
      if (kind === 'soudan_apply') {
        await notifyOwner(buildSoudanApplyNotifyText(userName));
      } else if (kind === 'doterra_interest') {
        await notifyOwner(buildDoterraInterestNotifyText(userName, text));
      } else if (kind === 'fallback') {
        await notifyOwner(buildFallbackNotifyText(userName, text));
      }
    }
    return;
  }

  // 上記以外のイベント（unfollow等）は何もしない
  pushLog({ kind: 'event_ignored', type: event.type });
}

// reply送信のラッパー。エラー（401/400など）をログに残す
// 400の場合は LINE API の詳細メッセージ（どのプロパティが不正か）まで記録する
async function safeReply(replyToken, messages, label) {
  try {
    await client.replyMessage({ replyToken, messages });
    pushLog({ kind: 'reply_ok', label, msg_count: messages.length });
  } catch (err) {
    const status =
      err &&
      (err.statusCode ||
        (err.originalError && err.originalError.response && err.originalError.response.status));
    const detail = err && err.message;

    // LINE API のレスポンスボディから詳細を吸い出す（SDK のバージョンで場所が違うため全方位で探す）
    let apiBody = null;
    try {
      if (err && err.originalError && err.originalError.response) {
        apiBody = err.originalError.response.data || err.originalError.response.body || null;
      }
      if (!apiBody && err && err.response) {
        apiBody = err.response.data || err.response.body || null;
      }
      if (!apiBody && err && err.body) {
        apiBody = err.body;
      }
    } catch (_) {
      // 取り出し失敗は無視
    }

    // 文字列化（オブジェクトならJSON化、長すぎたら切る）
    let apiBodyStr = '';
    try {
      apiBodyStr = typeof apiBody === 'string' ? apiBody : JSON.stringify(apiBody);
    } catch (_) {
      apiBodyStr = String(apiBody);
    }
    if (apiBodyStr && apiBodyStr.length > 1500) {
      apiBodyStr = apiBodyStr.slice(0, 1500) + '...(truncated)';
    }

    console.error(`[REPLY] ${label} failed status=${status} msg=${detail} body=${apiBodyStr}`);
    pushLog({ kind: 'reply_error', label, status, detail, api_body: apiBodyStr });
  }
}

// ── ウェルカムメッセージ（1通） ────────────────────────────
function welcomeMessages(userName) {
  return [giftMessage(userName)];
}

function giftMessage(userName) {
  // ⚠️ follow 時は userName を取得していないので、固定の挨拶にする
  return {
    type: 'text',
    text: '友だち追加ありがとうございます。\n一級建築士の佐藤勝保（カツヤス）です。\n\nKindle本またはnote記事から来てくださった方は、本や記事の中に書いてある「合言葉」をこのトークに送ってください。\nその本・記事専用のプレゼントをお届けします。\n\nカツヤス',
  };
}


// ── キーワード別返信 ────────────────────────────────────
function getReply(text, userName, userId) {

  // 【最優先】オーナー自身のLINEユーザーID確認用（他のどの合言葉判定よりも先に判定する）
  // 合言葉: 「マイID」（表記ゆれ4種対応: マイID／マイid／マイＩＤ／マイＩｄ）
  if (
    text.includes('マイID') ||
    text.includes('マイid') ||
    text.includes('マイＩＤ') ||
    text.includes('マイＩｄ')
  ) {
    return {
      type: 'text',
      text:
        '🔧 あなたのLINEユーザーIDです\n\n' +
        `${userId || '（取得できませんでした）'}\n\n` +
        'この文字列をRailwayの環境変数 OWNER_USER_ID に登録すると、\n' +
        '個別相談の申し込みがこのトークに通知されるようになります。\n\n' +
        '※このIDは、あなたご自身にしか表示されません。',
    };
  }

  // 【流入元】副業本
  if (text.includes('副業本') || text.includes('副業')) {
    return {
      type: 'flex',
      altText: '『副業で1000万溶かした62歳』をお読みいただきありがとうございます',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '📖 副業本にご関心いただきありがとうございます', weight: 'bold', size: 'md', color: '#0C2448', wrap: true },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: 'Kindle本『副業で1000万溶かした62歳』、またはnoteの記事から来てくださったかもしれません。\n\n1000万円を溶かした話を最後まで読んでいただき、ありがとうございます。恥をさらした甲斐がありました。\n\nこのLINEでは、本や記事には書けなかった続きの話をお届けしていきます。よろしくお願いします。\n\nカツヤス',
              wrap: true,
              margin: 'md',
              size: 'sm',
            },
          ],
          paddingAll: '20px',
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              action: { type: 'uri', label: 'Amazonレビューを書く', uri: 'https://www.amazon.co.jp/dp/B0GX32SBKC' },
              style: 'primary',
              color: '#E6580C',
            },
          ],
        },
      },
    };
  }

  // 【流入元】Instagram
  if (text.includes('インスタ') || text.includes('instagram') || text.includes('Instagram')) {
    return {
      type: 'text',
      text: '📸 Instagramから来てくださりありがとうございます！\n\nInstagramでは日々発信していますが、\nこちらでは投稿に書けなかった本音の話をお届けします。\n\n引き続きよろしくお願いします。\nカツヤス',
    };
  }

  // 【流入元】note
  if (text.includes('note') || text.includes('ノート')) {
    return {
      type: 'text',
      text: '📝 noteから来てくださりありがとうございます！\n\nnoteでは記事を書いていますが、\nこちらでは記事にならない生の話をお届けしていきます。\n\nよろしくお願いします。\nカツヤス',
    };
  }

  // 【合言葉】香りは、空間の第4の建材だった 読者プレゼント
  // 合言葉: 「香り」
  if (text.includes('香り') || text.includes('建材')) {
    return {
      type: 'flex',
      altText: '【ご登録プレゼント】doTERRAアロマケアガイドアプリをお届けします',
      contents: {
        type: 'bubble',
        hero: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '🎁 ご登録プレゼント', weight: 'bold', size: 'xl', color: '#2E7D32' },
            { type: 'text', text: '香りは、空間の第4の建材だった', size: 'sm', color: '#888888', margin: 'sm' },
          ],
          paddingAll: '20px',
          backgroundColor: '#E8F5E9',
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '本や記事にご関心を持っていただきありがとうございます。\n\nKindle本『香りは、空間の第4の建材だった』、またはnoteの記事から来てくださった方へ、ご登録プレゼントとしてdoTERRAアロマケアガイドアプリ（無料）をご用意しました。\n\nその日の気分と、香らせたい場所を選ぶだけで、おすすめの香りとディフューザーの滴数が出てきます。建築士ならではの「空間×香り」という視点でもお使いいただけるアプリです。\n\nカツヤス',
              wrap: true,
              size: 'sm',
            },
          ],
          paddingAll: '20px',
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              action: { type: 'uri', label: '🌿 アロマアプリを受け取る（無料）', uri: 'https://superlative-cendol-797c9a.netlify.app' },
              style: 'primary',
              color: '#2E7D32',
            },
            {
              type: 'button',
              action: { type: 'uri', label: 'doTERRAで購入する', uri: 'https://office.doterra.com/katuyasusatou' },
              style: 'secondary',
              margin: 'sm',
            },
          ],
        },
      },
    };
  }

  // 【合言葉】働く50代の快眠革命 / 朝まで眠れる私に変えた本 読者プレゼント
  // 合言葉: 「快眠」「アロマ本」「doTERRA」「ドテラ」
  // ※ doTERRA / ドテラ は「相談」系の語を含む場合、相談導線（下の isSoudan 判定）を優先する
  const isSoudan = /相談|そうだん|コンサル/.test(text);
  if (text.includes('快眠') || text.includes('アロマ本') || ((text.includes('doTERRA') || text.includes('ドテラ')) && !isSoudan)) {
    return {
      type: 'flex',
      altText: '【ご登録プレゼント】doTERRAアロマケアガイドアプリをお届けします',
      contents: {
        type: 'bubble',
        hero: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '🎁 ご登録プレゼント', weight: 'bold', size: 'xl', color: '#2E7D32' },
            { type: 'text', text: '快眠シリーズ読者の方へ', size: 'sm', color: '#888888', margin: 'sm' },
          ],
          paddingAll: '20px',
          backgroundColor: '#E8F5E9',
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '本や記事にご関心を持っていただきありがとうございます。\n\nKindle本『働く50代の快眠革命』『朝まで眠れる私に変えた本』、またはnoteの記事から来てくださった方へ、ご登録プレゼントとしてdoTERRAアロマケアガイドアプリ（無料）をご用意しました。\n\nその日の気分と、香らせたい場所を選ぶだけで、おすすめの香りとディフューザーの滴数が出てきます。\n\n✅ ディフューザーの滴数の目安もすぐにわかります\n✅ 朝向き・夜向きの香りの分類を載せています\n✅ 購入リンクも完備しています\n\nカツヤス',
              wrap: true,
              size: 'sm',
            },
          ],
          paddingAll: '20px',
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              action: { type: 'uri', label: '🌿 アロマアプリを受け取る（無料）', uri: 'https://superlative-cendol-797c9a.netlify.app' },
              style: 'primary',
              color: '#2E7D32',
            },
            {
              type: 'button',
              action: { type: 'uri', label: 'doTERRAで購入する', uri: 'https://office.doterra.com/katuyasusatou' },
              style: 'secondary',
              margin: 'sm',
            },
          ],
        },
      },
    };
  }

  // 設計図テンプレート
  if (text.includes('設計図') || text.includes('テンプレート')) {
    return {
      type: 'flex',
      altText: '人生設計図テンプレートをお届けします',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '📐 人生設計図テンプレート', weight: 'bold', size: 'lg', color: '#0C2448' },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: '4つの設計図テンプレートをご用意しております：\n\n✅ お金の設計図\n✅ 健康の設計図\n✅ 仕事・やりがいの設計図\n✅ 人間関係の設計図\n\n※ 現在準備中です。もうしばらくお待ちください。\n\nカツヤス',
              wrap: true,
              margin: 'md',
            },
          ],
          paddingAll: '20px',
        },
      },
    };
  }

  // 【流入元】外壁修繕アプリ
  if (text.includes('外壁修繕') || text.includes('外壁') || text.includes('修繕') || text.includes('屋根')) {
    return {
      type: 'flex',
      altText: '外壁修繕診断アプリをご利用いただきありがとうございます',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '🏠 外壁修繕診断をご利用いただきありがとうございます', weight: 'bold', size: 'md', color: '#0C2448', wrap: true },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: '一級建築士として30年、外壁を見てきた経験をもとに作ったアプリです。\n\n診断結果についてご不明な点があれば、お気軽にお尋ねください。\n・見積もりが適正か確認したい\n・業者選びに迷っている\n・修繕時期を相談したい\n\nどうぞ遠慮なくお送りください。\n\nカツヤス',
              wrap: true,
              margin: 'md',
              size: 'sm',
            },
          ],
          paddingAll: '20px',
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              action: { type: 'uri', label: '外壁修繕診断アプリを使う', uri: 'https://gaiheki-shindan-web.vercel.app/' },
              style: 'primary',
              color: '#0C2448',
            },
          ],
        },
      },
    };
  }

  // 【流入元】貧乏脳と金持ち脳 読者プレゼント
  // 合言葉: 「貧乏脳」「金持ち脳」「チェックリスト」「口癖カード」
  if (
    text.includes('貧乏脳') ||
    text.includes('金持ち脳') ||
    text.includes('チェックリスト') ||
    text.includes('口癖カード')
  ) {
    return {
      type: 'flex',
      altText: '【ご登録プレゼント】金持ち脳チェックリスト＋口癖変換カードをお届けします',
      contents: {
        type: 'bubble',
        hero: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '🎁 読者限定プレゼント2点', weight: 'bold', size: 'xl', color: '#C9A84C' },
            { type: 'text', text: '貧乏脳と金持ち脳', size: 'sm', color: '#888888', margin: 'sm' },
          ],
          paddingAll: '20px',
          backgroundColor: '#0C2448',
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '本や記事にご関心を持っていただきありがとうございます。\n\nKindle本『貧乏脳と金持ち脳』、またはnoteの記事から来てくださった方へ、ご登録プレゼントを2点ご用意しました。スマホに保存してお使いください。',
              wrap: true,
              size: 'sm',
            },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: '✅ A：金持ち脳チェックリスト\n　10項目で今の自分を確認できます\n\n✅ B：口癖変換カード\n　貧乏脳の言葉→金持ち脳の言葉へ\n　1週間で思考が変わります\n\nカツヤス',
              wrap: true,
              margin: 'md',
              size: 'sm',
            },
          ],
          paddingAll: '20px',
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              action: {
                type: 'uri',
                label: '📋 A：金持ち脳チェックリスト',
                uri: 'https://www.dropbox.com/scl/fi/ictgt05xxg1ifkpebff4p/present_A_checklist.png?rlkey=wh5w663c8rhyioovrwjm7fgx8&dl=1',
              },
              style: 'primary',
              color: '#0C2448',
            },
            {
              type: 'button',
              action: {
                type: 'uri',
                label: '🃏 B：口癖変換カード',
                uri: 'https://www.dropbox.com/scl/fi/qepm48afpp9tj2ol3sxtn/present_B_kotoba.png?rlkey=ophofws598qynz514cv1h9nn3&dl=1',
              },
              style: 'secondary',
              margin: 'sm',
            },
            {
              type: 'button',
              action: {
                type: 'message',
                label: '個別相談を希望する',
                text: '相談希望',
              },
              style: 'secondary',
              margin: 'sm',
            },
          ],
        },
      },
    };
  }

  // 【流入元】リフォーム本「100万円損しないリフォーム」読者プレゼント
  // 合言葉: 「リフォーム本」「見積書チェッカー」「見積もりチェッカー」「100万円」
  if (
    text.includes('リフォーム本') ||
    text.includes('見積書チェッカー') ||
    text.includes('見積もりチェッカー') ||
    text.includes('見積チェッカー') ||
    text.includes('100万円')
  ) {
    return {
      type: 'flex',
      altText: 'リフォーム本の読者プレゼント・見積書チェックリストをお届けします',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '📘 リフォーム本に関心を持っていただき、ありがとうございます！', weight: 'bold', size: 'md', color: '#0C2448', wrap: true },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: 'Kindle本『100万円損しないリフォーム ─業者を見抜く7つの質問』、またはnoteの記事から来てくださったかもしれません。\n\n下の「見積書チェックリスト」(PDF)を、お手元の見積書とあわせてお使いください。本書で紹介している7つの質問が、見積書のどこに反映されているかを1項目ずつチェックできます。\n\n何か疑問があれば、このトークでメッセージを送ってください。一級建築士として30年の経験から、できる範囲でお答えします。\n\nカツヤス',
              wrap: true,
              margin: 'md',
              size: 'sm',
            },
          ],
          paddingAll: '20px',
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              action: { type: 'uri', label: '📋 見積書チェックリスト（PDF）', uri: 'https://www.dropbox.com/scl/fi/ekkjwh6a62gj52pcuxn2l/estimate_checklist.pdf?rlkey=johmpbot80txsvkozftwk6owo&dl=0' },
              style: 'primary',
              color: '#0C2448',
            },
            {
              type: 'button',
              action: { type: 'message', label: '個別相談を希望する', text: '個別相談希望' },
              style: 'secondary',
              margin: 'sm',
            },
          ],
        },
      },
    };
  }

  // リフォーム本 個別相談希望
  if (text.includes('個別相談希望') || text.includes('リフォーム相談')) {
    return {
      type: 'flex',
      altText: 'リフォーム個別相談のご案内',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '🏠 リフォーム個別相談', weight: 'bold', size: 'lg', color: '#0C2448' },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: '個別相談のお問い合わせ、ありがとうございます。\n\n本相談は、書籍『100万円損しないリフォーム』の7つの質問を、ご相談者様のケースに沿って具体的に活用していただくためのお手伝いです。\n\n■ 形式：オンライン（Zoom／Meet）または対面（神奈川県相模原市内の貸会議室）\n■ 時間：1案件 60分程度\n■ 料金：¥20,000（税込・モニター価格）\n\n下記の点をご了承ください：\n・特定業者の評価・推奨は行いません\n・最終的な業者選定・契約判断はご相談者様ご自身となります\n・建築士法上の「設計」「工事監理」は本相談に含まれません\n\n予約フォーム・規約はリンクからご確認ください。\n\nカツヤス',
              wrap: true,
              margin: 'md',
              size: 'sm',
            },
          ],
          paddingAll: '20px',
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              action: { type: 'uri', label: '📋 予約フォームを開く', uri: 'https://superlative-cendol-797c9a.netlify.app/reform-consult.html' },
              style: 'primary',
              color: '#0C2448',
            },
          ],
        },
      },
    };
  }

  // 相談希望（① 相談メニュー末尾の案内の受け皿。ここより上の「個別相談希望／リフォーム相談」
  // 分岐より後に置くことで、既存のリフォーム個別相談導線を奪わないようにしている）
  //
  // 🔴【常設】特商法33条の2（勧誘に先立つ氏名等の明示）対応の一文を末尾に必ず残すこと。削除禁止。
  //    相談メニュー（下の「相談」分岐）を経由せず、直接「相談希望」と送る経路があるため、
  //    メニュー側だけに告知を置くと穴になる。しかもこちらは【申込み＝より勧誘に近い段階】なので
  //    告知の必要性が高い。①氏名 ②特定負担を伴う取引についての勧誘たりうる旨（会員登録＝登録料等の
  //    負担） ③商品の種類（精油などアロマ製品）の3要件を文面で満たしている。
  //    ⚠️ この告知は「個別相談希望／リフォーム相談」には入れない。あちらは有料のリフォーム個別相談
  //    （¥20,000）であり連鎖販売取引とは無関係。無関係な告知はかえって混乱を招く。
  //    "個別相談希望".includes('相談希望') は真になるが、リフォーム分岐が上にあるため
  //    「個別相談希望」「リフォーム相談」はここへ到達しない。この順序を入れ替えないこと。
  //    参照：rules/compliance.md §7-5
  if (text.includes('相談希望') || text.includes('そうだん希望')) {
    return {
      type: 'text',
      text: '📩 ご相談のお申し込みを受け付けました\n\nありがとうございます。カツヤスから折り返しご連絡します。\n\n差し支えなければ、このまま続けて次の3点をお送りください。やり取りが早くなります。\n\n① ご相談の内容（ひとことで結構です）\n② ご希望の日程（第3希望まで）\n③ オンライン（Zoom／Meet）か、お電話か\n\n※ 返信は当日〜翌日中を目安にしています。夜間・早朝にいただいた場合は、翌朝以降のご返信になります。\n\n※ お話しする前に、あらかじめお伝えしておきます。私はdoTERRA ウェルネスアドボケート（佐藤勝保）です。アロマのご相談では、ご希望があればdoTERRAの精油などアロマ製品の購入方法や、会員登録（登録料などのご負担が生じます）についてもご案内します。ただし、私のほうから勧誘することはありません。香りの話だけで終えていただいて構いません。\n\nカツヤス',
    };
  }

  // 相談
  // 🔴【常設】特商法33条の2（勧誘に先立つ氏名等の明示）対応の一文を末尾に必ず残すこと。
  //    1対1の個別対応では、①氏名 ②特定負担を伴う取引についての勧誘である旨 ③商品の種類 を
  //    文面で告げられるため、この一文があることで「相談」導線を適法に開いたまま維持できる。
  //    （投稿にかかる35条の広告表示義務は1枚に収めることが事実上不可能なので、SNS投稿側では
  //    引き続き層3＝収入・勧誘の話題を扱わない。rules/compliance.md §7-5 参照）
  //    Botは本文に「相談」の2文字があるだけで発火するため、この分岐は常に露出しうる。削除禁止。
  if (text.includes('相談') || text.includes('コンサル') || text.includes('個別')) {
    return {
      type: 'text',
      text: '📞 個別相談について\n\n以下のご相談を受け付けております：\n・老後の資金・生き方のご相談\n・アロマ（doTERRA）の香り選び・ディフューザーの使い方のご相談\n・副業の始め方・失敗しない選び方\n・建築・リフォームのご相談（書籍『100万円損しないリフォーム』の読者の方は「個別相談希望」とお送りください）\n・外壁修繕・業者選びのご相談\n\nご希望の方は「相談希望」とお送りください。日程を調整いたします。\n\n※ はじめにお伝えしておきます。私はdoTERRA ウェルネスアドボケート（佐藤勝保）です。ご希望があれば、doTERRAの精油などアロマ製品の購入方法や、会員登録（登録料などのご負担が生じます）についてもご案内します。ただし、私のほうから勧誘することはありません。香りの話だけで終えていただいて構いません。\n\nカツヤス',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 🔴【一時無効化 2026-08-23】合言葉「ミネラル」「PHOSSIL」「フォッシル」の分岐
  //
  // 無効化の理由：
  //   rules/compliance.md §7-3「肌への塗布・飲用は扱わない（当面）」に抵触する。
  //   返信文の「私はミネラル補給（PHOSSIL）を習慣にしています」は飲用（内服）の
  //   紹介にあたる。§7-3 は「飲用を示唆する表現は扱わない（食品としての承認の有無が
  //   未確認のため）」と定めており、これは効能表現（層2）とは別軸の【用法】の制限である。
  //   したがって「効能を書いていないから大丈夫」「免責文を入れたから大丈夫」は成立せず、
  //   文言の修正では適法にできない。CEO裁定＝当面休眠。
  //
  // 復活の条件：
  //   PHOSSIL（対象製品）が日本で【食品】として流通・販売できる承認・区分であることが
  //   確認できたら復活してよい。確認が取れた時点で rules/compliance.md §7-3 の「留保」を
  //   見直したうえで、下のコメントを外す（コードは消していない）。
  //   参照：rules/compliance.md §7-3 ／ strategy/compliance_mlm_story_2026-08.md C-1
  //
  // 無効化中の振る舞い：
  //   「ミネラル」等が送られてもこの分岐は発火せず、以降の分岐にも当たらないため
  //   デフォルト返信（defaultReplyText）が返る。classify() は 'fallback' を返すので
  //   オーナーに「🔕 取りこぼし」通知が飛ぶ＝人が拾える。エラーにも無反応にもならない。
  // ═══════════════════════════════════════════════════════════════
  // // 【流入元】Instagram投稿②「ミネラルが足りてなかった話」doTERRA PHOSSIL
  // // 合言葉: 「ミネラル」
  // if (text.includes('ミネラル') || text.includes('PHOSSIL') || text.includes('フォッシル')) {
  //   return {
  //     type: 'flex',
  //     altText: '50代昭和男子のセルフケア記録をお届けします',
  //     contents: {
  //       type: 'bubble',
  //       hero: {
  //         type: 'box',
  //         layout: 'vertical',
  //         contents: [
  //           { type: 'text', text: '🌿 セルフケア実験記録', weight: 'bold', size: 'xl', color: '#2E7D32' },
  //           { type: 'text', text: '50代昭和男子の、ささやかな自己メンテ', size: 'sm', color: '#888888', margin: 'sm', wrap: true },
  //         ],
  //         paddingAll: '20px',
  //         backgroundColor: '#E8F5E9',
  //       },
  //       body: {
  //         type: 'box',
  //         layout: 'vertical',
  //         contents: [
  //           {
  //             type: 'text',
  //             text: '投稿や記事を見ていただきありがとうございます。\n\n家というのは、見えない土台（基礎・鉄筋）が一番大事です。体も同じではないかと思い、私はミネラル補給（PHOSSIL）を習慣にしています。\n\n劇的に元気になった、というような話ではありません。「土台の材料をちゃんと入れている」という安心感の話です。\n\n※これはサプリメント（食品）に関するお話です。病気を治すものでも、効果を約束するものでもありません。あくまで一人の体験記録としてお読みください。\n\nカツヤス',
  //             wrap: true,
  //             size: 'sm',
  //           },
  //         ],
  //         paddingAll: '20px',
  //       },
  //       footer: {
  //         type: 'box',
  //         layout: 'vertical',
  //         contents: [
  //           {
  //             type: 'button',
  //             action: { type: 'uri', label: 'doTERRAを見てみる', uri: 'https://office.doterra.com/katuyasusatou' },
  //             style: 'primary',
  //             color: '#2E7D32',
  //           },
  //         ],
  //       },
  //     },
  //   };
  // }

  // 【合言葉】『50代男の体を“建て直す”』読者特典・自己診断16項目チェックシート
  // 合言葉: 「体の点検」「からだの点検」「カラダの点検」「体のてんけん」
  // テキスト本文（あいさつ＋チェックシート）＋ PDF版ダウンロードボタン（Flex）の2通で返す
  if (
    text.includes('体の点検') ||
    text.includes('からだの点検') ||
    text.includes('カラダの点検') ||
    text.includes('体のてんけん')
  ) {
    return [
      {
        type: 'text',
        text:
          '合言葉、ありがとうございます。\n' +
          '『50代男の体を“建て直す”』を読んでくださって、また興味を持ってくださって、ありがとうございます。\n' +
          '\n' +
          'お約束の読者特典「自己診断16項目チェックシート」をお届けします。建物の現況調査と同じで、まずは今の自分の状態を正直に把握するところから始めましょう。当てはまる項目に □ をつけて、合計点を数えてみてください。各項目1点です。\n' +
          '\n' +
          '【睡眠のこと（各1点）】\n' +
          '□ 寝付きが悪い（30分以上かかる）\n' +
          '□ 夜中に目が覚める（週3回以上）\n' +
          '□ 朝起きたとき体が重い\n' +
          '□ 昼間に強い眠気が来る\n' +
          '\n' +
          '【体型・体重のこと（各1点）】\n' +
          '□ ウエストが10年前より10cm以上増えた\n' +
          '□ 体重が10年前より7kg以上増えた\n' +
          '□ 膝・腰の痛みが慢性化している\n' +
          '□ 健康診断で「経過観察」項目が増えた\n' +
          '\n' +
          '【仕事ぶりのこと（各1点）】\n' +
          '□ 仕事の集中力が以前より明らかに落ちた\n' +
          '□ 新しいことを覚えるのが遅くなった\n' +
          '□ やる気が朝から出ない日が週3日以上ある\n' +
          '□ 以前できていた量の仕事が、時間内に終わらない\n' +
          '\n' +
          '【気分・気持ちのこと（各1点）】\n' +
          '□ 怒りのコントロールが難しくなってきた\n' +
          '□ 将来への不安が以前より強い\n' +
          '□ 趣味や楽しみへの興味が薄れた\n' +
          '□ 孤独を感じる場面が増えた\n' +
          '\n' +
          '【診断結果の読み方】\n' +
          '0〜3点：要注意フェーズ。まだ大きな問題はありませんが、細かいひびは始まっています。今のうちに手を打てば最小限で済みます。\n' +
          '4〜8点：修繕着手フェーズ。複数の場所が同時に傷み始めています。一つずつ順番に手を入れていきましょう。\n' +
          '9〜12点：大規模改修フェーズ。中身を一度すっかり入れ替えるくらいのつもりで取り組む段階です。立て直しは十分できます。\n' +
          '13点以上：まず専門家へ。セルフケアだけでは追いつかない可能性があります。無理せず、医療機関にご相談ください。\n' +
          '\n' +
          'これはあくまで自己診断（セルフチェック）です。診断や治療の代わりになるものではありません。気になる点があれば、かかりつけ医にご相談ください。\n' +
          '\n' +
          '下に、印刷して使えるPDF版もご用意しました。よろしければお手元に保存してお使いください。\n' +
          '\n' +
          'カツヤス',
      },
      {
        type: 'flex',
        altText: '自己診断16項目チェックシート（PDF版）をお届けします',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: '📋 自己診断16項目チェックシート', weight: 'bold', size: 'md', color: '#0C2448', wrap: true },
              { type: 'separator', margin: 'md' },
              {
                type: 'text',
                text: '上のチェックシートのPDF版です。印刷して、点数を書き込みながらお使いいただけます。半年後にもう一度やってみると、ご自分の変化が見えてきます。',
                wrap: true,
                margin: 'md',
                size: 'sm',
              },
            ],
            paddingAll: '20px',
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                action: { type: 'uri', label: '📋 チェックシート（PDF）を開く', uri: 'https://kind-cooperation-production.up.railway.app/present/checklist_taino_tenken.pdf' },
                style: 'primary',
                color: '#0C2448',
              },
            ],
          },
        },
      },
    ];
  }

  // 【合言葉】『俺の会社のCEOは、AIです。』読者プレゼント
  // 合言葉: 「AI社長」「AIシャチョウ」「ＡＩ社長」（全角A）「エーアイ社長」
  // 返すのは「会社の憲法テンプレート」全文（コピーして使うのでプレーンテキスト）
  if (
    text.includes('AI社長') ||
    text.includes('ＡＩ社長') ||
    text.includes('AIシャチョウ') ||
    text.includes('ＡＩシャチョウ') ||
    text.includes('エーアイ社長')
  ) {
    return {
      type: 'text',
      text:
        '合言葉、ありがとうございます。約束の「会社の憲法」テンプレートをお渡しします。\n' +
        '\n' +
        'これは雛形です。【　】の中をあなたの言葉に置き換えて、全文をコピーし、AIに一番最初に渡してください。それだけで、あなたのAI社長が動き始めます。完璧を狙わず、まず短く埋めて、使いながら足していけば十分です。\n' +
        '\n' +
        '※このテンプレートは、普通のチャット版のAIでも、Claude Codeでも使えます。AIに「社長としての役割」を教える土台です。ただし、絵や動画づくり、自動の投稿まで任せたい場合は、『Claude Code』と、いくつかの下準備が必要になります。まずは「考えて相談に乗ってくれる社長」として使い始めて、できることを少しずつ増やしていってください。\n' +
        '\n' +
        '──────────\n' +
        '【会社の憲法】\n' +
        '\n' +
        '１．名前\n' +
        'あなたの名前は【フク】です。私はこれからこの名前で呼びます。\n' +
        '\n' +
        '２．役割\n' +
        'あなたは私の会社のCEO（社長）です。指示を待つ道具ではなく、社長として自分で判断し、提案してください。必要なら私に反論してもかまいません。ただし最終決定は、オーナーの私がします。\n' +
        '\n' +
        '３．誰に、何を\n' +
        '私の会社は【　　　　】な人に向けて、【　　　　】を届けます。（誰に・何を、を埋めてください）\n' +
        '\n' +
        '４．やってはいけないこと\n' +
        '・健康や効果を「治る」「効く」と言い切らない（法律のルールです）\n' +
        '・私の個人情報やパスワードを外に出さない\n' +
        '・【自分の禁止事項】\n' +
        '\n' +
        '５．判断は人間が握る\n' +
        '次の二つは私が決めます。\n' +
        '・何を作るかという企画\n' +
        '・世に出す前の最終判断\n' +
        'これ以外の手を動かす作業は、どんどん任せます。\n' +
        '\n' +
        '６．仕事の四ステップ（順番を飛ばさない）\n' +
        '①私とあなたで何を作るか決める\n' +
        '②あなたが作る\n' +
        '③あなたが一度チェックする\n' +
        '④最後に私が確かめ、出すか判断する\n' +
        '\n' +
        '７．コツ\n' +
        '最初から完璧を狙わず、短く書いてまず動かし、走りながら直す。失敗したら決まりを一つ書き足す。\n' +
        '──────────\n' +
        '\n' +
        '使い方は、上の【　】をあなたの言葉に書き換えて、まるごとコピーし、AIに最初に渡すだけです。\n' +
        '\n' +
        'パソコンの苦手な五十代の私でも、ここまで来られました。次は、あなたの番です。下手でもいい、まず一歩。一緒にAI社長と新しい仕事を始めましょう。応援しています。\n' +
        '\n' +
        '作・カツヤス（『俺の会社のCEOは、AIです。』読者特典）',
    };
  }

  // 【合言葉】『タルムードに学ぶ AI時代のお金の教科書』読者特典・小冊子PDF
  // 合言葉: 「箱舟」「はこぶね」「ハコブネ」「方舟」
  // テキスト本文（あいさつ＋小冊子のご案内）＋ PDFダウンロードボタン（Flex）の2通で返す
  if (
    text.includes('箱舟') ||
    text.includes('はこぶね') ||
    text.includes('ハコブネ') ||
    text.includes('方舟')
  ) {
    return [
      {
        type: 'text',
        text:
          '合言葉、ありがとうございます。\n' +
          '『タルムードに学ぶ AI時代のお金の教科書』を読んでくださって、ありがとうございます。\n' +
          '\n' +
          'お約束の小冊子「AIとの壁打ちのやり方 ── あなたのための答えを、AIからもらう」をお届けします。\n' +
          '\n' +
          'これは、コピペして使えるプロンプト集ではありません。同じ言葉を貼り付ければ、みんな同じ答えが返ってくるだけです。そうではなく、AIと壁打ちをして「あなたの事情に合った答え」を引き出すやり方をまとめました。\n' +
          '\n' +
          'お読みになって、試してみて、うまくいかなかった話があれば、ぜひこのトークに送ってください。うまくいった話と同じくらい、うまくいかなかった話を歓迎します。私も五十代から手探りで始めた口です。\n' +
          '\n' +
          '下のボタンから小冊子（PDF）を開けます。お手元に保存してお使いください。\n' +
          '\n' +
          'カツヤス',
      },
      {
        type: 'flex',
        altText: '小冊子「AIとの壁打ちのやり方」（PDF）をお届けします',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: '📖 AIとの壁打ちのやり方', weight: 'bold', size: 'md', color: '#1E3A5F', wrap: true },
              { type: 'text', text: 'あなたのための答えを、AIからもらう', size: 'sm', color: '#888888', margin: 'sm', wrap: true },
              { type: 'separator', margin: 'md' },
              {
                type: 'text',
                text: '『タルムードに学ぶ AI時代のお金の教科書』の読者特典です。プロンプト集ではなく、AIと相談しながらご自分の答えを見つけていくための小冊子です。印刷してもお読みいただけます。',
                wrap: true,
                margin: 'md',
                size: 'sm',
              },
            ],
            paddingAll: '20px',
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                action: { type: 'uri', label: '📖 小冊子を受け取る（無料）', uri: 'https://kind-cooperation-production.up.railway.app/present/kabeuchi_no_yarikata.pdf' },
                style: 'primary',
                color: '#1E3A5F',
              },
            ],
          },
        },
      },
    ];
  }

  // デフォルト返信
  return {
    type: 'text',
    text: defaultReplyText(userName),
  };
}

// getReply() のデフォルト返信の文面を作る。classify() の「どの分岐にも当たらない」判定で
// getReply() の出力と比較するために、文面をここに一本化しておく（二重管理を避ける）。
function defaultReplyText(userName) {
  return `${userName}さん、メッセージありがとうございます。\n\nKindle本またはnote記事から来てくださった方は、本や記事の中に書いてある「合言葉」をそのままお送りください。\nその本・記事専用のプレゼントをお届けします。\n\nカツヤス`;
}

// ── メッセージの分類（オーナー通知の要否判定専用。getReply()の戻り値の形は変えない）──
// ・'soudan_apply'　　　：相談の申込みが完了した（＝申込通知の対象。リフォーム個別相談の
// 　　　　　　　　　　　　「個別相談希望」もここに含む。"個別相談希望".includes('相談希望') が
// 　　　　　　　　　　　　真になるため、意図してこの判定に含めている）
// ・'doterra_interest'　：本文にdoTERRA/ドテラ関連の語を含む（＝ブランド名を自分から書いた
// 　　　　　　　　　　　　関心層。通知の対象。快眠・アロマ本など「本の読者」だけの語では
// 　　　　　　　　　　　　拾わない＝ノイズと無料枠を抑えるためのCEO判断）
// ・'fallback'　　　　　：どの合言葉にも当たらず、デフォルトの定型文が返された（＝取りこぼし通知の対象）
// ・null　　　　　　　　：それ以外（通知しない）
//
// 判定優先順位（上が強い）：soudan_apply → doterra_interest → fallback → null
//
// 「相談希望」分岐の条件式は、getReply() 内の同分岐と完全に同じものにする。
// 「どの分岐にも当たらない」の判定は、全分岐の条件を並べて否定する二重管理を避けるため、
// getReply() を実際に呼び出し、その結果がデフォルト文面（defaultReplyText）と一致するかで判定する。
function classify(text) {
  if (text.includes('相談希望') || text.includes('そうだん希望')) {
    return 'soudan_apply';
  }

  if (text.includes('doTERRA') || text.includes('ドテラ') || text.includes('どてら')) {
    return 'doterra_interest';
  }

  const probeName = '__classify_probe__';
  const probeReply = getReply(text, probeName, null);
  if (
    !Array.isArray(probeReply) &&
    probeReply &&
    probeReply.type === 'text' &&
    probeReply.text === defaultReplyText(probeName)
  ) {
    return 'fallback';
  }

  return null;
}

// ── オーナーへの通知（push） ─────────────────────────────
// 個別相談の申込み・取りこぼしメッセージを、オーナー本人のLINEトークへ1通pushする。
// 【設計上の制約】通知の失敗が相談者への返信を絶対に巻き込まないこと。
//   → 呼び出し元では必ず safeReply() の後に呼ぶ。ここでは必ず try/catch し、例外を外に投げない。
const notifyCounter = { date: '', count: 0 };
const NOTIFY_DAILY_LIMIT = 30;

// 日本時間の「今日の日付」を日次上限リセット判定用に返す（Railwayのサーバー時刻はUTCのため明示指定）
function todayJST() {
  return new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

// 通知文に載せる「日本時間の日時（YYYY-MM-DD HH:MM）」
function nowJSTDisplay() {
  return new Date()
    .toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace(/\//g, '-');
}

// 戻り値（呼び出し側は無視してよい。既存の呼び出しはすべて戻り値を使わない）：
//   成功              : { ok: true }
//   送信失敗          : { ok: false, reason: 'send_failed', detail: <エラーメッセージ文字列> }
//   日次上限に達している: { ok: false, reason: 'daily_limit' }
//   OWNER_USER_ID 未設定: { ok: false, reason: 'not_configured' }
async function notifyOwner(text) {
  if (!process.env.OWNER_USER_ID) return { ok: false, reason: 'not_configured' }; // 未設定なら通知は黙って無効（通常動作には影響しない）

  try {
    const today = todayJST();
    if (notifyCounter.date !== today) {
      notifyCounter.date = today;
      notifyCounter.count = 0;
    }
    if (notifyCounter.count >= NOTIFY_DAILY_LIMIT) {
      pushLog({ kind: 'notify_skipped_limit', date: today, count: notifyCounter.count });
      return { ok: false, reason: 'daily_limit' };
    }
    notifyCounter.count += 1;

    await client.pushMessage({
      to: process.env.OWNER_USER_ID,
      messages: [{ type: 'text', text }],
    });
    return { ok: true };
  } catch (e) {
    console.error('[NOTIFY] pushMessage failed:', e && e.message);
    pushLog({ kind: 'notify_error', error: e && e.message });
    return { ok: false, reason: 'send_failed', detail: e && e.message };
  }
}

// 本文の先頭60字に切り詰める（60字を超えたら末尾に …）。取りこぼし通知・ドテラ関心通知で共用。
function truncateBody(text) {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

// 申込通知の文面（相談希望・個別相談希望のいずれの合言葉にも反応する共通文面）
// ※「① 相談内容 ② 希望日程 ③ 形式」の案内は、リフォーム個別相談（予約フォーム案内）では
// 　起こらないため、両方の場合に当てはまる書き方にしている（案内の重複は相談者側の受付
// 　メッセージに既にあるため、通知では省く）。
function buildSoudanApplyNotifyText(userName) {
  return (
    '🔔 個別相談のお申し込みが入りました\n\n' +
    `お名前：${userName}\n` +
    `受信：${nowJSTDisplay()}\n\n` +
    'LINEの公式アカウントのトークを開いて\n' +
    '内容をご確認ください。\n' +
    '（返信は当日〜翌日中とお伝えしています）'
  );
}

// ドテラ関心通知の文面（本文にdoTERRA/ドテラ関連の語を含んでいたとき）
function buildDoterraInterestNotifyText(userName, text) {
  return (
    '🌿 ドテラに関心のある方からメッセージが届きました\n\n' +
    `お名前：${userName}\n` +
    `受信：${nowJSTDisplay()}\n` +
    `本文：${truncateBody(text)}\n\n` +
    'Botは自動返信を返しています。\n' +
    '声をおかけするかどうか、トークを開いてご判断ください。'
  );
}

// 取りこぼし通知の文面（どの合言葉にも当たらずデフォルト文面を返したとき）
function buildFallbackNotifyText(userName, text) {
  const trimmed = truncateBody(text);
  return (
    '🔕 Botが答えられないメッセージが届きました\n\n' +
    `お名前：${userName}\n` +
    `受信：${nowJSTDisplay()}\n` +
    `本文：${trimmed}\n\n` +
    '合言葉に当たらなかったため、定型文を返しています。\n' +
    '必要ならトークを開いてご返信ください。'
  );
}

// ── 通知テスト ──────────────────────────────────────────
// オーナーが1人で「OWNER_USER_ID の登録が正しいか」を自己診断するための機能。
// push（テスト通知本文）
function buildNotifyTestPushText() {
  return (
    '🔔 通知テスト\n\n' +
    'これはテスト通知です。\n' +
    'このメッセージが届いていれば、\n' +
    '個別相談のお申し込みも同じようにここへ届きます。\n\n' +
    `受信：${nowJSTDisplay()}`
  );
}

// reply（オーナー本人への診断結果）。notifyOwner() の戻り値から出し分ける。
// ※ reason: 'not_configured' はこの分岐に入らない設計のため、他の失敗理由と同じ
// 　「送信に失敗しました」表示にフォールバックする（詳細は detail 欄で判別可能）。
function buildNotifyTestReplyMessage(result) {
  if (result && result.ok) {
    return {
      type: 'text',
      text:
        '✅ 通知テスト：送信に成功しました\n\n' +
        'このトークに、いまテスト通知を1通送りました。\n' +
        '数秒のうちに届いていれば、通知の設定は正しく完了しています。\n\n' +
        '（OWNER_USER_ID の値も正しく登録されています）',
    };
  }

  if (result && result.reason === 'daily_limit') {
    return {
      type: 'text',
      text:
        '⚠️ 通知テスト：本日の上限に達しています\n\n' +
        '通知は1日30通までに制限しています。\n' +
        '日付が変わればまた送れます。',
    };
  }

  const detail = (result && result.detail) || '不明なエラー';
  return {
    type: 'text',
    text:
      '❌ 通知テスト：送信に失敗しました\n\n' +
      `理由：${detail}\n\n` +
      '考えられる原因：\n' +
      '・LINE公式アカウントの無料メッセージ枠を使い切っている\n' +
      '・チャネルアクセストークンの期限切れ\n\n' +
      'この画面をフクにお見せください。',
  };
}

// ── ヘルスチェック ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.10.1',
    updated: '2026-08-23',
    secret_set: !!config.channelSecret,
    token_set: !!config.channelAccessToken,
    debug_log_size: debugLog.length,
    owner_notify: !!process.env.OWNER_USER_ID,
  });
});

// ── デバッグログ閲覧（シンプルなトークンガード）───────────
// 使い方: /debug/log?token=<DEBUG_TOKEN>
// DEBUG_TOKEN 未設定なら 404 にしてエンドポイント自体を隠す。
app.get('/debug/log', (req, res) => {
  const required = process.env.DEBUG_TOKEN;
  if (!required) {
    return res.status(404).json({ error: 'not found' });
  }
  if (req.query.token !== required) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({
    version: '2.10.1',
    count: debugLog.length,
    entries: debugLog,
  });
});

// ── サーバー起動 ────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LINE Bot v2.10.1 起動中: http://localhost:${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
