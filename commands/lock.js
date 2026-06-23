"use strict";

module.exports = {
  name: "lock",
  aliases: ["botlock"],
  description: "Lock the bot so only admins and moderators can use commands.",
  usage: "lock [on|off|status]",
  category: "Admin",
  groupOnly: true,
  adminOnly: true,

  async execute({ api, event, args, lockedThreads }) {
    const { threadID } = event;
    const sub = (args[0] || "").toLowerCase();
    const isLocked = lockedThreads.has(threadID);

    if (sub === "on") {
      if (isLocked) return api.sendMessage("🔒 البوت مقفل بالفعل في هذه المجموعة.", threadID);
      lockedThreads.add(threadID);
      return api.sendMessage("🔒 تم تفعيل قفل البوت.\nلن يستجيب البوت إلا للمشرفين.", threadID);
    }

    if (sub === "off") {
      if (!isLocked) return api.sendMessage("🔓 البوت غير مقفل في هذه المجموعة.", threadID);
      lockedThreads.delete(threadID);
      return api.sendMessage("🔓 تم إلغاء قفل البوت.\nيمكن لجميع الأعضاء استخدام الأوامر الآن.", threadID);
    }

    if (sub === "status") {
      const state = isLocked ? "🔒 مقفل — المشرفون فقط" : "🔓 مفتوح — جميع الأعضاء";
      return api.sendMessage("حالة البوت في هذه المجموعة:\n" + state, threadID);
    }

    // No arg: toggle
    if (isLocked) {
      lockedThreads.delete(threadID);
      return api.sendMessage("🔓 تم إلغاء قفل البوت.\nيمكن لجميع الأعضاء استخدام الأوامر الآن.", threadID);
    }
    lockedThreads.add(threadID);
    return api.sendMessage("🔒 تم تفعيل قفل البوت.\nلن يستجيب البوت إلا للمشرفين.", threadID);
  },
};
