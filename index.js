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
  // ユーザー名を取得
  let userName = 'あなた';
  try {
    const profile = await client.getProfile(event.source.userId);
    userName = profile.displayName;
  } catch (e) {
    // 取得失敗時はデフォルト名を使用
  }

  // 友だち追加・ブロック解除 → プレゼント + キーワードメニュー（2通）
  if (event.type === 'follow') {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: welcomeMessages(userName),
    });
  }

  // テキストメッセージ処理
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const reply = getReply(text, userName);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [reply],
    });
  }
}

// ── ウェルカムメッセージ（2通送信） ───────────────────────
function welcomeMessages(userName) {
  return [giftMessage(userName), keywordMenuMessage()];
}

function giftMessage(userName) {
  return {
    type: 'flex',
    altText: '【登録プレゼント】アロマケアアプリを受け取ってください',
    contents: {
      type: 'bubble',
      hero: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🎁 登録プレゼント',
            weight: 'bold',
            size: 'xl',
            color: '#2E7D32',
          },
          {
            type: 'text',
            text: 'doTERRA アロマケアガイドアプリ（無料）',
            size: 'sm',
            color: '#555555',
            margin: 'sm',
          },
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
            text: `${userName}さん、友だち追加ありがとうございます！\n一級建築士カツヤスです。`,
            wrap: true,
            size: 'md',
            weight: 'bold',
          },
          {
            type: 'separator',
            margin: 'md',
          },
          {
            type: 'text',
            text: 'まず登録プレゼントを受け取ってください。\n\n症状や気分を選ぶだけで\nおすすめのオイルと使い方がわかる\n無料アプリです。\n\n✅ 希釈方法・量もすぐわかる\n✅ 加齢臭・疲労ケアも掲載\n✅ 購入リンクも完備',
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
              label: '🌿 アロマケアアプリを受け取る（無料）',
              uri: 'https://friendly-licorice-3bab23.netlify.app',
            },
            style: 'primary',
            color: '#2E7D32',
          },
        ],
      },
    },
  };
}

