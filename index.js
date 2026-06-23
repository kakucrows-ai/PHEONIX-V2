"use strict";

const fs   = require("fs");
const path = require("path");

// ── Bootstrap: logger & config first ──────────────────────────────────────────
const logger    = require("./utils/logger");
const { validate: validateConfig } = require("./utils/config-validator");
const rawConfig = require("./config.json");
const config    = validateConfig(rawConfig);

// ── Core utils ─────────────────────────────────────────────────────────────────
const { SessionManager } = require("./utils/session");
const antiSpam           = require("./utils/antiSpam");
const banManager         = require("./utils/banManager");
const { lockedNames }    = require("./utils/lockedNames");
const nicknameLocks      = require("./utils/nicknameLocks");
const { revertIfLocked } = nicknameLocks;
const health             = require("./utils/health");
const diagnostics        = require("./utils/diagnostics");
const { startupSelfCheck, schedule: scheduleMaintenance } = require("./utils/maintenance");
const humanSimulator     = require("./utils/humanSimulator");
const cookieRefresher    = require("./utils/cookieRefresher");
const { login }          = require("@neoaz07/nkxfca");

const { lockedThreads, totalLockedThreads, mutedThreads, groupsCache, autoReplies, groupStats, replyDelay } = require("./state");
const { setBotApi, setBotStatus, logActivity, logViolation, startApiServer, setCookieRefresher } = require("./api");
const pendingReplies = require("./utils/pendingReplies");
const botAdmins      = require("./utils/botAdmins");
const threadScanner  = require("./utils/threadScanner");
const adminCache     = require("./utils/threadAdminCache");
const humanDelay     = require("./utils/humanDelay");
const rateLimiter    = require("./utils/rateLimiter");

// ── Config constants ──────────────────────────────────────────────────────────
const APP_STATE_PATH = path.resolve(__dirname, config.appStatePath);
const COMMANDS_DIR   = path.resolve(__dirname, "commands");
const GH_TOKEN       = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "";
const GH_REPO        = "marwanbou20100-cyber/messenger-bot";

// ── Session manager ───────────────────────────────────────────────────────────
const session = new SessionManager(APP_STATE_PATH, GH_TOKEN, GH_REPO);

// ── Anti-spam configuration ───────────────────────────────────────────────────
antiSpam.configure(config.features.antiSpamCooldownMs);

// ── Startup checks ────────────────────────────────────────────────────────────
startupSelfCheck(APP_STATE_PATH);
scheduleMaintenance();

// ── Health watchdog ───────────────────────────────────────────────────────────
health.start({
  diagnostics,
  onCritical: async (type, report) => {
      logger.error("Bot", "Health critical event: " + type, report);
      await diagnostics.createSnapshot("health_" + type).catch(() => {});
      if (type === "memory_critical") {
        logger.error("Bot", "Memory critical — restarting process in 5s...");
        setTimeout(() => process.exit(1), 5000);
      }
    },
});

// ── Command loader ─────────────────────────────────────────────────────────────
function loadCommands() {
  const commands = new Map();
  if (!fs.existsSync(COMMANDS_DIR)) return commands;
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith(".js"));
  for (const file of files) {
    try {
      delete require.cache[require.resolve(path.join(COMMANDS_DIR, file))];
      const cmd = require(path.join(COMMANDS_DIR, file));
      if (!cmd.name || typeof cmd.execute !== "function") continue;
      commands.set(cmd.name.toLowerCase(), cmd);
      if (Array.isArray(cmd.aliases)) {
        for (const alias of cmd.aliases) commands.set(alias.toLowerCase(), cmd);
      }
      logger.debug("Commands", "Loaded: " + cmd.name);
    } catch (e) {
      logger.warn("Commands", "Failed to load " + file + ": " + e.message);
      diagnostics.recordError("Commands", e, { file });
    }
  }
  logger.success("Commands", [...new Set(commands.values())].length + " command(s) loaded.");
  return commands;
}

