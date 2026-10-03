// 取り込みスクリプト(Python)の試験。ローカルのBotに対して実行し、Dropbox外の一時フォルダに出力する。
// 実行: node test/test_importer.js <出力先スクラッチフォルダ>
process.env.LINE_CHANNEL_SECRET = 'test_secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
process.env.OWNER_USER_ID = 'U_OWNER_TEST';
process.env.FRIEND_LIST_TOKEN = 'list_token_for_test';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), http = require('http');
const { spawn } = require('child_process');
const stub = require('./stubLine');
const friendList = require('../friendList');
const { app } = require('../index');

const scratch = process.argv[2];
if (!scratch || /^C:.Users.katsu.Dropbox/i.test(path.resolve(scratch))) { console.error('Dropbox外のスクラッチフォルダを指定してください'); process.exit(2); }
// R5：毎回まっさらな一時ボリュームで実行する
fs.rmSync(path.join(scratch, 'volume'), { recursive: true, force: true });
fs.rmSync(path.join(scratch, 'LINE友だち名簿'), { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
process.env.STEP_DATA_DIR = path.join(scratch, 'volume');
friendList.init();

function post(port, events) {
  const body = JSON.stringify({ events });
  const sig = crypto.createHmac('SHA256', 'test_secret').update(body).digest('base64');
  return new Promise((resolve) => {
    const req = http.request({ port, method: 'POST', path: '/webhook', headers: { 'x-line-signature': sig, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve); });
    req.write(body); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function runPy(port, tokenFile, outDir) {
  return new Promise((resolve) => {
    const env = { ...process.env, LINE_LIST_BASE_URL: `http://127.0.0.1:${port}`, LINE_LIST_OUT_DIR: outDir, LINE_LIST_TOKEN_FILE: tokenFile, PYTHONUTF8: '1' };
    const py = spawn('python', [path.join(__dirname, '..', '..', 'line_list', 'update_friend_list.py')], { env });
    let out = ''; py.stdout.on('data', (d) => (out += d)); py.stderr.on('data', (d) => (out += d));
    py.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  const server = app.listen(0); const port = server.address().port;
  stub.profiles.U_A = '試験太郎'; stub.profiles.U_B = '試験花子';
  const ev = (type, u, t) => ({ type, replyToken: 'rt', source: { type: 'user', userId: u }, ...(t ? { message: { type: 'text', id: '1', text: t } } : {}) });
  await post(port, [ev('follow', 'U_A')]); await sleep(150);
  await post(port, [ev('message', 'U_A', '箱舟')]); await sleep(150);
  await post(port, [ev('follow', 'U_B')]); await sleep(150);
  await post(port, [ev('unfollow', 'U_B')]); await sleep(100);
  await post(port, [ev('message', 'U_C', '図面')]); await sleep(150); // follow記録なし

  const out = path.join(scratch, 'LINE友だち名簿');
  const goodToken = path.join(scratch, 'token_ok'); fs.writeFileSync(goodToken, 'list_token_for_test\n');
  const badToken = path.join(scratch, 'token_bad'); fs.writeFileSync(badToken, 'wrong');

  console.log('--- 1. 正しいトークン ---');
  let r = await runPy(port, goodToken, out); console.log('exit', r.code); console.log(r.out);
  console.log('--- 2. トークンファイルなし ---');
  r = await runPy(port, path.join(scratch, 'nothing'), out); console.log('exit', r.code); console.log(r.out);
  console.log('--- 3. 誤ったトークン（既存の名簿を壊さないこと）---');
  const sizeBefore = fs.statSync(path.join(out, 'LINE友だち名簿.csv')).size;
  r = await runPy(port, badToken, out); console.log('exit', r.code); console.log(r.out);
  console.log('名簿サイズ 前/後:', sizeBefore, fs.statSync(path.join(out, 'LINE友だち名簿.csv')).size);

  console.log('--- 4. 履歴の90日掃除（古い履歴は消え、最新CSVと新しい履歴は残る）---');
  const hist = path.join(out, '履歴');
  fs.writeFileSync(path.join(hist, 'LINE友だち名簿_2020-01-01.csv'), 'old');
  const d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(hist, `LINE友だち名簿_${d}.csv`), 'recent');
  fs.writeFileSync(path.join(hist, 'メモ.txt'), 'other');
  r = await runPy(port, goodToken, out); console.log('exit', r.code); console.log(r.out);
  console.log('履歴フォルダ:', fs.readdirSync(hist).join(', '));

  console.log('--- 5. Excelで開いたまま（読み取り共有のみでロック）---');
  const latest = path.join(out, 'LINE友だち名簿.csv');
  const lock = spawn('python', ['-c', `import ctypes,time;k=ctypes.windll.kernel32;k.CreateFileW.restype=ctypes.c_void_p;h=k.CreateFileW(r'${latest}',0x80000000,1,None,3,0x80,None);print('locked',h!=ctypes.c_void_p(-1).value,flush=True);time.sleep(8)`]);
  await new Promise((res) => lock.stdout.once('data', (x) => { console.log(String(x).trim()); res(); }));
  r = await runPy(port, goodToken, out); console.log('exit', r.code); console.log(r.out);
  console.log('tmpが残っていないか:', fs.readdirSync(out).concat(fs.readdirSync(hist)).filter((f) => f.endsWith('.tmp')).length === 0 ? '残っていない' : '残っている');
  lock.kill();

  console.log('--- 出力ファイル ---');
  for (const f of [path.join(out, 'LINE友だち名簿.csv'), ...fs.readdirSync(path.join(out, '履歴')).map((x) => path.join(out, '履歴', x))]) console.log(f);
  const buf = fs.readFileSync(path.join(out, 'LINE友だち名簿.csv'));
  console.log('先頭3バイト(BOM):', buf.slice(0, 3).toString('hex'));
  console.log(buf.toString('utf8'));
  server.close(); process.exit(0);
})();
