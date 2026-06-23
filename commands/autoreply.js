"use strict";

const fs   = require("fs");
const path = require("path");

const FILE = path.resolve(__dirname, "../data/schedules.json");

// schedules: Map<id, { id, threadID, message, intervalMs, label, timer, createdBy, nextAt }>
const schedules = new Map();
let nextID = 1;

// ── Persistence ───────────────────────────────────────────────────────────────
function _saveSchedules() {
  try {
    const serializable = [...schedules.values()].map(s => ({
      id:         s.id,
      threadID:   s.threadID,
      message:    s.message,
      intervalMs: s.intervalMs,
      label:      s.label,
      createdBy:  s.createdBy,
    }));
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ nextID, schedules: serializable }, null, 2), "utf8");
  } catch {}
}

// Reload and restart timers after bot launch (called by index.js or lazily)
let _api = null;
function _restoreSchedules(api) {
  _api = api;
  if (!fs.existsSync(FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (data.nextID) nextID = data.nextID;
    for (const s of (data.schedules || [])) {
      if (!s.id || !s.threadID || !s.message || !s.intervalMs) continue;
      const entry = { ...s, timer: null, nextAt: null };
      _startTimer(entry, api);
      schedules.set(s.id, entry);
    }
  } catch {}
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function _startTimer(entry, api) {
  entry.timer = setInterval(() => {
    entry.nextAt = Date.now() + entry.intervalMs;
    try {
      const result = api.sendMessage(entry.message, entry.threadID);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {}
  }, entry.intervalMs);
  entry.timer.unref?.();
  entry.nextAt = Date.now() + entry.intervalMs;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseInterval(amount, unit) {
  const n = parseInt(amount);
  if (isNaN(n) || n <= 0) return null;
  const u = (unit || "").toLowerCase();
  const map = {
    s: 1000, ث: 1000, sec: 1000, ثانية: 1000,
    m: 60000, د: 60000, min: 60000, دقيقة: 60000,
    h: 3600000, س: 3600000, hour: 3600000, ساعة: 3600000,
    d: 86400000, ي: 86400000, day: 86400000, يوم: 86400000,
  };
  const ms = map[u];
  if (!ms) return null;
  return n * ms;
}

function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s} ثانية`;
  if (s < 3600)  return `${Math.floor(s / 60)} دقيقة`;
  if (s < 86400) return `${Math.floor(s / 3600)} ساعة`;
  return `${Math.floor(s / 86400)} يوم`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString("ar-SA", {
    hour: "2-digit", minute: "2-digit",
    day: "numeric",  month: "numeric",
  });
}

module.exports = {
  name: "autoreply",
  aliases: ["sch", "auto", "timer"],
  description: "جدولة رسائل تُرسَل تلقائياً كل فترة زمنية. (مشرف فقط)",
  usage: [
    "-autoreply add <مقدار> <وحدة> <الرسالة>",
    "-autoreply list",
    "-autoreply stop <ID>",
    "-autoreply stopall",
    "",
    "وحدات الوقت: s/ث=ثواني  m/د=دقائق  h/س=ساعات  d/ي=أيام",
    "",
    "مثال:",
    "  -autoreply add 30 m صباح الخير 🌅",
    "  -autoreply add 2 h تذكير: التزموا بالقوانين",
  ].join("\n"),
  category: "Group",
  groupOnly: true,
  adminOnly: true,

  _restoreSchedules,

  async execute({ api, event, args }) {
    if (_api !== api) _api = api;
    const config   = require("../config.json");
    const sub      = (args[0] || "").toLowerCase();
    const threadID = event.threadID;
    const prefix   = config.prefix;

    // ── add ────────────────────────────────────────────────────────────────────
    if (sub === "add") {
      const amount  = args[1];
      const unit    = args[2];
      const message = args.slice(3).join(" ").trim();

      if (!amount || !unit || !message) {
        return api.sendMessage(
          `❌ استخدام:\n${prefix}autoreply add <مقدار> <وحدة> <الرسالة>\n\nمثال:\n${prefix}autoreply add 30 m صباح الخير 🌅`,
          threadID
        );
      }

      const intervalMs = parseInterval(amount, unit);
      if (!intervalMs) {
        return api.sendMessage(`❌ وحدة غير صحيحة. الوحدات: s/ث  m/د  h/س  d/ي`, threadID);
      }
      if (intervalMs < 30000) {
        return api.sendMessage("❌ الحد الأدنى للجدولة هو 30 ثانية.", threadID);
      }
      if (intervalMs > 7 * 86400000) {
        return api.sendMessage("❌ الحد الأقصى للجدولة هو 7 أيام.", threadID);
      }

      // Max 10 schedules per thread
      const threadCount = [...schedules.values()].filter(s => s.threadID === threadID).length;
      if (threadCount >= 10) {
        return api.sendMessage("❌ الحد الأقصى 10 جداول لكل مجموعة.", threadID);
      }

      const id = nextID++;
      const entry = {
        id, threadID, message,
        intervalMs, label: `${amount}${unit}`,
        timer: null, createdBy: event.senderID, nextAt: null,
      };

      _startTimer(entry, api);
      schedules.set(id, entry);
      _saveSchedules();

      return api.sendMessage(
        `✅ جدول #${id} أُنشئ\n\n⏱️ التكرار: كل ${formatMs(intervalMs)}\n📩 الرسالة: ${message}\n🕐 القادم: ${formatDate(entry.nextAt)}\n\nلإيقافه: ${prefix}autoreply stop ${id}`,
        threadID
      );
    }

    // ── list ───────────────────────────────────────────────────────────────────
    if (sub === "list") {
      const ts = [...schedules.values()].filter(s => s.threadID === threadID);
      if (!ts.length) {
        return api.sendMessage(`📭 لا توجد جداول نشطة.\nأضف واحداً: ${prefix}autoreply add <مقدار> <وحدة> <الرسالة>`, threadID);
      }
      let msg = `┌─── 🔁 الجداول النشطة (${ts.length}) ───\n│\n`;
      for (const s of ts) {
        msg += `│ #${s.id} — كل ${formatMs(s.intervalMs)}\n`;
        msg += `│ 🕐 ${formatDate(s.nextAt)}\n`;
        msg += `│ 📩 ${s.message.length > 50 ? s.message.slice(0, 50) + "…" : s.message}\n│\n`;
      }
      msg += `└─ لإيقاف جدول: ${prefix}autoreply stop <ID>`;
      return api.sendMessage(msg, threadID);
    }

    // ── stop ───────────────────────────────────────────────────────────────────
    if (sub === "stop") {
      const id = parseInt(args[1]);
      if (isNaN(id)) return api.sendMessage(`❌ مثال: ${prefix}autoreply stop 1`, threadID);
      const entry = schedules.get(id);
      if (!entry)                      return api.sendMessage(`❌ لا يوجد جدول #${id}.`, threadID);
      if (entry.threadID !== threadID) return api.sendMessage("❌ هذا الجدول يعود لمجموعة أخرى.", threadID);
      clearInterval(entry.timer);
      schedules.delete(id);
      _saveSchedules();
      return api.sendMessage(`✅ تم إيقاف الجدول #${id}.\n📩 كانت الرسالة: ${entry.message}`, threadID);
    }

    // ── stopall ────────────────────────────────────────────────────────────────
    if (sub === "stopall") {
      const toDelete = [...schedules.entries()].filter(([, s]) => s.threadID === threadID);
      if (!toDelete.length) return api.sendMessage("📭 لا توجد جداول نشطة.", threadID);
      for (const [id, entry] of toDelete) { clearInterval(entry.timer); schedules.delete(id); }
      _saveSchedules();
      return api.sendMessage(`✅ تم إيقاف جميع الجداول (${toDelete.length}).`, threadID);
    }

    return api.sendMessage(`📖 استخدام:\n\n${this.usage}`, threadID);
  },
};
