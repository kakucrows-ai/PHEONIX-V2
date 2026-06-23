"use strict";

const fmt               = require("../utils/fmt");
const config            = require("../config.json");
const { lockedNicknames, clearThread } = require("../utils/nicknameLocks");

module.exports = {
  name: "nickname",
  aliases: ["nick", "nn", "كنية", "كنيات"],
  description: "تعيين، قفل أو مسح كنيات الأعضاء — فردياً أو للمجموعة كلها.",
  usage: [
    "-nickname set @شخص <كنية>     — تعيين كنية لشخص",
    "-nickname clear @شخص          — حذف كنية شخص",
    "-nickname lock @شخص <كنية>    — قفل كنية شخص",
    "-nickname unlock @شخص         — فك قفل كنية شخص",
    "-nickname setall <نص>         — كنية لكل الأعضاء  (يدعم {name})",
    "-nickname lockall <نص>        — كنية + قفل للجميع (يدعم {name})",
    "-nickname unlockall            — فك قفل جميع الكنيات",
    "-nickname locks                — عرض الكنيات المقفولة",
    "-nickname clearall             — مسح كل الكنيات",
  ].join("\n"),
  category: "Group",
  groupOnly: true,
  adminOnly: true,

  async execute({ api, event, args }) {
    const sub        = (args[0] || "").toLowerCase();
    const mentions   = event.mentions || {};
    const mentionIDs = Object.keys(mentions);
    const { threadID } = event;
    const prefix     = config.prefix;

    function _setNick(nick, tid, uid) {
      return new Promise((res, rej) => api.changeNickname(nick, tid, uid, e => e ? rej(e) : res())); // FIXED: api.nickname() does not exist; correct method is api.changeNickname()
    }

    // ── locks: عرض الكنيات المقفولة ────────────────────────────────────────
    if (sub === "locks") {
      const threadLocks = lockedNicknames.get(threadID);
      if (!threadLocks || threadLocks.size === 0) {
        return api.sendMessage(
          [fmt.header(), "", fmt.ok("لا توجد كنيات مقفولة في هذه المجموعة.")].join("\n"),
          threadID
        ).catch(() => {});
      }
      const lines = [fmt.header(), "", "🔒  الكنيات المقفولة (" + threadLocks.size + ")", fmt.divider()];
      for (const [uid, nick] of threadLocks.entries()) {
        lines.push("  • " + uid + " ← " + nick);
      }
      return api.sendMessage(lines.join("\n"), threadID).catch(() => {});
    }

    // ── unlockall: فك قفل جميع الكنيات ─────────────────────────────────────
    if (sub === "unlockall") {
      const count = (lockedNicknames.get(threadID) || new Map()).size;
      clearThread(threadID);
      return api.sendMessage(
        [
          fmt.header(),
          "",
          count > 0
            ? fmt.ok("تم فك قفل " + count + " كنية في هذه المجموعة. 🔓")
            : fmt.wrn("لا توجد كنيات مقفولة أصلاً."),
        ].join("\n"),
        threadID
      ).catch(() => {});
    }

    // ── clearall: مسح كل الكنيات ───────────────────────────────────────────
    if (sub === "clearall") {
      let info;
      try { info = await api.getThreadInfo(threadID); }
      catch (e) { return api.sendMessage(fmt.err("فشل جلب معلومات المجموعة: " + e.message), threadID).catch(() => {}); }

      const ids = info.participantIDs || [];
      if (!ids.length) return api.sendMessage(fmt.wrn("لا يوجد أعضاء في المجموعة."), threadID).catch(() => {});

      await api.sendMessage(
        [fmt.header(), "", "⏳ جارٍ مسح كنيات " + ids.length + " عضو..."].join("\n"),
        threadID
      ).catch(() => {});

      let done = 0, failed = 0;
      for (const uid of ids) {
        try {
          await _setNick("", threadID, uid);
          done++;
        } catch { failed++; }
        await new Promise(r => setTimeout(r, 450));
      }

      clearThread(threadID);

      return api.sendMessage(
        [
          fmt.header(),
          "",
          fmt.ok("تم مسح كل الكنيات وإزالة جميع الأقفال."),
          "",
          fmt.row("نجح",  String(done),   "✅"),
          fmt.row("فشل",  String(failed), "❌"),
        ].join("\n"),
        threadID
      ).catch(() => {});
    }

    // ── setall / lockall: كنية لكل الأعضاء ─────────────────────────────────
    if (sub === "setall" || sub === "lockall") {
      const template = args.slice(1).join(" ").trim();
      if (!template) {
        return api.sendMessage(
          [
            fmt.header(),
            "",
            fmt.err("لم تكتب نص الكنية."),
            "",
            fmt.row("مثال ثابت",    prefix + "nickname " + sub + " 🌹 عضو",           "📝"),
            fmt.row("مثال بالاسم",  prefix + "nickname " + sub + " 🌹 {name}",          "📝"),
            fmt.inf("استبدل {name} باسم كل عضو تلقائياً."),
          ].join("\n"),
          threadID
        ).catch(() => {});
      }

      let info;
      try { info = await api.getThreadInfo(threadID); }
      catch (e) { return api.sendMessage(fmt.err("فشل جلب معلومات المجموعة: " + e.message), threadID).catch(() => {}); }

      const ids = info.participantIDs || [];
      if (!ids.length) return api.sendMessage(fmt.wrn("لا يوجد أعضاء."), threadID).catch(() => {});

      // جلب الأسماء إذا كان القالب يحتوي {name}
      let userInfo = {};
      const needsName = /\{name\}/i.test(template);
      if (needsName) {
        try { userInfo = await api.getUserInfo(ids) || {}; } catch {}
      }

      const doLock = sub === "lockall";
      if (doLock) {
        if (!lockedNicknames.has(threadID)) lockedNicknames.set(threadID, new Map());
      }

      await api.sendMessage(
        [
          fmt.header(),
          "",
          "⏳ جارٍ " + (doLock ? "قفل و" : "") + "تعيين كنيات " + ids.length + " عضو...",
          needsName ? fmt.inf("القالب: " + template) : "",
        ].filter(Boolean).join("\n"),
        threadID
      ).catch(() => {});

      let done = 0, failed = 0;
      for (const uid of ids) {
        const name = userInfo[uid]?.name || userInfo[uid]?.fullName || uid;
        const nick = template.replace(/\{name\}/gi, name);
        try {
          await _setNick(nick, threadID, uid);
          if (doLock) lockedNicknames.get(threadID).set(uid, nick);
          done++;
        } catch { failed++; }
        await new Promise(r => setTimeout(r, 500));
      }

      return api.sendMessage(
        [
          fmt.header(),
          "",
          fmt.ok("تم " + (doLock ? "قفل و" : "") + "تعيين الكنيات لـ " + done + " عضو." + (doLock ? " 🔒" : "")),
          doLock ? fmt.inf("ستُطبَّق تلقائياً كل 90 ثانية.") : "",
          doLock ? fmt.row("لفك الجميع", prefix + "nickname unlockall", "🔓") : "",
          "",
          fmt.row("نجح",  String(done),   "✅"),
          fmt.row("فشل",  String(failed), "❌"),
        ].filter(Boolean).join("\n"),
        threadID
      ).catch(() => {});
    }

    // ── التحقق من sub صحيح ──────────────────────────────────────────────────
    if (!["set", "clear", "lock", "unlock"].includes(sub)) {
      return api.sendMessage(
        [
          fmt.header(),
          "",
          "🔹 فردي",
          fmt.row("تعيين",     prefix + "nickname set @شخص <كنية>",   "✏️"),
          fmt.row("حذف",       prefix + "nickname clear @شخص",         "🗑️"),
          fmt.row("قفل",       prefix + "nickname lock @شخص <كنية>",  "🔒"),
          fmt.row("فك قفل",   prefix + "nickname unlock @شخص",        "🔓"),
          "",
          "🔸 جماعي",
          fmt.row("الجميع",   prefix + "nickname setall <نص>",         "👥"),
          fmt.row("قفل الكل", prefix + "nickname lockall <نص>",        "🔒"),
          fmt.row("فك الكل",  prefix + "nickname unlockall",           "🔓"),
          fmt.row("مسح الكل", prefix + "nickname clearall",            "💥"),
          "",
          "📋 معلومات",
          fmt.row("المقفولة",  prefix + "nickname locks",              "📋"),
          fmt.inf("يدعم {name} في setall/lockall لاستبداله بالاسم."),
        ].join("\n"),
        threadID
      ).catch(() => {});
    }

    // ── أوامر تحتاج mention ─────────────────────────────────────────────────
    if (mentionIDs.length === 0) {
      return api.sendMessage(
        fmt.err("يجب ذكر شخص.\nمثال: " + prefix + "nickname " + sub + " @شخص" +
          (sub !== "clear" && sub !== "unlock" ? " <الكنية>" : "")),
        threadID
      ).catch(() => {});
    }

    const targetID   = mentionIDs[0];
    const targetName = (Object.values(mentions)[0] || "").replace(/@/, "") || targetID;

    // ── set ─────────────────────────────────────────────────────────────────
    if (sub === "set") {
      const nick = args.slice(2).join(" ").trim();
      if (!nick) return api.sendMessage(fmt.err("مثال: " + prefix + "nickname set @شخص كنيتي"), threadID).catch(() => {});
      try {
        await _setNick(nick, threadID, targetID);
        api.sendMessage(
          [fmt.header(), "", fmt.ok("تم تعيين الكنية لـ " + targetName + ".")].join("\n"),
          threadID
        ).catch(() => {});
      } catch (e) { api.sendMessage(fmt.err("فشل: " + (e.message || e)), threadID).catch(() => {}); }
    }

    // ── clear ────────────────────────────────────────────────────────────────
    else if (sub === "clear") {
      lockedNicknames.get(threadID)?.delete(targetID);
      try {
        await _setNick("", threadID, targetID);
        api.sendMessage(
          [fmt.header(), "", fmt.ok("تم حذف كنية " + targetName + ".")].join("\n"),
          threadID
        ).catch(() => {});
      } catch (e) { api.sendMessage(fmt.err("فشل: " + (e.message || e)), threadID).catch(() => {}); }
    }

    // ── lock ─────────────────────────────────────────────────────────────────
    else if (sub === "lock") {
      const nick = args.slice(2).join(" ").trim();
      if (!nick) return api.sendMessage(fmt.err("مثال: " + prefix + "nickname lock @شخص كنيتي"), threadID).catch(() => {});
      if (!lockedNicknames.has(threadID)) lockedNicknames.set(threadID, new Map());
      lockedNicknames.get(threadID).set(targetID, nick);
      try {
        await _setNick(nick, threadID, targetID);
        api.sendMessage(
          [
            fmt.header(),
            "",
            fmt.ok("تم قفل كنية " + targetName + ". 🔒"),
            fmt.inf("تُطبَّق تلقائياً كل 90 ثانية."),
            "",
            fmt.row("لفك القفل", prefix + "nickname unlock @" + targetName, "🔓"),
          ].join("\n"),
          threadID
        ).catch(() => {});
      } catch (e) { api.sendMessage(fmt.err("فشل: " + e.message), threadID).catch(() => {}); }
    }

    // ── unlock ───────────────────────────────────────────────────────────────
    else if (sub === "unlock") {
      const threadLocks = lockedNicknames.get(threadID);
      if (!threadLocks || !threadLocks.has(targetID)) {
        return api.sendMessage(
          [fmt.header(), "", fmt.wrn("كنية " + targetName + " ليست مقفولة.")].join("\n"),
          threadID
        ).catch(() => {});
      }
      threadLocks.delete(targetID);
      if (threadLocks.size === 0) lockedNicknames.delete(threadID);
      api.sendMessage(
        [fmt.header(), "", fmt.ok("تم فك قفل كنية " + targetName + ". 🔓")].join("\n"),
        threadID
      ).catch(() => {});
    }
  },
};
