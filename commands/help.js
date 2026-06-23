"use strict";

const fs     = require("fs");
const path   = require("path");
const config = require("../config.json");
const fmt    = require("../utils/fmt");

const GIF_PATH = path.resolve(__dirname, "../assets/help-banner.gif");

const COMMANDS = [
  { cmd: "help",           desc: "عرض هذه القائمة" },
  { cmd: "control",        desc: "التحكم بإعدادات البوت" },
  { cmd: "rename",         desc: "تغيير اسم المجموعة / قفله" },
  { cmd: "rename unlock",  desc: "رفع قفل اسم المجموعة" },
  { cmd: "nickname",       desc: "تعيين / قفل / مسح الكنيات" },
  { cmd: "lock",           desc: "قفل البوت — لا يستجيب إلا للمشرفين" },
  { cmd: "uptime",         desc: "مدة تشغيل البوت" },
  { cmd: "autoreply",      desc: "الردود التلقائية" },
  { cmd: "simstatus",      desc: "حالة محاكي الإنسان" },
  { cmd: "cookiestatus",   desc: "حالة تحديث الكوكيز" },
  { cmd: "addadmin",       desc: "رفع عضو لمشرف بوت (رد على رسالته)" },
  { cmd: "restart",        desc: "إعادة تشغيل البوت" },
];

module.exports = {
  name: "help",
  aliases: ["مساعدة", "commands", "cmds"],
  description: "عرض قائمة الأوامر المتاحة.",
  usage: "help",
  category: "General",

  async execute({ api, event }) {
    const { threadID } = event;
    const p    = config.prefix;
    const name = (config.bot && config.bot.name) || "Phoenix";

    const lines = [
      fmt.header(),
      "",
      "🤖  " + name + " — الأوامر المتاحة",
      fmt.divider(),
    ];

    for (const { cmd, desc } of COMMANDS) {
      lines.push(fmt.row(p + cmd, desc, "›"));
    }

    lines.push(
      "",
      fmt.divider(),
      fmt.inf("جميع الأوامر تبدأ بـ  " + p),
    );

    // 1) إرسال قائمة الأوامر نصياً أولاً
    await api.sendMessage(lines.join("\n"), threadID);

    // 2) إرسال الـ GIF بعدها إن كانت موجودة
    if (fs.existsSync(GIF_PATH)) {
      try {
        await api.sendMessage(
          { body: "", attachment: fs.createReadStream(GIF_PATH) },
          threadID
        );
      } catch {}
    }
  },
};
