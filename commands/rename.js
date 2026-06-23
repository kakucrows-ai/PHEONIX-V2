"use strict";

const fmt             = require("../utils/fmt");
const config          = require("../config.json");
const { lockedNames } = require("../utils/lockedNames");
const { groupsCache } = require("../state");

module.exports = {
  name: "rename",
  aliases: ["setname", "groupname"],
  description: "تغيير اسم المجموعة، مع خيار قفله تلقائياً ومنع تغييره.",
  usage: "rename <اسم>  |  rename <اسم> lock  |  rename unlock",
  category: "Group",
  groupOnly: true,
  adminOnly: true,

  async execute({ api, event, args }) {
    const { threadID } = event;

    // ── رفع القفل: -rename unlock / off / نزع ─────────────────────────────
    const first = (args[0] || "").toLowerCase();
    if (first === "unlock" || first === "off" || first === "نزع" || first === "فتح") {
      if (!lockedNames.has(threadID)) {
        return api.sendMessage(
          [fmt.header(), "", fmt.wrn("اسم المجموعة غير مقفل أصلاً.")].join("\n"),
          threadID
        );
      }
      lockedNames.delete(threadID);
      return api.sendMessage(
        [
          fmt.header(),
          "",
          fmt.ok("تم رفع قفل اسم المجموعة."),
          fmt.inf("يمكن الآن تغيير الاسم بحرية."),
        ].join("\n"),
        threadID
      );
    }

    // ── كشف كلمة lock في نهاية الأمر ──────────────────────────────────────
    const lastArg   = (args[args.length - 1] || "").toLowerCase();
    const wantsLock = args.length > 1 && (lastArg === "lock" || lastArg === "قفل");
    const nameParts = wantsLock ? args.slice(0, -1) : args;
    const newName   = nameParts.join(" ").trim();

    // ── بدون اسم: عرض المساعدة ────────────────────────────────────────────
    if (!newName) {
      const isLocked = lockedNames.has(threadID);
      return api.sendMessage(
        [
          fmt.header(),
          "",
          fmt.row("تغيير الاسم",  config.prefix + "rename <اسم>",         "✏️"),
          fmt.row("تغيير + قفل",  config.prefix + "rename <اسم> lock",    "🔒"),
          fmt.row("رفع القفل",    config.prefix + "rename unlock",         "🔓"),
          "",
          fmt.row("حالة القفل",   isLocked ? "مقفل 🔒" : "غير مقفل 🔓",  "🏷️"),
        ].join("\n"),
        threadID
      );
    }

    // ── تنفيذ تغيير الاسم ─────────────────────────────────────────────────
    try {
      await api.gcname(newName, threadID);
      const cached = groupsCache.get(threadID) || {};
      groupsCache.set(threadID, { ...cached, name: newName });
    } catch (e) {
      return api.sendMessage(
        [fmt.header(), "", fmt.err("تعذّر تغيير الاسم: " + e.message)].join("\n"),
        threadID
      );
    }

    // ── مع قفل: -rename <اسم> lock ────────────────────────────────────────
    if (wantsLock) {
      lockedNames.set(threadID, newName);
      return api.sendMessage(
        [
          fmt.header(),
          "",
          fmt.ok("تم تغيير اسم المجموعة وقفله."),
          fmt.inf("سيُعاد تعيين الاسم تلقائياً إن حاول أحد تغييره."),
          "",
          fmt.row("لرفع القفل", config.prefix + "rename unlock", "🔓"),
        ].join("\n"),
        threadID
      );
    }

    // ── تغيير عادي — بدون ذكر الاسم ──────────────────────────────────────
    return api.sendMessage(
      [fmt.header(), "", fmt.ok("تم تغيير اسم المجموعة بنجاح.")].join("\n"),
      threadID
    );
  },
};
