"use strict";

const humanSimulator = require("../utils/humanSimulator");

function timeAgo(ms) {
  if (!ms) return "لم يبدأ بعد";
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60)  return "منذ " + sec + " ث";
  if (sec < 3600) return "منذ " + Math.floor(sec / 60) + " دق";
  return "منذ " + Math.floor(sec / 3600) + " س " + Math.floor((sec % 3600) / 60) + " دق";
}

function uptime(ms) {
  if (!ms) return "—";
  const sec = Math.floor((Date.now() - ms) / 1000);
  const h   = Math.floor(sec / 3600);
  const m   = Math.floor((sec % 3600) / 60);
  const s   = sec % 60;
  return h + "س " + m + "د " + s + "ث";
}

const ACTION_LABELS = {
  presence:      "💚 إشارة تواجد",
  typing:        "⌨️  كتابة",
  markRead:      "👁️  قراءة محادثة",
  browse:        "📂 تصفح دفعة",
  reels:         "🎬 تصفح الرئيسية",
  profileView:   "👤 زيارة ملف",
  inboxScroll:   "📥 تصفح الصندوق",
  historyScroll: "📜 قراءة تاريخ",
};

module.exports = {
  name: "simstatus",
  aliases: ["sim", "محاكي"],
  description: "عرض إحصائيات محاكي الإنسان (anti-detection).",
  usage: "simstatus",
  category: "Admin",
  adminOnly: true,

  async execute({ api, event }) {
    const { threadID } = event;
    const s = humanSimulator.status();
    const st = s.stats;

    const statusIcon = s.running ? "🟢 يعمل" : "🔴 متوقف";
    const lastAction = ACTION_LABELS[st.lastActionType] || st.lastActionType || "—";

    const lines = [
      "🤖 حالة محاكي الإنسان",
      "━━━━━━━━━━━━━━━━━━━━━━",
      "الحالة       : " + statusIcon,
      "وقت التشغيل  : " + uptime(st.startedAt),
      "",
      "📊 الإحصائيات:",
      "  💚 إشارات تواجد    : " + st.presenceSent,
      "  ⌨️  جلسات كتابة     : " + st.typingSimulated,
      "  👁️  محادثات مقروءة  : " + st.threadsRead,
      "  📂 جلسات تصفح      : " + st.browseSessions,
      "  📥 تصفح الصندوق    : " + (st.inboxScrolls  || 0),
      "  📜 قراءة تاريخ     : " + (st.historyScrolls || 0),
      "  🎬 جلسات رئيسية    : " + st.reelsSessions,
      "  👤 ملفات زُيرت     : " + st.profileViews,
      "",
      "⏱️  آخر نشاط : " + lastAction,
      "   " + timeAgo(st.lastActionAt),
    ];

    return api.sendMessage(lines.join("\n"), threadID);
  },
};
