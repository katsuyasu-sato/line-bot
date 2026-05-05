// ─────────────────────────────────────────────────────────
// カツヤス｜50代の人生設計 LINE Bot
// 機能: 自動返信・ウェルカムメッセージ・キーワード応答
// ─────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

// ── Webhook エンドポイント ──────────────────────────────
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── イベント処理 ────────────────────────────────────────
async function handleEvent(event) {
  // 友だち追加・ブロック解除 → ウェルカムメッセージ
  if (event.type === 'follow') {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [welcomeMessage()],
    });
  }

  // テキストメッセージ処理
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const reply = getReply(text);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [reply],
    });
  }
}

// ── ウェルカムメッセージ ────────────────────────────────
function welcomeMessage() {
  return {
    type: 'flex',
    altText: 'カツヤスのLINEへようこそ！',
    contents: {
      type: 'bubble',
      hero: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: 'カツヤス｜一級建築士',
            weight: 'bold',
            size: 'lg',
            color: '#0C2448',
            wrap: true,
          },
          {
            type: 'text',
            text: '62歳・副業実践中・昭和男子の等身大発信',
            size: 'sm',
            color: '#888888',
            margin: 'sm',
          },
        ],
        paddingAll: '20px',
        backgroundColor: '#FFF9F0',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '友だち追加ありがとうございます！\n一級建築士カツヤスです。',
            wrap: true,
            size: 'md',
          },
          {
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'text',
            text: '📌 どこから来たか教えてください',
            margin: 'md',
            weight: 'bold',
            color: '#E6580C',
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'sm',
            contents: [
              keyword('副業本', '「副業で1000万溶かした62歳」を読んだ方'),
              keyword('アロマ本', '「快眠革命」などdoTERRA関連本を読んだ方'),
              keyword('インスタ', 'Instagramを見て来た方'),
              keyword('note', 'noteを読んで来た方'),
              keyword('設計図', '人生設計図テンプレートをもらいたい方'),
              keyword('外壁修繕', '外壁修繕診断アプリを使った方'),
              keyword('相談', '個別相談を希望する方'),
            ],
          },
        ],
        paddingAll: '20px',
      },
    },
  };
}

function keyword(word, desc) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      { type: 'text', text: `「${word}」`, size: 'sm', color: '#0C2448', weight: 'bold', flex: 2 },
      { type: 'text', text: `→ ${desc}`, size: 'sm', color: '#555555', flex: 5, wrap: true },
    ],
  };
}

// ── キーワード別返信 ────────────────────────────────────
function getReply(text) {

  // 【流入元】副業本
  if (text.includes('副業本') || text.includes('副業')) {
    return {
      type: 'flex',
      altText: '「副業で1000万溶かした62歳」を読んでくれてありがとう！',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '📖 副業本を読んでくれてありがとう！', weight: 'bold', size: 'md', color: '#0C2448', wrap: true },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: '1000万溶かした話、最後まで読んでくれたか。\n恥をさらした甲斐があった。\n\nこのLINEでは本には書けなかった続きの話をしていく。\nよろしくな。',
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
      text: '📸 Instagramから来てくれたか！\n\nInstagramでは毎日発信しているが、\nここでは投稿に書けなかった本音の話をする。\n\n引き続きよろしくな。\nカツヤス',
    };
  }

  // 【流入元】note
  if (text.includes('note') || text.includes('ノート')) {
    return {
      type: 'text',
      text: '📝 noteから来てくれたか！\n\nnoteでは記事を書いているが、\nここでは記事にならない生の話をしていく。\n\nよろしくな。\nカツヤス',
    };
  }

  // 【流入元】アロマ本・doTERRA
  if (text.includes('アロマ本') || text.includes('快眠') || text.includes('doTERRA') || text.includes('ドテラ')) {
    return {
      type: 'text',
      text: '🌿 アロマ・doTERRAの本から来てくれたか！\n\n建築士がアロマにハマった理由、\n本には書けなかった話をここでする。\n\nよろしくな。\nカツヤス',
    };
  }

  // 設計図テンプレート
  if (text.includes('設計図') || text.includes('テンプレート')) {
    return {
      type: 'flex',
      altText: '人生設計図テンプレートをお届けします！',
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
              text: '4つの設計図テンプレートを用意している：\n\n✅ お金の設計図\n✅ 健康の設計図\n✅ 仕事・やりがいの設計図\n✅ 人間関係の設計図\n\n※ 現在準備中。もう少し待ってくれ。',
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
      altText: '外壁修繕診断アプリから来てくれたか！',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '🏠 外壁修繕診断を使ってくれたか！', weight: 'bold', size: 'md', color: '#0C2448', wrap: true },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: '一級建築士として30年、外壁を見てきた俺が作ったアプリだ。\n\n診断結果について疑問があれば何でも聞いてくれ。\n・見積もりが適正か確認したい\n・業者選びに迷っている\n・修繕時期を相談したい\n\n遠慮なく送ってくれ。\nカツヤス',
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

  // 相談
  if (text.includes('相談') || text.includes('コンサル') || text.includes('個別')) {
    return {
      type: 'text',
      text: '📞 個別相談について\n\n以下の相談を受け付けている：\n・老後の資金・生き方相談\n・副業の始め方・失敗しない選び方\n・建築・リフォーム相談\n・外壁修繕・業者選び相談\n\n希望の方は「相談希望」と送ってくれ。\n日程を調整する。\n\nカツヤス',
    };
  }

  // デフォルト返信
  return {
    type: 'text',
    text: 'メッセージありがとうございます！\n\nどこから来てくれたか教えてほしい：\n\n「副業本」→ 副業で1000万の本を読んだ\n「アロマ本」→ doTERRA関連本を読んだ\n「インスタ」→ Instagramを見た\n「note」→ noteを読んだ\n「設計図」→ テンプレートがほしい\n「外壁修繕」→ 外壁修繕診断アプリを使った\n「相談」→ 個別相談したい\n\nカツヤス',
  };
}

// ── サーバー起動 ────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LINE Bot サーバー起動中: http://localhost:${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