// ── Permission helpers ────────────────────────────────────────────────────────
function isBotAdmin(senderID) {
  // Use dynamic botAdmins so -botadmin add/remove takes effect immediately
  return botAdmins.isAdmin(String(senderID));
}

async function isThreadAdmin(api, senderID, threadID) {
    const hit = adminCache.get(threadID, senderID);
    if (hit !== null) return hit;
    try {
      const info     = await api.getThreadInfo(threadID);
      const adminIDs = (info.adminIDs || []).map(a => a.id);
      if (info.name && groupsCache.has(threadID)) {
        const cached = groupsCache.get(threadID);
        groupsCache.set(threadID, {
          ...cached,
          name:        info.name,
          memberCount: info.participantIDs ? info.participantIDs.length : cached.memberCount,
        });
      }
      const result = adminIDs.includes(senderID);
      adminCache.set(threadID, senderID, result);
      return result;
    } catch {
      return false;
    }
  }

// ── Template formatter ────────────────────────────────────────────────────────
function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "{" + k + "}");
}

// ── MQTT reconnect watchdog ───────────────────────────────────────────────────
let _lastEventAt    = Date.now();
let _mqttErrorCount = 0;
const MQTT_STALE_MS = 8 * 60 * 1000;
let _mqttWatchdog   = null;

// ── Soft-restart handle (set inside startBot login callback) ─────────────────
let _restartBot = null;

function startMqttWatchdog(reconnectFn) {
  if (_mqttWatchdog) clearInterval(_mqttWatchdog);
  _mqttErrorCount = 0;
  _mqttWatchdog = setInterval(() => {
    const staleness = Date.now() - _lastEventAt;
    if (staleness > MQTT_STALE_MS) {
      logger.error("MQTT", "No events for " + Math.round(staleness / 60000) + "min — restarting...");
      diagnostics.recordError("MQTT", new Error("stale_connection"), { staleness });
      clearInterval(_mqttWatchdog);
      _mqttWatchdog = null;
      reconnectFn();
    }
  }, 60000);
  _mqttWatchdog.unref();
}

