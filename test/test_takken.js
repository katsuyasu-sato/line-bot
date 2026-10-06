// 合言葉「宅建」の試験。実行: node test/test_takken.js
// 実サーバー（index.js の app）に署名付きwebhookを送り、返信・購読の記録・既存合言葉の回帰を確かめる。
process.env.LINE_CHANNEL_SECRET = 'test_secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
process.env.OWNER_USER_ID = 'U_OWNER_TEST';
process.env.FRIEND_LIST_TOKEN = 'list_token_for_test';
process.env.DEBUG_TOKEN = 'debug_token_for_test';
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'takken_test_'));
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

(async () => {
  friendList.init();
  const server = app.listen(0); const port = server.address().port;
  for (const u of ['U_A', 'U_B', 'U_C', 'U_D', 'U_E', 'U_F']) stub.profiles[u] = u + '(試験)';

  // 陽性対照＋3表記
  for (const [u, t] of [['U_A', '宅建'], ['U_B', 'たっけん'], ['U_C', 'タッケン']]) {
    const n = stub.calls.reply.length;
    await sendWebhook(port, [msg(u, t)]); await sleep(150);
    ok(stub.calls.reply.length === n + 1 && lastReplyText().includes('物語で頭に残る 宅建・民法 第1巻 総則') && lastReplyText().includes('第2巻以降の発売が決まりましたら'), `T1 「${t}」で受付メッセージが返る`);
    const rec = friendList._getRecordForTest(u);
    ok(rec && rec.subscriptions && rec.subscriptions.takken && rec.subscriptions.takken.at, `T2 「${t}」で購読が記録される`, rec);
    ok(rec.entry === '宅建', `T3 「${t}」で入口=宅建`, rec.entry);
  }
  // 同じ人が2回送っても購読は1件・日時は最初のまま
  const at1 = friendList._getRecordForTest('U_A').subscriptions.takken.at;
  await sendWebhook(port, [msg('U_A', '宅建')]); await sleep(150);
  ok(friendList._getRecordForTest('U_A').subscriptions.takken.at === at1, 'T4 2回送っても購読日時は最初のまま');
  ok(friendList.listSubscribers('takken').length === 3, 'T5 購読者一覧が3人', friendList.listSubscribers('takken').length);

  // 別の入口の人が後から宅建を送っても購読に入る（入口は上書きされない）
  await sendWebhook(port, [msg('U_D', '箱舟')]); await sleep(150);
  await sendWebhook(port, [msg('U_D', '宅建')]); await sleep(150);
  const d = friendList._getRecordForTest('U_D');
  ok(d.entry === '箱舟' && d.subscriptions.takken, 'T6 入口=箱舟のまま購読に入る', d);

  // ブロックした人は送信対象から外れる
  await sendWebhook(port, [{ type: 'unfollow', source: { type: 'user', userId: 'U_C' } }]); await sleep(100);
  ok(!friendList.listSubscribers('takken').some((s) => s.userId === 'U_C'), 'T7 ブロック中の人は購読者一覧に出ない');

  // 他の合言葉では購読されない／返信が変わらない（回帰）
  const regress = [['箱舟', '合言葉、ありがとうございます'], ['体の点検', null], ['AI社長', null], ['香り', null], ['快眠', null], ['リフォーム本', null], ['名刺', 'お名刺をお渡しした際に']];
  const sig = {};
  for (const [t] of regress) {
    const n = stub.calls.reply.length;
    await sendWebhook(port, [msg('U_E', t)]); await sleep(150);
    const txt = lastReplyText();
    ok(stub.calls.reply.length === n + 1 && !txt.includes('宅建・民法') && txt.length > 0, `R 「${t}」は従来の返信で宅建文は出ない`, { n, now: stub.calls.reply.length, txt: txt.slice(0,80) });
    sig[t] = txt.slice(0, 40);
  }
  ok(!friendList._getRecordForTest('U_E').subscriptions.takken, 'R2 他の合言葉だけでは購読されない');
  // 図面が最優先（無料相談）：「図面と宅建」は図面が勝ち、購読されない
  await sendWebhook(port, [msg('U_F', '図面 宅建')]); await sleep(150);
  ok(lastReplyText().includes('無料相談') && !friendList._getRecordForTest('U_F').subscriptions.takken, 'R3 「図面」は宅建より優先され購読されない');
  // 無関係な文（宅建を含まない）はデフォルト返信
  await sendWebhook(port, [msg('U_E', 'こんにちは')]); await sleep(150);
  ok(lastReplyText().includes('が見つかりませんでした'), 'R4 無関係な文は従来のデフォルト返信');

  // 永続化：ファイルに購読が残り、再読込でも復元される
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'friends.json'), 'utf8'));
  ok(saved.friends.U_A.subscriptions.takken.at === at1, 'P1 friends.json に購読が保存されている');
  friendList._resetForTest(); friendList.init();
  ok(friendList.listSubscribers('takken').some((s) => s.userId === 'U_A'), 'P2 再読込後も購読者が残る');
  ok(friendList.toCsv('U_OWNER_TEST').includes('お知らせ希望') && friendList.toCsv('U_OWNER_TEST').includes('"takken"'), 'P3 CSVに「お知らせ希望」列と takken が出る');

  // 返信文の体裁
  const t = lastReplyTextForTakken();
  function lastReplyTextForTakken() { return stub.calls.reply.map((r) => r.messages.map((m) => m.text || '').join('\n')).find((x) => x.includes('宅建・民法')); }
  ok(!t.includes('---') && !/[0-9０-９]+月|必ず|確実|絶対/.test(t), 'S1 罫線なし・月・確約語なし');
  ok(t.split('\n').every((l) => l.length <= 100), 'S2 1行100字以内（文字の壁なし）');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n結果: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