function keywordMenuMessage() {
  return {
    type: 'flex',
    altText: 'どこから来たか教えてください',
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
            text: '50代・副業実践中・昭和男子の等身大発信',
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
            text: '📌 どこから来たか教えてください',
            weight: 'bold',
            color: '#E6580C',
          },
          {
            type: 'text',
            text: '下のキーワードをそのまま送ってください。',
            size: 'sm',
            color: '#888888',
            margin: 'sm',
            wrap: true,
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            contents: [
              keyword('副業本', '「副業で1000万溶かした62歳」を読んだ'),
              keyword('アロマ本', '「快眠革命」などdoTERRA関連本を読んだ'),
              keyword('インスタ', 'Instagramを見て来た'),
              keyword('note', 'noteを読んで来た'),
              keyword('設計図', '人生設計図テンプレートがほしい'),
              keyword('外壁修繕', '外壁修繕診断アプリを使った'),
              keyword('相談', '個別相談を希望する'),
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
function getReply(text, userName) {

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
      type: 'flex',
      altText: 'アロマ・doTERRAの本から来てくれたか！',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '🌿 アロマ本を読んでくれたか！', weight: 'bold', size: 'md', color: '#2E7D32', wrap: true },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: '建築士がアロマにハマった理由、\n本には書けなかった話をここでする。\n\nまずは無料のアロマアプリを使ってみてくれ。\n症状を選ぶだけで、おすすめオイルと使い方が出てくる。\n\nカツヤス',
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
              action: { type: 'uri', label: '🌿 アロマアプリを使う（無料）', uri: 'https://friendly-licorice-3bab23.netlify.app' },
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

  // アロマアプリのプレゼント
  if (text.includes('アロマ') || text.includes('アプリ') || text.includes('プレゼント')) {
    return {
      type: 'flex',
      altText: 'アロマアプリをお受け取りください！',
      contents: {
        type: 'bubble',
        hero: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '🌿 アロマケアガイド', weight: 'bold', size: 'xl', color: '#2E7D32' },
            { type: 'text', text: 'doTERRAエッセンシャルオイル', size: 'sm', color: '#888888', margin: 'sm' },
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
              text: '症状を選ぶだけでおすすめオイルと\n使い方が出てくる無料アプリだ。\n\n✅ 希釈方法・量も全部わかる\n✅ 加齢臭ケアのオイルも掲載\n✅ 購入リンクも完備',
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
              action: { type: 'uri', label: '今すぐアプリを使う（無料）', uri: 'https://friendly-licorice-3bab23.netlify.app' },
              style: 'primary',
              color: '#2E7D32',
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
      altText: '【登録プレゼント】金持ち脳チェックリスト＋口癖変換カードをお届けします',
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
              text: '本を読んでくれてありがとう。\n\n登録プレゼントを2点用意した。\nスマホに保存して使ってくれ。',
              wrap: true,
              size: 'md',
              weight: 'bold',
            },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: '✅ A：金持ち脳チェックリスト\n　10項目で今の自分を確認できる\n\n✅ B：口癖変換カード\n　貧乏脳の言葉→金持ち脳の言葉に\n　1週間使うだけで思考が変わる',
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
                type: 'uri',
                label: '個別相談を希望する',
                uri: 'line://oaMessage/@491fsuyy/?相談',
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
            { type: 'text', text: '📘 リフォーム本を読んでくれてありがとう！', weight: 'bold', size: 'md', color: '#0C2448', wrap: true },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: '『100万円損しないリフォーム ─業者を見抜く7つの質問』を手に取ってくれてありがとう。\n\n下の「見積書チェックリスト」を、お手元の見積書とあわせて使ってくれ。本書で出てきた7つの質問が、見積書のどこに反映されているかを1項目ずつチェックできる。\n\n何か疑問があれば、このトークでメッセージを送ってくれ。一級建築士として30年の経験から、できる範囲で答える。\n\n佐藤勝保（カツヤス）',
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
              action: { type: 'uri', label: '個別相談を希望する', uri: 'line://oaMessage/@491fsuyy/?個別相談希望' },
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
              text: '個別相談のお問い合わせ、ありがとう。\n\n本相談は、本書『100万円損しないリフォーム』の7つの質問を、あなたのケースに沿って具体的に活用するためのお手伝いだ。\n\n■ 形式：オンライン（Zoom／Meet）または対面（神奈川県相模原市内の貸会議室）\n■ 時間：1案件 60分程度\n■ 料金：¥20,000（税込・モニター価格）\n\n下記の点をご了承ください：\n・特定業者の評価・推奨は行わない\n・最終的な業者選定・契約判断は相談者ご自身\n・建築士法上の「設計」「工事監理」は本相談に含まれない\n\n予約フォーム・規約はリンクから確認してくれ。',
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
      text: '📞 個別相談について\n\n以下の相談を受け付けている：\n・老後の資金・生き方相談\n・副業の始め方・失敗しない選び方\n・建築・リフォーム相談（書籍『100万円損しないリフォーム』読者の方は「個別相談希望」と送ってくれ）\n・外壁修繕・業者選び相談\n\n希望の方は「相談希望」と送ってくれ。\n日程を調整する。\n\nカツヤス',
    };
  }

  // デフォルト返信
  return {
    type: 'text',
    text: `${userName}さん、メッセージありがとうございます！\n\n下のキーワードをそのまま送ってもらえると、すぐに案内できます：\n\n「貧乏脳」または「金持ち脳」→ プレゼント2点をお届け\n「リフォーム本」→ 見積書チェックリストをお届け\n「副業本」→ 副業の続き話をお届け\n「アロマ本」→ アロマアプリをご案内\n「インスタ」→ Instagram発信の裏話\n「note」→ noteの続き話\n「外壁修繕」→ 外壁診断の補足説明\n「相談」→ 個別相談のご案内\n\nカツヤス`,
  };
}

// ── ヘルスチェック ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.1.0', updated: '2026-05-21' });
});

// ── サーバー起動 ────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LINE Bot v2.1.0 起動中: http://localhost:${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