// ── Message handler ───────────────────────────────────────────────────────────
async function handleMessage(api, event, commands) {
  const { type, body, threadID, senderID } = event;
  if (type !== "message") return;

  const botID = api.getCurrentUserID();
  if (senderID === botID) return;

  // Total lock — ignore EVERYONE except bot admin
  if (totalLockedThreads.has(threadID) && !isBotAdmin(senderID)) return;

  // Ban check — silently ignore globally banned users
  if (banManager.isBanned(senderID)) return;

  // Banned words check — loaded dynamically from data/security.json
  if (body) {
    try {
      const _secPath = path.join(__dirname, "data", "security.json");
      if (fs.existsSync(_secPath)) {
        const _sec = JSON.parse(fs.readFileSync(_secPath, "utf8"));
        const _bw  = Array.isArray(_sec.bannedWords) ? _sec.bannedWords : [];
        if (_bw.length > 0) {
          const _lower = body.toLowerCase();
          if (_bw.some(w => w && _lower.includes(w.toLowerCase()))) return;
        }
      }
    } catch {}
  }

  // Abuse check — temporarily block spam abusers
  if (config.features.antiSpam && antiSpam.isAbuser(senderID)) return;

  _lastEventAt = Date.now();

  const isGroup =
    event.isGroup === true ||
    (Array.isArray(event.participantIDs) && event.participantIDs.length > 2) ||
    (event.isGroup !== false && threadID && senderID && threadID !== senderID);

  if (isGroup) {
    const cached = groupsCache.get(threadID) || {};
    groupsCache.set(threadID, {
      name:        cached.name || null,
      memberCount: event.participantIDs ? event.participantIDs.length : (cached.memberCount || 0),
      lastSeen:    Date.now(),
    });
    const stats = groupStats.get(threadID) || { messageCount: 0, commandCount: 0, lastMessageAt: 0 };
    stats.messageCount++;
    stats.lastMessageAt = Date.now();
    groupStats.set(threadID, stats);

    if (body) {
      const ar = autoReplies.get(threadID);
      if (ar && ar.enabled && ar.message && !body.startsWith(config.prefix)) {
        const now      = Date.now();
        const lastSent = ar.lastSent.get(senderID) || 0;
        if (now - lastSent >= ar.cooldownMs) {
          ar.lastSent.set(senderID, now);
          const delayMs = ar.delayMs || 0;
          if (delayMs > 0) {
            setTimeout(() => api.sendMessage(ar.message, threadID).catch(() => {}), delayMs);
          } else {
            api.sendMessage(ar.message, threadID).catch(() => {});
          }
        }
      }
    }
  }

  if (mutedThreads.has(threadID)) {
    const until = mutedThreads.get(threadID);
    if (Date.now() < until) return;
    mutedThreads.delete(threadID);
  }

  let cachedIsThreadAdmin = null;
  if (lockedThreads.has(threadID)) {
    const botAdm = isBotAdmin(senderID);
    if (!botAdm) {
      cachedIsThreadAdmin = await isThreadAdmin(api, senderID, threadID);
      if (!cachedIsThreadAdmin) {
        const cached = groupsCache.get(threadID);
        logViolation({ threadID, threadName: (cached && cached.name) || threadID, senderID, messagePreview: (body || "").slice(0, 80) });
        return;
      }
    } else { cachedIsThreadAdmin = true; }
  }

  const _pendingEntry = pendingReplies.get(senderID);
  if (_pendingEntry && (!body || !body.startsWith(config.prefix))) {
    let _keepAlive = false;
    try {
      const _result = await _pendingEntry.handler((body || "").trim(), api, event);
      _keepAlive = (_result === pendingReplies.KEEP);
    } catch (e) {
      logger.error("PendingReply", "Handler error: " + e.message);
      api.sendMessage("❌ حدث خطأ في معالجة ردك. حاول مجدداً.", threadID).catch(() => {});
    } finally {
      if (!_keepAlive) pendingReplies.del(senderID);
    }
    return;
  }

  if (!body) return;
  if (!body.startsWith(config.prefix)) return;

  const trimmed = body.slice(config.prefix.length).trim();
  const args    = trimmed.split(/\s+/);
  const name    = args.shift().toLowerCase();
  if (!name) return;

  const cmd = commands.get(name);
  if (!cmd) {
    return api.sendMessage(fmt(config.messages.commandNotFound, { cmd: name, prefix: config.prefix }), threadID).catch(() => {});
  }

  if (cmd.groupOnly && !isGroup) {
    return api.sendMessage("❌ هذا الأمر للمجموعات فقط.", threadID).catch(() => {});
  }

  if (cmd.adminOnly && !isBotAdmin(senderID)) {
    return api.sendMessage("🔒 هذا الأمر خاص بمشرف البوت فقط.", threadID).catch(() => {});
  }

  if (config.features.antiSpam && antiSpam.isOnCooldown(senderID, cmd.name)) {
    const remaining = (antiSpam.getRemainingCooldown(senderID, cmd.name) / 1000).toFixed(1);
    return api.sendMessage("⏳ انتظر " + remaining + " ثانية قبل استخدام هذا الأمر مجدداً.", threadID).catch(() => {});
  }
  if (config.features.antiSpam) antiSpam.setCooldown(senderID, cmd.name);

  logger.info("Command", "[" + threadID + "] " + senderID + " → " + config.prefix + cmd.name + " " + args.join(" "));
  if (isGroup) {
    const cs = groupStats.get(threadID) || { messageCount: 0, commandCount: 0, lastMessageAt: 0 };
    cs.commandCount++;
    groupStats.set(threadID, cs);
  }

  // ── Rate limit: prevent API bursts that trigger Facebook blocks ─────────
  await rateLimiter.throttle();

  // ── Human-like response timing ────────────────────────────────────────
  // read pause → typing indicator → think pause → execute → stop typing
  await humanDelay.withTyping(api, threadID, cmd.name, event.body || "", async () => {
    await cmd.execute({ api, event: { ...event, isGroup }, args, commands, mutedThreads, lockedThreads, restartBot: _restartBot });
  }).catch(async (e) => {
    logger.error("Command", "Error in " + config.prefix + cmd.name + ": " + e.message);
    diagnostics.recordError("Command", e, { cmd: cmd.name, threadID, senderID });
    await api.sendMessage(config.messages.errorOccurred, threadID).catch(() => {});
  });
}

