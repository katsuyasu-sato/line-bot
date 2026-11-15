// 合言葉「残価」の試験。実行: node test/test_zanka.js
// 『マンガでわかる 残価設定型住宅ローンの落とし穴』巻末の無料相談の受付（2026-11-15）。
// 実サーバー（index.js の app）に署名付きwebhookを送り、返信・オーナー通知・既存合言葉の回帰を確かめる。
process.env.LINE_CHANNEL_SECRET = 'test_secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
process.env.OWNER_USER_ID = 'U_OWNER_TEST';
process.env.FRIEND_LIST_TOKEN = 'list_token_for_test';
process.env.DEBUG_TOKEN = 'debug_token_for_test';
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zanka_test_'));
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
const BOOK = '『マンガでわかる 残価設定型住宅ローンの落とし穴』';

(async () => {
  friendList.init();
  const server = app.listen(0); const port = server.address().port;
  for (const u of ['U_A', 'U_B', 'U_C', 'U_D', 'U_E', 'U_F']) stub.profiles[u] = u + '(試験)';

  // Z1 3表記で受付文が返り、オーナーに「残価」の通知が1通だけ届く
  for (const [u, t] of [['U_A', '残価'], ['U_B', 'ざんか'], ['U_C', 'ザンカ']]) {
    const n = stub.calls.reply.length, p = stub.calls.push.length;
    await sendWebhook(port, [msg(u, t)]); await sleep(150);
    ok(stub.calls.reply.length === n + 1 && lastReplyText().includes(BOOK) && lastReplyText().includes('無料相談の受付'), `Z1 「${t}」で受付文が返る`, lastReplyText().slice(0, 80));
    const pushes = pushTextsSince(p).filter((x) => x.includes('残価設定型住宅ローンの本の読者から無料相談'));
    ok(pushes.length === 1 && stub.calls.push.slice(p).every((x) => x.to === 'U_OWNER_TEST'), `Z2 「${t}」でオーナーに通知が1通`, pushTextsSince(p));
  }

  // Z3 「残価の相談です」は相談メニューではなく残価の受付が勝つ（通知も残価）
  {
    const p = stub.calls.push.length;
    await sendWebhook(port, [msg('U_D', '残価の相談です')]); await sleep(150);
    ok(lastReplyText().includes(BOOK), 'Z3 「残価の相談です」は残価の受付文', lastReplyText().slice(0, 80));
    ok(pushTextsSince(p).filter((x) => x.includes('残価設定型住宅ローンの本')).length === 1 && !pushTextsSince(p).some((x) => x.includes('入口の合言葉：「相談」')), 'Z4 残価の通知は1通・入口は「相談」にならない', pushTextsSince(p));
    ok(friendList._getRecordForTest('U_D').entry === '残価', 'Z4b 名簿の入口＝残価', friendList._getRecordForTest('U_D'));
  }

  // Z5 オーナー本人が送っても通知しない
  {
    const p = stub.calls.push.length;
    await sendWebhook(port, [msg('U_OWNER_TEST', '残価')]); await sleep(150);
    ok(lastReplyText().includes(BOOK) && stub.calls.push.length === p, 'Z5 オーナー本人には返信だけ・通知なし');
  }

  // Z6 「図面」の無料相談セッション中に「残価」と送っても、図面のセッションが受け止める（従来どおり）
  await sendWebhook(port, [msg('U_E', '図面')]); await sleep(150);
  ok(lastReplyText().includes('マンガ図面の向こう側'), 'Z6a 図面の受付');
  await sendWebhook(port, [msg('U_E', '残価')]); await sleep(150);
  ok(!lastReplyText().includes(BOOK), 'Z6b 図面のセッション中は残価に切り替わらない', lastReplyText().slice(0, 80));

  // 回帰：既存の合言葉は残価の文を返さない
  for (const t of ['宅建', '宅建6', '箱舟', '体の点検', 'AI社長', '香り', '快眠', 'リフォーム本', '名刺', '相談']) {
    const n = stub.calls.reply.length;
    await sendWebhook(port, [msg('U_F', t)]); await sleep(150);
    ok(stub.calls.reply.length === n + 1 && !lastReplyText().includes(BOOK), `R 「${t}」は従来の返信で残価の文は出ない`, lastReplyText().slice(0, 60));
  }
  await sendWebhook(port, [msg('U_F', 'こんにちは')]); await sleep(150);
  ok(lastReplyText().includes('が見つかりませんでした'), 'R2 無関係な文は従来のデフォルト返信');

  // 返信文の体裁
  const t = stub.calls.reply.map((r) => r.messages.map((m) => m.text || '').join('\n')).find((x) => x.includes(BOOK));
  ok(!t.includes('---') && !/必ず|確実|絶対|保証/.test(t) && t.includes('お勧めしたり'), 'S1 罫線なし・確約語なし・商品を勧めない断り書きあり');
  ok(t.split('\n').every((l) => l.length <= 100), 'S2 1行100字以内');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n結果: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
