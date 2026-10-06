// 友だち名簿の試験。実行: node test/test_friendlist.js
// 署名付きwebhookを実サーバー（index.js の app）に送り、名簿・通知・認証・永続化を確かめる。
process.env.LINE_CHANNEL_SECRET = 'test_secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
process.env.OWNER_USER_ID = 'U_OWNER_TEST';
process.env.FRIEND_LIST_TOKEN = 'list_token_for_test';
process.env.DEBUG_TOKEN = 'debug_token_for_test';
delete process.env.STEP_DATA_DIR; delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), http = require('http');
const stub = require('./stubLine');
const friendList = require('../friendList');
const { app } = require('../index');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path: p, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
function sendWebhook(port, events) {
  const body = JSON.stringify({ destination: 'Utest', events });
  const sig = crypto.createHmac('SHA256', 'test_secret').update(body).digest('base64');
  return request(port, 'POST', '/webhook', { headers: { 'x-line-signature': sig, 'content-type': 'application/json' }, body });
}
const follow = (u) => ({ type: 'follow', replyToken: 'rt', source: { type: 'user', userId: u } });
const unfollow = (u) => ({ type: 'unfollow', source: { type: 'user', userId: u } });
const msg = (u, t) => ({ type: 'message', replyToken: 'rt', source: { type: 'user', userId: u }, message: { type: 'text', id: '1', text: t } });

