// 合言葉「確認リスト」の試験。実行: node test/test_kakunin_list.js
// 『マンガでわかる 住宅ローン破綻』読者特典「わが家の住宅ローン 確認リスト」（2026-11-26）。
// 実サーバー（index.js の app）に署名付きwebhookを送り、返信・オーナー通知・既存合言葉の回帰を確かめる。
process.env.LINE_CHANNEL_SECRET = 'test_secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
process.env.OWNER_USER_ID = 'U_OWNER_TEST';
process.env.FRIEND_LIST_TOKEN = 'list_token_for_test';
process.env.DEBUG_TOKEN = 'debug_token_for_test';
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakunin_test_'));
process.env.STEP_DATA_DIR = tmp;
const stub = require('./stubLine');
const friendList = require('../friendList');
const { app } = require('../index');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sendWebhook(port, events) {
  const body = JSON.stringify({ destination: 'Utest', events });
  const sig = crypto.createHmac('SHA256', 'test_secret').update(body).digest('base64');
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method: 'POST', path: '/webhook', headers: { 'x-line-signature': sig, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(body); req.end();
  });
}
const msg = (u, t) => ({ type: 'message', replyToken: 'rt', source: { type: 'user', userId: u }, message: { type: 'text', id: '1', text: t } });
const lastReplyText = () => { const r = stub.calls.reply[stub.calls.reply.length - 1]; return r.messages.map((m) => m.text || JSON.stringify(m)).join('\n'); };
const pushTextsSince = (n) => stub.calls.push.slice(n).map((p) => p.messages.map((m) => m.text || '').join('\n'));
const BOOK = '『マンガでわかる 住宅ローン破綻』';
const PDF = 'kakunin_list_jutaku_loan.pdf';
const lastReply = () => stub.calls.reply[stub.calls.reply.length - 1];

(async () => {
  friendList.init();
  const server = app.listen(0); const port = server.address().port;
  for (const u of ['U_A', 'U_B', 'U_C', 'U_D', 'U_E', 'U_F', 'U_G']) stub.profiles[u] = u + '(試験)';

  // K1 表記ゆれで本文＋PDFボタンの2通が返る
  for (const [u, t] of [['U_A', '確認リスト'], ['U_B', 'かくにんリスト'], ['U_C', 'カクニンリスト']]) {
    const n = stub.calls.reply.length;
    await sendWebhook(port, [msg(u, t)]); await sleep(150);
    const r = lastReply();
    ok(stub.calls.reply.length === n + 1 && r.messages.length === 2 && r.messages[0].text.includes(BOOK) && JSON.stringify(r.messages[1]).includes(PDF), `K1 「${t}」で本文＋PDFボタン`, lastReplyText().slice(0, 80));
  }
  ok(friendList._getRecordForTest('U_A').entry === '確認リスト', 'K2 名簿の入口＝確認リスト', friendList._getRecordForTest('U_A'));

  // K3 「確認リストと相談」は相談メニューではなく特典が渡る
  await sendWebhook(port, [msg('U_D', '確認リストがほしいです。相談もしたい')]); await sleep(150);
  ok(JSON.stringify(lastReply().messages).includes(PDF), 'K3 相談の語があっても特典が渡る');

  // K4 「チェックリスト」（貧乏脳）は従来どおりで、確認リストの文は出ない
  await sendWebhook(port, [msg('U_E', 'チェックリスト')]); await sleep(150);
  ok(!lastReplyText().includes(BOOK) && lastReplyText().includes('金持ち脳'), 'K4 「チェックリスト」は貧乏脳のまま', lastReplyText().slice(0, 60));

  // K5 PDFが /present で配信される
  const st = await new Promise((res) => http.get({ port, path: '/present/' + PDF }, (r) => { r.resume(); res([r.statusCode, r.headers['content-type']]); }));
  ok(st[0] === 200 && /pdf/.test(st[1]), 'K5 PDFが200で返る', st);

  // 回帰：既存の合言葉は確認リストの文を返さない
  for (const t of ['残価', '宅建', '宅建6', '箱舟', '体の点検', 'AI社長', '香り', '快眠', 'リフォーム本', '名刺', '相談', '図面']) {
    const n = stub.calls.reply.length;
    await sendWebhook(port, [msg('U_F', t)]); await sleep(150);
    ok(stub.calls.reply.length === n + 1 && !lastReplyText().includes(BOOK), `R 「${t}」は従来の返信`, lastReplyText().slice(0, 60));
  }
  await sendWebhook(port, [msg('U_G', 'こんにちは')]); await sleep(150);
  ok(lastReplyText().includes('が見つかりませんでした'), 'R2 無関係な文は従来のデフォルト返信');

  // 返信文の体裁
  const t = stub.calls.reply.map((r) => r.messages.map((m) => m.text || '').join('\n')).find((x) => x.includes(BOOK));
  ok(!t.includes('---') && !/必ず|確実|絶対|保証|治る|効く/.test(t), 'S1 罫線なし・確約語なし');
  ok(t.split('\n').every((l) => l.length <= 100), 'S2 1行100字以内');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n結果: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