// ── Event handler ─────────────────────────────────────────────────────────────
async function handleEvent(api, event) {
  const { type, threadID, logMessageData, logMessageType } = event;
  if (type !== "event") return;

  _lastEventAt = Date.now();

  if (logMessageType === "log:thread-name") {
    const locked  = lockedNames.get(threadID);
    const newName = logMessageData?.name || logMessageData?.threadName || "";
    if (locked && newName && newName !== locked) {
      try { await api.gcname(locked, threadID); }
      catch (e) { logger.error("LockName", "Failed to revert group name: " + e.message); }
    }
  }

  // ── Instant nickname revert when a locked member changes their nickname ──
  if (logMessageType === "log:nickname" || logMessageType === "log:user-nickname") {
    const changedUID = String(
      logMessageData?.participant_id || logMessageData?.userID ||
      logMessageData?.participantId  || logMessageData?.userId  || ""
    );
    if (changedUID) {
      revertIfLocked(threadID, changedUID).catch(() => {});
    }
  }

  // ── Auto-join: accept when bot itself is added to a group ────────────
  if (logMessageType === "log:subscribe") {
    const _botID  = String(api.getCurrentUserID());
    const _added  = (logMessageData?.addedParticipants || [])
      .map(p => String(p.userFbId || p.id || p.fbid || ""))
      .filter(Boolean);
    if (_added.includes(_botID)) {
      try { await api.handleMessageRequest(threadID, true); } catch {}
      logger.info("AutoJoin", "Bot added to group " + threadID + " — auto-accepted.");
      setTimeout(() => {
        api.sendMessage(
          "👋 مرحباً! أنا " + config.bot.name + " v" + config.bot.version + " 🤖\n" +
          "اكتب " + config.prefix + "help لعرض الأوامر المتاحة.",
          threadID
        ).catch(() => {});
      }, 3000 + Math.floor(Math.random() * 5000));
    }
  }

  if (logMessageType === "log:subscribe" && config.features.greetNewMembers) {
    const added = logMessageData?.addedParticipants?.map(p => p.userFbId || p.id) || [];
    const botID = api.getCurrentUserID();
    for (const uid of added) {
      if (uid === botID) continue;
      try {
        const info = await api.getUserInfo([uid]);
        const name = info[uid]?.name || uid;
        api.sendMessage(fmt(config.messages.greet, { name }), threadID).catch(() => {});
      } catch {}
    }
  }

  if (logMessageType === "log:unsubscribe" && config.features.farewellMembers) {
    const uid = logMessageData?.leftParticipantFbId;
    if (uid) {
      try {
        const info = await api.getUserInfo([uid]);
        const name = info[uid]?.name || uid;
        api.sendMessage(fmt(config.messages.farewell, { name }), threadID).catch(() => {});
      } catch {}
    }
  }
}


  // ── Keepalive ping every 5 minutes ─────────────────────────────────────────────
  let _keepaliveTimer = null;
  function startKeepalive(api) {
    if (_keepaliveTimer) clearInterval(_keepaliveTimer);
    _keepaliveTimer = setInterval(async () => {
      try {
        await api.getUserInfo([api.getCurrentUserID()]);
        _lastEventAt = Date.now();
        logger.debug("Keepalive", "Ping OK");
      } catch (e) {
        logger.warn("Keepalive", "Ping failed: " + e.message);
      }
    }, 5 * 60 * 1000);
    if (_keepaliveTimer.unref) _keepaliveTimer.unref();
  }
  function stopKeepalive() {
    if (_keepaliveTimer) { clearInterval(_keepaliveTimer); _keepaliveTimer = null; }
  }

  // ── Bot launcher with exponential backoff ─────────────────────────────────────