(async () => {
  // A. 永続化先なし
  friendList.init();
  ok(friendList.getStatus().persistent === false && friendList.getStatus().persistReason === 'no_volume_configured', 'A1 永続化先なし→persistent:false', friendList.getStatus());

  // B. 永続化先あり（一時フォルダ＝Dropbox外）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'friends_test_'));
  process.env.STEP_DATA_DIR = tmp;
  friendList._resetForTest(); friendList.init();
  ok(friendList.getStatus().persistent === true, 'B1 永続化先あり→persistent:true', friendList.getStatus());

  const server = app.listen(0); const port = server.address().port;
  stub.profiles['U_ALICE'] = '田中太郎(試験)'; stub.profiles['U_OLD'] = '既存の人(試験)';
  stub.profiles['U_EVIL'] = '=HYPERLINK("http://x","a")';

  // C. follow -> 合言葉 -> message -> unfollow -> 再follow
  let r = await sendWebhook(port, [follow('U_ALICE')]); await sleep(150);
  ok(r.status === 200, 'C1 follow webhook 200');
  ok(stub.calls.reply.length === 1, 'C2 follow の返信は1回出た', stub.calls.reply.length);
  let rec = friendList._getRecordForTest('U_ALICE');
  ok(rec && rec.followedAt && rec.displayName === '田中太郎(試験)' && rec.refollowCount === 0, 'C3 followedAt・表示名が入る', rec);
  const p0 = stub.calls.push[0];
  ok(stub.calls.push.length === 1 && p0.to === 'U_OWNER_TEST' && p0.messages[0].text.includes('初めての追加') && p0.messages[0].text.includes('田中太郎(試験)'), 'C4 オーナーへ1通push（初回）');

  await sendWebhook(port, [msg('U_ALICE', 'こんにちは')]); await sleep(150);
  rec = friendList._getRecordForTest('U_ALICE');
  ok(rec.entry === null && rec.lastMessageAt, 'C5 合言葉でない文では入口は未確定、最終メッセージ日時は入る', rec);
  const pushBeforeKw = stub.calls.push.length;
  await sendWebhook(port, [msg('U_ALICE', '箱舟')]); await sleep(150);
  rec = friendList._getRecordForTest('U_ALICE');
  ok(rec.entry === '箱舟', 'C6 最初の合言葉=箱舟が入口になる', rec.entry);
  await sendWebhook(port, [msg('U_ALICE', '体の点検')]); await sleep(150);
  ok(friendList._getRecordForTest('U_ALICE').entry === '箱舟', 'C7 2つ目の合言葉で入口は上書きされない');
  const friendPushes = stub.calls.push.filter((p) => p.messages[0].text.includes('新しい友だち')).length;
  ok(friendPushes === 1, 'C8 合言葉・メッセージでは新規友だち通知が増えない', friendPushes);

  await sendWebhook(port, [unfollow('U_ALICE')]); await sleep(100);
  rec = friendList._getRecordForTest('U_ALICE');
  ok(rec.blockedAt && rec.lastBlockedAt, 'C9 unfollowでブロック日時が入る', rec);
  await sendWebhook(port, [follow('U_ALICE')]); await sleep(150);
  rec = friendList._getRecordForTest('U_ALICE');
  ok(rec.refollowCount === 1 && rec.blockedAt === null && rec.entry === '箱舟' && rec.followedAt, 'C10 再followで再追加回数1・ブロック解除・入口は保持', rec);
  const fp = stub.calls.push.filter((p) => p.messages[0].text.includes('新しい友だち'));
  ok(fp.length === 2 && fp[1].messages[0].text.includes('再追加（1回目）'), 'C11 再followも通知1通（再追加と明記）', fp.length);

  // C2. 入口が初めて分かったときの通知（1人1回・オーナー本人には送らない）
  const entryPushes = () => stub.calls.push.filter((p) => p.messages[0].text.includes('友だちの入口が分かりました'));
  ok(entryPushes().length === 1 && entryPushes()[0].messages[0].text.includes('田中太郎(試験)') && entryPushes()[0].messages[0].text.includes('「箱舟」'), 'C2-1 最初の合言葉で入口通知が1通（箱舟）', entryPushes().length);
  await sendWebhook(port, [msg('U_OWNER_TEST', '図面')]); await sleep(150);
  ok(entryPushes().length === 1, 'C2-3 オーナー本人の合言葉では入口通知を送らない');
  stub.failures.push = true;
  const rb0 = stub.calls.reply.length;
  stub.profiles['U_ENT'] = '入口試験(試験)';
  await sendWebhook(port, [msg('U_ENT', 'AI社長')]); await sleep(150);
  ok(stub.calls.reply.length === rb0 + 1 && friendList._getRecordForTest('U_ENT').entry === 'AI社長', 'C2-4 入口通知のpushが失敗しても返信は出て入口は記録される');
  stub.failures.push = false;
  // C2b. 利用目的の1文
  const welcome = JSON.stringify(stub.calls.reply[0].messages);
  ok(welcome.includes('■ お預かりする情報について\\nお名前と、最初に送っていただいた合言葉を記録しています。\\nご相談へのお返事と、私の発信を見直すためだけに使います。\\n\\nカツヤス'), 'C2b followの返信に利用目的の1文がある');

  // D. follow記録なしの人のmessage
  await sendWebhook(port, [msg('U_OLD', '図面')]); await sleep(200);
  rec = friendList._getRecordForTest('U_OLD');
  ok(rec && rec.followedAt === null && rec.entry === '図面' && rec.displayName === '既存の人(試験)', 'D1 follow記録なし→followedAt=null(不明)で名簿入り・入口=図面', rec);
  ok(friendList.toCsv('U_OWNER_TEST').includes('不明'), 'D2 CSVに「不明」と出る');

  // E. オーナー本人のfollowは通知しない／通知失敗・名前取得失敗でも返信と記録は無事
  const before = stub.calls.push.length;
  await sendWebhook(port, [follow('U_OWNER_TEST')]); await sleep(150);
  ok(stub.calls.push.length === before && friendList._getRecordForTest('U_OWNER_TEST'), 'E1 オーナーfollowは通知なし・名簿には載る');
  stub.failures.push = true; stub.failures.profile = true;
  const rb = stub.calls.reply.length;
  await sendWebhook(port, [follow('U_NOPROFILE')]); await sleep(150);
  ok(stub.calls.reply.length === rb + 1 && friendList._getRecordForTest('U_NOPROFILE').displayName === null, 'E2 push失敗＋名前取得失敗でも返信は出て記録も残る');
  stub.failures.push = false; stub.failures.profile = false;
  await sendWebhook(port, [follow('U_EVIL')]); await sleep(150);

  // F. 認証
  const q = (p, h) => request(port, 'GET', p, { headers: h || {} });
  ok((await q('/admin/friends')).status === 401, 'F1 トークンなし(HTML)→401');
  ok((await q('/admin/friends.csv')).status === 401, 'F2 トークンなし(CSV)→401');
  ok((await q('/admin/friends?token=wrong')).status === 401, 'F3 誤りトークン→401');
  ok((await q('/admin/friends.csv?token=debug_token_for_test')).status === 401, 'F4 DEBUG_TOKENでは開かない→401');
  const html = await q('/admin/friends?token=list_token_for_test');
  ok(html.status === 200 && /名簿 \d+ 人/.test(html.buf.toString()) && html.buf.toString().includes('田中太郎(試験)') && html.headers['cache-control'] === 'no-store', 'F5 正しいトークンでHTML一覧(200,no-store)');
  const csv = await q('/admin/friends.csv', { 'x-list-token': 'list_token_for_test' });
  ok(csv.status === 200 && csv.buf[0] === 0xEF && csv.buf[1] === 0xBB && csv.buf[2] === 0xBF, 'F6 ヘッダのトークンでCSV・UTF-8 BOM付き');
  const text = csv.buf.toString('utf8');
  ok(text.includes('田中太郎(試験)') && text.includes('"箱舟"') && text.includes('"オーナー"'), 'F7 CSVに表示名・入口・オーナー区分');
  ok(!text.includes('"=HYPERLINK') && text.includes('"\'=HYPERLINK'), 'F8 先頭が = の表示名は式として出ない');
  const health = JSON.parse((await q('/health')).buf.toString());
  ok(health.version === '2.17.0' && health.friend_list.persistent === true && !('friendsTotal' in health.friend_list) && !('friendsActive' in health.friend_list) && !JSON.stringify(health).includes('田中'), 'F9 /healthは2.17.0・persistentのみ（人数も名前も出さない）', health.friend_list);
  const saved = fs.readFileSync(path.join(tmp, 'friends.json'), 'utf8');
  ok(saved.includes('U_ALICE'), 'F10 ボリュームにfriends.jsonが書かれている');

  // G. 再起動後の復元
  friendList._resetForTest(); friendList.init();
  ok(friendList._getRecordForTest('U_ALICE') && friendList._getRecordForTest('U_ALICE').refollowCount === 1, 'G1 再起動(再読込)で名簿が復元される');

  // H. 保存先が壊れても返信は出る
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(tmp, 'フォルダをファイルで潰して保存不能にする');
  const rb2 = stub.calls.reply.length;
  await sendWebhook(port, [msg('U_ALICE', '香り')]); await sleep(150);
  ok(stub.calls.reply.length === rb2 + 1, 'H1 保存に失敗しても利用者への返信は出る');
  ok(friendList.getStatus().persistent === false, 'H2 保存失敗でpersistent:falseになる', friendList.getStatus());
  fs.rmSync(tmp, { force: true });

  // C3. 壊れたfriends.jsonは退避され、空で上書きされない。ログに表示名が出ない
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'friends_broken_'));
  process.env.STEP_DATA_DIR = tmp2;
  fs.writeFileSync(path.join(tmp2, 'friends.json'), '{"friends":{"U_X":{"displayName":"秘密の表示名(試験)"'); // 途中で切れたJSON
  const logs = []; const oe = console.error, ol = console.log, ow = console.warn;
  console.error = (...a) => logs.push(a.join(' ')); console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' '));
  friendList._resetForTest(); friendList.init();
  console.error = oe; console.log = ol; console.warn = ow;
  const files = fs.readdirSync(tmp2);
  const broken = files.filter((f) => f.startsWith('friends.json.broken-'));
  ok(broken.length === 1 && fs.readFileSync(path.join(tmp2, broken[0]), 'utf8').includes('秘密の表示名(試験)'), 'C3-1 壊れたJSONが friends.json.broken-<日時> に退避され中身が残る', files);
  ok(friendList.getStatus().persistent === true && friendList.getStatus().friendsTotal === 0, 'C3-2 退避後は空の名簿で動き始める', friendList.getStatus());
  ok(!logs.join(' ').includes('秘密の表示名') && !logs.join(' ').includes('Unexpected') && logs.some((l) => l.includes('読めませんでした')), 'C3-3 ログに表示名・解析エラー本文が出ず、固定文言が出る', logs);
  // 陽性対照：e.message を出す実装なら検出できる文字列が JSON.parse に実在する
  let msgText = ''; try { JSON.parse('{"friends":{"U_X":{"displayName":"秘密の表示名(試験)"'); } catch (e) { msgText = e.message; }
  ok(/Unexpected|Expected|JSON/.test(msgText), 'C3-4 陽性対照：JSONの解析エラー文は実在する（出していれば検出される）', msgText);
  fs.rmSync(tmp2, { recursive: true, force: true });

  // I. 入口判定の表
  const cases = { '図面': '図面', '設計図面': '図面', '快眠': '快眠', 'ドテラ': '快眠', 'ドテラについて相談': '相談', 'アロマ本': '快眠', '体の点検': '体の点検', '点検表': '点検表', 'AI社長': 'AI社長', '名刺': '名刺', 'マイID': null, 'こんにちは': null, '空き家': null, 'ミネラル': null };
  for (const [t, e] of Object.entries(cases)) ok(friendList.detectEntry(t) === e, `I 入口判定 ${t} -> ${e}`, friendList.detectEntry(t));

  server.close();
  console.log(`\n結果: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
