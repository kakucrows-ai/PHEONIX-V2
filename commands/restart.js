"use strict";

const fmt    = require("../utils/fmt");
const config = require("../config.json");

module.exports = {
  name: "restart",
  aliases: ["reboot", "إعادة"],
  description: "إعادة تشغيل البوت. (مشرف البوت فقط)",
  usage: "restart",
  category: "Admin",
  adminOnly: true,

  async execute({ api, event, restartBot }) {
    const { threadID } = event;
    const name = (config.bot && config.bot.name) || "Phoenix";

    await api.sendMessage(
      [
        fmt.header(),
        "",
        "🔄 جارٍ إعادة تشغيل " + name + "...",
        fmt.inf("سيعود البوت خلال لحظات."),
      ].join("\n"),
      threadID
    ).catch(() => {});

    // تأخير قصير ليُرسل الرسالة أولاً ثم يُعيد التشغيل بدون إيقاف العملية
    setTimeout(() => {
      if (typeof restartBot === "function") {
        restartBot("user command");
      } else {
        // احتياطي: إذا لم تُمرَّر الدالة (لا ينبغي أن يحدث)
        process.exit(0);
      }
    }, 1500);
  },
};
