// ローカル試験用：LINE API（返信・push・プロフィール取得）を差し替える。本番コードからは使われない。
// 偽の名前・偽のIDだけを使う（実在の個人情報は入れない）。
const line = require('@line/bot-sdk');
const calls = { reply: [], push: [], profile: [] };
const profiles = {}; // userId -> displayName
const failures = { profile: false, push: false, reply: false };
const P = line.messagingApi.MessagingApiClient.prototype;
P.replyMessage = async function (req) {
  if (failures.reply) throw new Error('reply failed (stub)');
  calls.reply.push(req); return {};
};
P.pushMessage = async function (req) {
  if (failures.push) throw new Error('push failed (stub)');
  calls.push.push(req); return {};
};
P.getProfile = async function (id) {
  calls.profile.push(id);
  if (failures.profile || !profiles[id]) throw new Error('profile failed (stub)');
  return { displayName: profiles[id] };
};
module.exports = { calls, profiles, failures };