let _restartAttempt = 0;
const MAX_RESTART_DELAY = 300000;

function startBot() {
  // Stop cookie refresher from previous session before relaunching
  cookieRefresher.stop();

  const appState = session.load();
  const commands = loadCommands();

  logger.info("Bot", "Starting " + config.bot.name + " v" + config.bot.version + " (attempt " + (_restartAttempt + 1) + ")...");

  const credentials = { appState };
  if (config.credentials && config.credentials.email && config.credentials.password) {
    credentials.email    = config.credentials.email;
    credentials.password = config.credentials.password;
    logger.info("Bot", "Email/password credentials loaded for auto re-login.");
  }

  let loginTimer = setTimeout(() => {
    logger.error("Bot", "Login timed out after 2 minutes — forcing retry.");
    diagnostics.recordError("Bot", new Error("login_timeout"));
    _restartAttempt++;
    const delay = Math.min(30000 * Math.pow(1.5, Math.min(_restartAttempt, 8)), MAX_RESTART_DELAY);
    setBotStatus("offline — login timeout, retrying...");
    setTimeout(startBot, delay);
  }, 120000);

  login(credentials, config.loginOptions, async (err, api) => {
    clearTimeout(loginTimer);

    if (err) {
      logger.error("Bot", "Login failed:", err.error || err.message || String(err));
      diagnostics.recordError("Bot", new Error(String(err.error || err.message || err)));

      if (err.error === "login-approval" || String(err).includes("checkpoint")) {
        logger.error("Bot", "Account requires human verification — stopping auto-retry.");
        setBotStatus("offline — checkpoint required");
        return;
      }

      _restartAttempt++;
      const delay = Math.min(30000 * Math.pow(1.5, Math.min(_restartAttempt, 8)), MAX_RESTART_DELAY);
      logger.info("Bot", "Retrying in " + (delay / 1000).toFixed(0) + "s (attempt " + _restartAttempt + ")...");
      setBotStatus("offline — retrying...");
      setTimeout(startBot, delay);
      return;
    }

    _restartAttempt = 0;
    const botID = api.getCurrentUserID();
    logger.success("Bot", "Logged in! Bot ID: " + botID);
    logger.info("Bot", "Prefix: \"" + config.prefix + "\" | Commands: " + [...new Set(commands.values())].length);

    // Save fresh cookies immediately after login
    try {
      const fresh = api.getAppState();
      if (Array.isArray(fresh) && fresh.length > 0) {
        await session.saveAndPush(fresh);
        logger.success("AppState", "Fresh cookies saved and pushed after login.");
      }
    } catch (e) {
      logger.warn("AppState", "Post-login save failed: " + e.message);
    }

    // ── Start cookie auto-refresher v3 (every 5 minutes, mutex-protected) ──
    cookieRefresher.start(api, session);
    setCookieRefresher(cookieRefresher);

    setBotApi(api);
    threadScanner.setApi(api);
    setBotStatus("online");
    nicknameLocks.setApi(api);
    startKeepalive(api);

    // Restore scheduled auto-reply timers saved from previous session
    for (const cmd of new Set(commands.values())) {
      if (typeof cmd._restoreSchedules === "function") {
        try { cmd._restoreSchedules(api); } catch (e) {
          logger.warn("Bot", "Failed to restore schedules for " + cmd.name + ": " + e.message);
        }
      }
    }

    if (config.humanSimulator && config.humanSimulator.enabled) {
      humanSimulator.start(api, config.humanSimulator);
      logger.info("HumanSim", "Human simulator started.");
    }

    api.onReLoginSuccess = async () => {
      logger.success("Bot", "Auto re-login succeeded.");
      try {
        const fresh = api.getAppState();
        if (Array.isArray(fresh) && fresh.length > 0) await session.saveAndPush(fresh);
      } catch {}
    };

    api.onReLoginFailure = async (e) => {
      logger.error("Bot", "Auto re-login failed permanently:", e.message);
      setBotStatus("offline — re-login failed");
      cookieRefresher.stop();
      await diagnostics.createSnapshot("relogin_failure");
      logger.info("Bot", "Will restart process in 60s...");
      try { if (typeof cookieRefresher.emergencyFlush === "function") await cookieRefresher.emergencyFlush(); } catch {}
      setTimeout(() => process.exit(1), 60000);
    };

    _lastEventAt = Date.now();

    // ── Internal soft-restart (no process.exit) ───────────────────────────
    _restartBot = async function restartBot(reason) {
      logger.info("Bot", "Soft restart requested" + (reason ? ": " + reason : "") + " — restarting in 3s...");
      setBotStatus("offline — restarting...");
      try { if (typeof cookieRefresher.emergencyFlush === "function") await cookieRefresher.emergencyFlush(); } catch {}
      cookieRefresher.stop();
      humanSimulator.stop();
      stopKeepalive();
      if (_mqttWatchdog) { clearInterval(_mqttWatchdog); _mqttWatchdog = null; }
      setTimeout(startBot, 3000);
    };

    startMqttWatchdog(() => {
      logger.info("Bot", "MQTT watchdog triggered reconnect.");
      setBotStatus("offline — reconnecting...");
      cookieRefresher.stop();
      humanSimulator.stop();
      stopKeepalive();
      setTimeout(startBot, 5000);
    });

    api.listenMqtt(async (mqttErr, event) => {
      if (mqttErr) {
        _mqttErrorCount++;
        logger.warn("MQTT", "Listen error #" + _mqttErrorCount + ": " + (mqttErr.message || mqttErr));
        diagnostics.recordError("MQTT", mqttErr instanceof Error ? mqttErr : new Error(String(mqttErr)));
        if (_mqttErrorCount >= 3) {
          logger.error("MQTT", "3 consecutive errors — forcing reconnect.");
          if (_mqttWatchdog) { clearInterval(_mqttWatchdog); _mqttWatchdog = null; }
          setBotStatus("offline — reconnecting...");
          cookieRefresher.stop();
          humanSimulator.stop();
          setTimeout(startBot, 10000);
        }
        return;
      }
      _mqttErrorCount = 0;
      if (!event) return;
      _lastEventAt = Date.now();
      try {
        if (event.type === "message")    await handleMessage(api, event, commands);
        else if (event.type === "event") await handleEvent(api, event);
      } catch (e) {
        logger.error("Bot", "Unhandled event error: " + e.message);
        diagnostics.recordError("Bot", e);
      }
    });

    logger.success("Bot", "Listening via MQTT...");
  });
}

// ── Process-level safety net ──────────────────────────────────────────────────
process.on("uncaughtException", async (e) => {
  logger.error("Process", "Uncaught exception: " + e.message);
  logger.error("Process", e.stack);
  diagnostics.recordError("Process", e);
  await diagnostics.createSnapshot("uncaught_exception").catch(() => {});
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.warn("Process", "Unhandled rejection: " + msg);
  diagnostics.recordError("Process", reason instanceof Error ? reason : new Error(msg));
});

async function _gracefulShutdown(sig) {
  logger.info("Bot", sig + " received — saving session before exit...");
  try { if (typeof cookieRefresher.emergencyFlush === "function") await cookieRefresher.emergencyFlush(); } catch {}
  cookieRefresher.stop();
  humanSimulator.stop();
  stopKeepalive();
  logger.info("Bot", "Graceful shutdown complete ✅");
  process.exit(0);
}
process.on("SIGINT",  () => _gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => _gracefulShutdown("SIGTERM"));

// ── Start everything ──────────────────────────────────────────────────────────
startApiServer();
startBot();
