// ─────────────────────────────────────────────────────────
// カツヤス｜50代の人生設計 LINE Bot
// 機能: 自動返信・ウェルカムメッセージ・キーワード応答
// ─────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
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
    // ユーザー名は best-effort（失敗してもデフォルト）
    let userName = 'あなた';
    try {
      const profile = await client.getProfile(event.source.userId);
      if (profile && profile.displayName) userName = profile.displayName;
    } catch (e) {
      // 取得失敗は無視
    }
    const reply = getReply(text, userName);
    await safeReply(event.replyToken, [reply], 'message');
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
    text: '友だち追加ありがとうございます。\n一級建築士の佐藤勝保（カツヤス）です。\n\nKindle本またはnote記事から来てくださった方は、本や記事の中に書いてある「合言葉」をこのトークに送ってください。\nその本・記事専用のプレゼントをお届けします。\n\n佐藤勝保（カツヤス）／一級建築士・建築30年',
  };
}


// ── キーワード別返信 ────────────────────────────────────
function getReply(text, userName) {

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
              text: 'Kindle本『副業で1000万溶かした62歳』、またはnoteの記事から来てくださったかもしれません。\n\n1000万円を溶かした話を最後まで読んでいただき、ありがとうございます。恥をさらした甲斐がありました。\n\nこのLINEでは、本や記事には書けなかった続きの話をお届けしていきます。よろしくお願いします。\n\n佐藤勝保（カツヤス）\n一級建築士・建築30年',
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
      text: '📸 Instagramから来てくださりありがとうございます！\n\nInstagramでは日々発信していますが、\nこちらでは投稿に書けなかった本音の話をお届けします。\n\n引き続きよろしくお願いします。\n佐藤勝保（カツヤス）／一級建築士',
    };
  }

  // 【流入元】note
  if (text.includes('note') || text.includes('ノート')) {
    return {
      type: 'text',
      text: '📝 noteから来てくださりありがとうございます！\n\nnoteでは記事を書いていますが、\nこちらでは記事にならない生の話をお届けしていきます。\n\nよろしくお願いします。\n佐藤勝保（カツヤス）／一級建築士',
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
              text: '本や記事にご関心を持っていただきありがとうございます。\n\nKindle本『香りは、空間の第4の建材だった』、またはnoteの記事から来てくださった方へ、ご登録プレゼントとしてdoTERRAアロマケアガイドアプリ（無料）をご用意しました。\n\n症状や気分を選ぶだけで、おすすめのオイルと使い方が出てきます。建築士ならではの「空間×香り」という視点でもお使いいただけるアプリです。\n\n佐藤勝保（カツヤス）\n一級建築士・建築30年',
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
              action: { type: 'uri', label: '🌿 アロマアプリを受け取る（無料）', uri: 'https://friendly-licorice-3bab23.netlify.app' },
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
  if (text.includes('快眠') || text.includes('アロマ本') || text.includes('doTERRA') || text.includes('ドテラ')) {
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
              text: '本や記事にご関心を持っていただきありがとうございます。\n\nKindle本『働く50代の快眠革命』『朝まで眠れる私に変えた本』、またはnoteの記事から来てくださった方へ、ご登録プレゼントとしてdoTERRAアロマケアガイドアプリ（無料）をご用意しました。\n\n症状や気分を選ぶだけで、おすすめのオイルと使い方が出てきます。\n\n✅ 希釈方法・量もすぐにわかります\n✅ 加齢臭・疲労ケアも掲載しています\n✅ 購入リンクも完備しています\n\n佐藤勝保（カツヤス）\n一級建築士・建築30年',
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
              action: { type: 'uri', label: '🌿 アロマアプリを受け取る（無料）', uri: 'https://friendly-licorice-3bab23.netlify.app' },
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
              text: '4つの設計図テンプレートをご用意しております：\n\n✅ お金の設計図\n✅ 健康の設計図\n✅ 仕事・やりがいの設計図\n✅ 人間関係の設計図\n\n※ 現在準備中です。もうしばらくお待ちください。\n\n佐藤勝保（カツヤス）\n一級建築士',
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
              text: '一級建築士として30年、外壁を見てきた経験をもとに作ったアプリです。\n\n診断結果についてご不明な点があれば、お気軽にお尋ねください。\n・見積もりが適正か確認したい\n・業者選びに迷っている\n・修繕時期を相談したい\n\nどうぞ遠慮なくお送りください。\n\n佐藤勝保（カツヤス）\n一級建築士・建築30年',
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
              text: '✅ A：金持ち脳チェックリスト\n　10項目で今の自分を確認できます\n\n✅ B：口癖変換カード\n　貧乏脳の言葉→金持ち脳の言葉へ\n　1週間で思考が変わります\n\n佐藤勝保（カツヤス）\n一級建築士・建築30年',
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
              text: 'Kindle本『100万円損しないリフォーム ─業者を見抜く7つの質問』、またはnoteの記事から来てくださったかもしれません。\n\n下の「見積書チェックリスト」(PDF)を、お手元の見積書とあわせてお使いください。本書で紹介している7つの質問が、見積書のどこに反映されているかを1項目ずつチェックできます。\n\n何か疑問があれば、このトークでメッセージを送ってください。一級建築士として30年の経験から、できる範囲でお答えします。\n\n佐藤勝保（カツヤス）\n一級建築士',
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
              text: '個別相談のお問い合わせ、ありがとうございます。\n\n本相談は、書籍『100万円損しないリフォーム』の7つの質問を、ご相談者様のケースに沿って具体的に活用していただくためのお手伝いです。\n\n■ 形式：オンライン（Zoom／Meet）または対面（神奈川県相模原市内の貸会議室）\n■ 時間：1案件 60分程度\n■ 料金：¥20,000（税込・モニター価格）\n\n下記の点をご了承ください：\n・特定業者の評価・推奨は行いません\n・最終的な業者選定・契約判断はご相談者様ご自身となります\n・建築士法上の「設計」「工事監理」は本相談に含まれません\n\n予約フォーム・規約はリンクからご確認ください。\n\n佐藤勝保（カツヤス）\n一級建築士',
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
              action: { type: 'uri', label: '📋 予約フォームを開く', uri: 'https://friendly-licorice-3bab23.netlify.app/reform-consult.html' },
              style: 'primary',
              color: '#0C2448',
            },
          ],
        },
      },
    };
  }

  // 相談
  if (text.includes('相談') || text.includes('コンサル') || text.includes('個別')) {
    return {
      type: 'text',
      text: '📞 個別相談について\n\n以下のご相談を受け付けております：\n・老後の資金・生き方のご相談\n・副業の始め方・失敗しない選び方\n・建築・リフォームのご相談（書籍『100万円損しないリフォーム』の読者の方は「個別相談希望」とお送りください）\n・外壁修繕・業者選びのご相談\n\nご希望の方は「相談希望」とお送りください。日程を調整いたします。\n\n佐藤勝保（カツヤス）\n一級建築士・建築30年',
    };
  }

  // 【流入元】Instagram投稿②「ミネラルが足りてなかった話」doTERRA PHOSSIL
  // 合言葉: 「ミネラル」
  if (text.includes('ミネラル') || text.includes('PHOSSIL') || text.includes('フォッシル')) {
    return {
      type: 'flex',
      altText: '50代昭和男子のセルフケア記録をお届けします',
      contents: {
        type: 'bubble',
        hero: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '🌿 セルフケア実験記録', weight: 'bold', size: 'xl', color: '#2E7D32' },
            { type: 'text', text: '50代昭和男子の、ささやかな自己メンテ', size: 'sm', color: '#888888', margin: 'sm', wrap: true },
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
              text: '投稿や記事を見ていただきありがとうございます。\n\n家というのは、見えない土台（基礎・鉄筋）が一番大事です。体も同じではないかと思い、私はミネラル補給（PHOSSIL）を習慣にしています。\n\n劇的に元気になった、というような話ではありません。「土台の材料をちゃんと入れている」という安心感の話です。\n\n※これはサプリメント（食品）に関するお話です。病気を治すものでも、効果を約束するものでもありません。あくまで一人の体験記録としてお読みください。\n\n佐藤勝保（カツヤス）\n一級建築士・建築30年',
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
              action: { type: 'uri', label: 'doTERRAを見てみる', uri: 'https://office.doterra.com/katuyasusatou' },
              style: 'primary',
              color: '#2E7D32',
            },
          ],
        },
      },
    };
  }

  // デフォルト返信
  return {
    type: 'text',
    text: `${userName}さん、メッセージありがとうございます。\n\nKindle本またはnote記事から来てくださった方は、本や記事の中に書いてある「合言葉」をそのままお送りください。\nその本・記事専用のプレゼントをお届けします。\n\n佐藤勝保（カツヤス）／一級建築士・建築30年`,
  };
}

// ── ヘルスチェック ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.5.3',
    updated: '2026-06-04',
    secret_set: !!config.channelSecret,
    token_set: !!config.channelAccessToken,
    debug_log_size: debugLog.length,
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
    version: '2.5.3',
    count: debugLog.length,
    entries: debugLog,
  });
});

// ── サーバー起動 ────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LINE Bot v2.5.3 起動中: http://localhost:${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
