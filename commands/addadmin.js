"use strict";

const fmt       = require("../utils/fmt");
const config    = require("../config.json");
const botAdmins = require("../utils/botAdmins");

module.exports = {
  name: "addadmin",
  aliases: ["removeadmin", "admins", "مشرف", "مشرفين"],
  description: "رفع عضو لمشرف بوت أو إزالته، عن طريق الرد على رسالته.",
  usage: [
    "-addadmin          ← بالرد على رسالة عضو: رفعه مشرفاً",
    "-removeadmin       ← بالرد على رسالة مشرف: إزالة صلاحياته",
    "-admins            ← عرض قائمة مشرفي البوت",
  ].join("\n"),
  category: "Admin",
  adminOnly: true,

  async execute({ api, event, args }) {
    const { threadID, senderID, messageReply } = event;

    // اكتشاف الأمر المُستدعى فعلياً (للتمييز بين الأسماء المستعارة)
    const invokedAs = (event.body || "")
      .slice(config.prefix.length).trim()
      .split(/\s+/)[0].toLowerCase();

    const sub = (args[0] || "").toLowerCase();

    // ── قائمة المشرفين ─────────────────────────────────────────────────────
    const wantsList =
      invokedAs === "admins" || invokedAs === "مشرفين" ||
      sub === "admins" || sub === "list" || sub === "مشرفين";

    if (wantsList) {
      const list = botAdmins.list();
      if (!list.length) {
        return api.sendMessage(
          [fmt.header(), "", fmt.wrn("لا يوجد مشرفو بوت مسجلون.")].join("\n"),
          threadID
        ).catch(() => {});
      }

      // جلب أسماء المشرفين من Facebook
      let nameMap = {};
      try {
        const info = await api.getUserInfo(list);
        nameMap = info || {};
      } catch {}

      const lines = [
        fmt.header("قائمة مشرفي البوت"),
        "",
        "👑  مشرفو البوت  (" + list.length + ")",
        fmt.divider(),
      ];

      list.forEach((id, i) => {
        const name  = nameMap[id]?.name || nameMap[id]?.fullName || null;
        const badge = i === 0 ? "👑 مشرف رئيسي" : "🛡️ مشرف";
        const label = name ? name : "مستخدم";
        lines.push(
          "  " + (i + 1) + ".  " + label,
          "      🆔  " + id + "  •  " + badge
        );
        if (i < list.length - 1) lines.push(fmt.thin());
      });

      lines.push(fmt.divider());
      lines.push(fmt.inf("المجموع: " + list.length + " مشرف" + (list.length === 1 ? "" : "ين")));

      return api.sendMessage(lines.join("\n"), threadID).catch(() => {});
    }

    // ── إزالة مشرف ─────────────────────────────────────────────────────────
    const wantsRemove =
      invokedAs === "removeadmin" ||
      sub === "removeadmin" || sub === "remove" || sub === "del";

    if (wantsRemove) {
      const targetID = messageReply && messageReply.senderID
        ? String(messageReply.senderID)
        : (Object.keys(event.mentions || {})[0] || args[1] || args[0]);

      if (!targetID || targetID === "removeadmin") {
        return api.sendMessage(
          fmt.err("ارد على رسالة الشخص الذي تريد إزالة صلاحياته، أو مَنشن."),
          threadID
        ).catch(() => {});
      }
      if (botAdmins.isPrimary(targetID)) {
        return api.sendMessage(fmt.err("لا يمكن إزالة المشرف الرئيسي."), threadID).catch(() => {});
      }
      const removed = botAdmins.remove(targetID);
      if (!removed) {
        return api.sendMessage(fmt.wrn("هذا المستخدم ليس مشرفاً."), threadID).catch(() => {});
      }
      let removeName = targetID;
      try { const i = await api.getUserInfo([targetID]); removeName = i?.[targetID]?.name || targetID; } catch {}
      return api.sendMessage(
        [fmt.header(), "", fmt.ok("تمت إزالة صلاحيات " + removeName + ".  🚫")].join("\n"),
        threadID
      ).catch(() => {});
    }

    // ── رفع مشرف (addadmin) ─────────────────────────────────────────────────
    // الأولوية: رد على رسالة → منشن → ID مباشر في الأرقام
    const targetID = messageReply && messageReply.senderID
      ? String(messageReply.senderID)
      : (Object.keys(event.mentions || {})[0] || args[0]);

    if (!targetID || targetID === "addadmin" || targetID === "مشرف") {
      return api.sendMessage(
        [
          fmt.header(),
          "",
          fmt.row("رفع مشرف",   "رد على رسالة العضو ثم: " + config.prefix + "addadmin",    "👑"),
          fmt.row("إزالة مشرف", "رد على رسالته ثم: " + config.prefix + "removeadmin",       "🚫"),
          fmt.row("القائمة",    config.prefix + "admins",                                      "📋"),
        ].join("\n"),
        threadID
      ).catch(() => {});
    }

    if (String(targetID) === String(senderID)) {
      return api.sendMessage(fmt.err("لا يمكنك رفع نفسك."), threadID).catch(() => {});
    }

    const added = botAdmins.add(targetID);
    if (!added) {
      return api.sendMessage(fmt.wrn("هذا المستخدم مشرف بالفعل."), threadID).catch(() => {});
    }
    let addName = targetID;
    try { const i = await api.getUserInfo([targetID]); addName = i?.[targetID]?.name || targetID; } catch {}
    return api.sendMessage(
      [
        fmt.header(),
        "",
        fmt.ok("تم رفع " + addName + " لمشرف بوت. 👑"),
        fmt.inf("يمكنه الآن استخدام جميع أوامر الأدمن."),
      ].join("\n"),
      threadID
    ).catch(() => {});
  },
};
