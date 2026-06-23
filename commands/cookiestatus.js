"use strict";

const cookieRefresher = require("../utils/cookieRefresher");
const fs = require("fs");
const path = require("path");

module.exports = {
  name: "cookiestatus",
  aliases: ["cookies", "cs", "كوكيز"],
  description: "عرض حالة الكوكيز وتجديدها",
  usage: "-cookiestatus",
  adminOnly: true,

  async execute({ api, event }) {
    const { threadID } = event;
    const s = cookieRefresher.status();

    const appStatePath = path.resolve(__dirname, "../appstate.json");
    let cookieAge = "—";
    let cookieCount = "—";
    try {
      const stat = fs.statSync(appStatePath);
      const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
      cookieAge = ageSec < 60
        ? ageSec + " ثانية"
        : ageSec < 3600
        ? Math.floor(ageSec / 60) + " دقيقة"
        : Math.floor(ageSec / 3600) + " ساعة";
      const cookies = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
      cookieCount = Array.isArray(cookies) ? cookies.length : "—";
    } catch {}

    const icon = s.active ? "🟢" : "🔴";
    const lastPush = s.lastPushAt ? _ago(s.lastPushAt) : "لم يتم بعد";

    const msg = [
      "━━━━━━━━━━━━━━━━━━━━━",
      "🍪  حالة نظام الكوكيز",
      "━━━━━━━━━━━━━━━━━━━━━",
      icon + " التجديد التلقائي: " + (s.active ? "نشط" : "متوقف"),
      "📦 عدد الكوكيز     : " + cookieCount,
      "🕐 آخر تعديل ملف  : " + cookieAge + " مضت",
      "💾 مرات الحفظ المحلي: " + (s.saveCount || s.pushCount),
      "⬆️ مرات الرفع لـGH : " + s.pushCount,
      "🔄 كل              : " + s.intervalMinutes + " دقائق",
      "📡 آخر رفع لـGitHub: " + lastPush,
      "❌ أخطاء الرفع     : " + (s.pushErrors || s.errorCount || 0) + (s.errorPausedUntil ? " ⚠️ (متوقف مؤقتاً)" : ""),
      "━━━━━━━━━━━━━━━━━━━━━",
      "💡 لتحديث الكوكيز:",
      "   افتح صفحة: /cookies",
    ].join("\n");

    return api.sendMessage(msg, threadID);
  },
};

function _ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)  return "منذ " + s + " ثانية";
  if (s < 3600) return "منذ " + Math.floor(s / 60) + " دقيقة";
  return "منذ " + Math.floor(s / 3600) + " ساعة";
}
