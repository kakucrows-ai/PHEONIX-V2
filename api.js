"use strict";

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
const config  = require("./config.json");
const logger  = require("./utils/logger");
const diagnostics    = require("./utils/diagnostics");
const health         = require("./utils/health");
const humanSimulator = require("./utils/humanSimulator");
const rateLimiter    = require("./utils/rateLimiter");
const {
  lockedThreads, mutedThreads, groupsCache,
  activityLog, lockViolations, autoReplies, groupStats, save: saveState,
} = require("./state");

let botApi           = null;
let startTime        = Date.now();
let botStatus        = "connecting";
let _cookieRefresher = null;

function setBotApi(api)              { botApi = api; startTime = Date.now(); }
function setBotStatus(s)             { botStatus = s; }
function setCookieRefresher(cr)      { _cookieRefresher = cr; }

function logActivity(msg) {
  activityLog.push({ time: Date.now(), message: String(msg) });
  if (activityLog.length > 300) activityLog.shift();
}

function logViolation({ threadID, threadName, senderID, messagePreview }) {
  lockViolations.push({ time: Date.now(), threadID, threadName, senderID, messagePreview });
  if (lockViolations.length > 200) lockViolations.shift();
}

// ── Rate limiter ──────────────────────────────────────────────────────────────
const _reqMap = new Map();
function _rateLimit(maxPerMinute = 60) {
  return (req, res, next) => {
    const ip  = req.ip || req.socket.remoteAddress || "unknown"; // FIXED: req.connection is deprecated/undefined on Node 18+; use req.socket
    const now = Date.now();
    const rec = _reqMap.get(ip) || { count: 0, reset: now + 60000 };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + 60000; }
    rec.count++;
    _reqMap.set(ip, rec);
    if (rec.count > maxPerMinute) return res.status(429).json({ error: "Too many requests. Slow down." });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _reqMap) { if (now > rec.reset) _reqMap.delete(ip); }
}, 300000).unref();

// ── Auth middleware (fail-closed) ─────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (req.path === "/auth/login" || req.path === "/" || req.path.startsWith("/dashboard")) return next();
  const key        = _getEffectiveApiKey();
  const authHeader = req.headers["authorization"] || "";
  if (authHeader !== `Bearer ${key}`) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── Input sanitiser ───────────────────────────────────────────────────────────
function sanitize(str, maxLen = 512) {
  if (typeof str !== "string") return "";
  return str.slice(0, maxLen).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── API key helpers (fail-closed) ─────────────────────────────────────────────
const _INSECURE_KEYS = new Set(["changeme-set-a-strong-secret", "changeme", ""]);

function _getEffectiveApiKey() {
  return process.env.DASHBOARD_API_KEY || (config.dashboard && config.dashboard.apiKey) || "";
}

function _isKeySecure(key) {
  return typeof key === "string" && key.length >= 12 && !_INSECURE_KEYS.has(key);
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
const _sseClients = new Set();
function _broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of _sseClients) {
    try { res.write(payload); } catch { _sseClients.delete(res); }
  }
}

function logActivitySSE(msg) {
  const entry = { time: Date.now(), message: String(msg) };
  activityLog.push(entry);
  if (activityLog.length > 300) activityLog.shift();
  _broadcastSSE({ type: "activity", data: entry });
}

// ── API routes ────────────────────────────────────────────────────────────────
function createApiServer() {
  const app = express();

  const dashboardDir = path.join(__dirname, "dashboard");
  if (fs.existsSync(dashboardDir)) {
    app.use("/dashboard", express.static(dashboardDir));
    app.get("/", (req, res) => res.redirect("/dashboard/"));
  }

  app.use(cors({ origin: process.env.CORS_ORIGIN || "*", methods: ["GET", "POST", "PUT", "DELETE"] }));
  app.use(express.json({ limit: "256kb" }));
  app.use(_rateLimit(120));
  app.use(authMiddleware);

  // ── Auth ──────────────────────────────────────────────────────────────────
  app.post("/auth/login", (req, res) => {
    const { key } = req.body || {};
    const cfgKey  = _getEffectiveApiKey();
    if (key !== cfgKey) return res.status(401).json({ error: "Invalid API key" });
    res.json({ success: true, token: cfgKey });
  });

  // ── SSE live stream ───────────────────────────────────────────────────────
  app.get("/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    _sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    req.on("close", () => _sseClients.delete(res));
  });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get("/health", (req, res) => {
    const hs = health.snapshot();
    if (!botApi) return res.json({ status: botStatus, botName: config.bot.name, version: config.bot.version, ...hs });
    res.json({ status: "online", botName: config.bot.name, version: config.bot.version, uptime: Math.floor((Date.now() - startTime) / 1000), groupCount: groupsCache.size, lockedCount: lockedThreads.size, mutedCount: mutedThreads.size, ...hs });
  });

  // ── Overview ──────────────────────────────────────────────────────────────
  app.get("/overview", (req, res) => {
    const hs = health.snapshot();
    let totalMessages = 0, totalCommands = 0;
    for (const s of groupStats.values()) { totalMessages += s.messageCount || 0; totalCommands += s.commandCount || 0; }
    res.json({ status: botStatus, botName: config.bot.name, version: config.bot.version, uptime: botApi ? Math.floor((Date.now() - startTime) / 1000) : 0, groupCount: groupsCache.size, lockedCount: lockedThreads.size, mutedCount: mutedThreads.size, totalMessages, totalCommands, health: hs, humanSim: humanSimulator.status(), recentActivity: activityLog.slice(-10).reverse() });
  });

  app.get("/diagnostics", (req, res) => res.json(diagnostics.report()));

  app.post("/diagnostics/snapshot", async (req, res) => {
    const file = await diagnostics.createSnapshot("api_request");
    res.json({ success: true, file: file ? path.basename(file) : null });
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  app.get("/commands", (req, res) => {
    const COMMANDS_DIR = path.join(__dirname, "commands");
    const list = [];
    try {
      const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith(".js"));
      for (const file of files) {
        try {
          const mod = require(path.join(COMMANDS_DIR, file));
          if (mod.name && mod.execute) list.push({ name: mod.name, description: mod.description || "", aliases: mod.aliases || [], adminOnly: !!mod.adminOnly, groupOnly: !!mod.groupOnly });
        } catch {}
      }
    } catch {}
    res.json(list.sort((a, b) => a.name.localeCompare(b.name)));
  });

  // ── Config ────────────────────────────────────────────────────────────────
  app.get("/config", (req, res) => {
    const safe = JSON.parse(JSON.stringify(config));
    if (safe.credentials) { safe.credentials.email = safe.credentials.email ? "***" : ""; safe.credentials.password = ""; }
    if (safe.dashboard) delete safe.dashboard.apiKey;
    res.json(safe);
  });

  app.put("/config/features", (req, res) => {
    const allowed = ["greetNewMembers", "farewellMembers", "antiSpam", "logMessages", "autoSaveAppState"];
    const updates = {};
    for (const k of allowed) { if (k in req.body) updates[k] = !!req.body[k]; }
    if (req.body.antiSpamCooldownMs) updates.antiSpamCooldownMs = Math.max(500, parseInt(req.body.antiSpamCooldownMs) || 3000);
    Object.assign(config.features, updates);
    logActivitySSE("Features config updated via dashboard");
    res.json({ success: true, features: config.features });
  });

  // ── Human simulator ───────────────────────────────────────────────────────
  app.get("/humansim",  (req, res) => res.json(humanSimulator.status()));
  app.put("/humansim",  (req, res) => {
    const { enabled, presenceIntervalMs, typingIntervalMs, readIntervalMs } = req.body;
    humanSimulator.configure({ enabled, presenceIntervalMs, typingIntervalMs, readIntervalMs });
    logActivitySSE("Human simulator config updated via dashboard");
    res.json({ success: true, status: humanSimulator.status() });
  });

  // ── Cookies — live refresh status & force-push ────────────────────────────
  app.get("/cookies/status", (req, res) => {
    if (!_cookieRefresher) return res.json({ active: false, message: "Bot not connected yet." });
    const s = _cookieRefresher.status();
    res.json({
      ...s,
      lastPushFormatted: s.lastPushAt
        ? new Date(s.lastPushAt).toISOString()
        : null,
    });
  });

  app.post("/cookies/refresh", async (req, res) => {
    if (!_cookieRefresher) return res.status(503).json({ error: "Bot not connected." });
    try {
      const result = await _cookieRefresher.forceRefresh();
      logActivitySSE("Cookies force-refreshed via dashboard");
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Groups ────────────────────────────────────────────────────────────────
  app.get("/groups", (req, res) => {
    const groups = [];
    for (const [threadID, info] of groupsCache.entries()) {
      const muteExpiry = mutedThreads.get(threadID);
      const stats      = groupStats.get(threadID) || {};
      const ar         = autoReplies.get(threadID);
      groups.push({ threadID, name: info.name || threadID, memberCount: info.memberCount || 0, isLocked: lockedThreads.has(threadID), isMuted: muteExpiry != null && Date.now() < muteExpiry, muteExpiresAt: muteExpiry || null, lastSeen: info.lastSeen || 0, messageCount: stats.messageCount || 0, commandCount: stats.commandCount || 0, hasAutoReply: !!(ar && ar.enabled) });
    }
    groups.sort((a, b) => b.lastSeen - a.lastSeen);
    res.json(groups);
  });

  app.get("/groups/:threadID/info", async (req, res) => {
    const { threadID } = req.params;
    if (!botApi) return res.status(503).json({ error: "Bot not connected" });
    try {
      const info = await botApi.getThreadInfo(threadID);
      const cached = groupsCache.get(threadID) || {};
      const stats  = groupStats.get(threadID) || {};
      const muteExpiry = mutedThreads.get(threadID);
      const ar = autoReplies.get(threadID);
      res.json({ threadID, name: info.name || cached.name || threadID, memberCount: (info.participantIDs || []).length, adminCount: (info.adminIDs || []).length, isLocked: lockedThreads.has(threadID), isMuted: muteExpiry != null && Date.now() < muteExpiry, muteExpiresAt: muteExpiry || null, lastSeen: cached.lastSeen || 0, messageCount: stats.messageCount || 0, commandCount: stats.commandCount || 0, hasAutoReply: !!(ar && ar.enabled), autoReplyMsg: ar ? ar.message : null, emoji: info.emoji || null, color: info.color || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/groups/:threadID/stats",  (req, res) => res.json(groupStats.get(req.params.threadID) || {}));

  app.post("/groups/:threadID/lock", (req, res) => {
    const { threadID } = req.params;
    if (req.body.locked) lockedThreads.add(threadID); else lockedThreads.delete(threadID);
    logActivitySSE("Group " + threadID + " " + (req.body.locked ? "locked" : "unlocked") + " via dashboard");
    res.json({ success: true, isLocked: lockedThreads.has(threadID) });
  });

  app.post("/groups/:threadID/mute", (req, res) => {
    const { threadID } = req.params;
    const minutes = parseInt(req.body.minutes) || 0;
    if (minutes <= 0) { mutedThreads.delete(threadID); logActivitySSE("Group " + threadID + " unmuted via dashboard"); return res.json({ success: true, isMuted: false }); }
    const expiresAt = Date.now() + minutes * 60000;
    mutedThreads.set(threadID, expiresAt);
    logActivitySSE("Group " + threadID + " muted " + minutes + "min via dashboard");
    res.json({ success: true, isMuted: true, expiresAt });
  });

  app.post("/groups/:threadID/rename", async (req, res) => {
    const { threadID } = req.params;
    const name = sanitize(req.body.name, 100);
    if (!name)   return res.status(400).json({ error: "name required" });
    if (!botApi) return res.status(503).json({ error: "Bot not connected" });
    try {
      await botApi.gcname(name, threadID);
      const cached = groupsCache.get(threadID) || {};
      groupsCache.set(threadID, { ...cached, name });
      logActivitySSE("Group " + threadID + " renamed to \"" + name + "\" via dashboard");
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/groups/:threadID/message", async (req, res) => {
    const { threadID } = req.params;
    const message = sanitize(req.body.message, 2000);
    if (!message) return res.status(400).json({ error: "message required" });
    if (!botApi)  return res.status(503).json({ error: "Bot not connected" });
    try {
      await botApi.sendMessage(message, threadID);
      logActivitySSE("Message sent to " + threadID + " via dashboard");
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/groups/:threadID/members", async (req, res) => {
    if (!botApi) return res.status(503).json({ error: "Bot not connected" });
    try {
      const info     = await botApi.getThreadInfo(req.params.threadID);
      const ids      = info.participantIDs || [];
      const adminSet = new Set((info.adminIDs || []).map(a => a.id));
      const userInfos = ids.length > 0 ? await botApi.getUserInfo(ids) : {};
      res.json(ids.map(id => ({ userID: id, name: userInfos[id]?.name || id, isAdmin: adminSet.has(id) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post("/groups/:threadID/kick", async (req, res) => {
    const userID = sanitize(req.body.userID, 50);
    if (!userID)  return res.status(400).json({ error: "userID required" });
    if (!botApi)  return res.status(503).json({ error: "Bot not connected" });
    try {
      await botApi.gcmember("remove", userID, req.params.threadID);
      logActivitySSE("User " + userID + " kicked from " + req.params.threadID + " via dashboard");
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Auto-reply ────────────────────────────────────────────────────────────
  app.get("/groups/:threadID/autoreply", (req, res) => {
    const ar = autoReplies.get(req.params.threadID);
    if (!ar) return res.json({ enabled: false, message: "", cooldownMinutes: 30 });
    res.json({ enabled: ar.enabled, message: ar.message, cooldownMinutes: Math.round(ar.cooldownMs / 60000) });
  });

  app.put("/groups/:threadID/autoreply", (req, res) => {
    const { threadID } = req.params;
    const message = sanitize(req.body.message, 2000);
    const { enabled, cooldownMinutes } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });
    const cooldownMs = Math.max(60000, (parseInt(cooldownMinutes) || 30) * 60000);
    const existing   = autoReplies.get(threadID) || { lastSent: new Map() };
    autoReplies.set(threadID, { message, enabled: !!enabled, cooldownMs, lastSent: existing.lastSent });
    logActivitySSE("Auto-reply " + (enabled ? "enabled" : "updated") + " for " + threadID);
    res.json({ success: true });
  });

  app.delete("/groups/:threadID/autoreply", (req, res) => {
    autoReplies.delete(req.params.threadID);
    logActivitySSE("Auto-reply removed for " + req.params.threadID);
    res.json({ success: true });
  });

  // ── Pending ───────────────────────────────────────────────────────────────
  app.get("/pending", async (req, res) => {
    if (!botApi) return res.status(503).json({ error: "Bot not connected" });
    try {
      const threads = await botApi.getThreadList(20, null, ["PENDING"]);
      res.json((threads || []).map(t => ({ threadID: t.threadID, name: t.name || t.threadID, memberCount: (t.participantIDs || []).length, snippet: t.snippet || "", timestamp: t.timestamp || 0 })));
    } catch { res.json([]); }
  });

  app.post("/pending/:threadID/accept", async (req, res) => {
    if (!botApi) return res.status(503).json({ error: "Bot not connected" });
    try {
      const msg = sanitize(req.body.message || ".", 500);
      await botApi.sendMessage(msg, req.params.threadID);
      logActivitySSE("Accepted message request from " + req.params.threadID);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Broadcast ─────────────────────────────────────────────────────────────
  app.post("/broadcast", async (req, res) => {
    if (!req.body.confirm) return res.status(400).json({ error: "confirm: true required to prevent accidental broadcasts" });
    const message    = sanitize(req.body.message, 2000);
    const allTargets = Array.isArray(req.body.threadIDs) ? req.body.threadIDs : [...groupsCache.keys()];
    if (!message)    return res.status(400).json({ error: "message required" });
    if (!botApi)     return res.status(503).json({ error: "Bot not connected" });

    const BATCH_SIZE  = 50;
    const firstBatch  = allTargets.slice(0, BATCH_SIZE);
    const remainder   = allTargets.slice(BATCH_SIZE);
    const totalBatches = Math.ceil(allTargets.length / BATCH_SIZE);

    let sent = 0, failed = 0;
    for (const tid of firstBatch) {
      try { await rateLimiter.throttle(); await botApi.sendMessage(message, tid); sent++; }
      catch { failed++; }
    }

    if (remainder.length > 0) {
      let offset = 0;
      function scheduleBatch() {
        const batch = remainder.slice(offset, offset + BATCH_SIZE);
        if (batch.length === 0) return;
        offset += BATCH_SIZE;
        setTimeout(async () => {
          for (const tid of batch) {
            try { await rateLimiter.throttle(); await botApi.sendMessage(message, tid); } catch {}
          }
          scheduleBatch();
        }, 120000);
      }
      scheduleBatch();
      logActivitySSE(`Broadcast (1/${totalBatches}): ${sent} sent, ${failed} failed — ${remainder.length} scheduled in later batches`);
    } else {
      logActivitySSE("Broadcast: " + sent + " sent, " + failed + " failed");
    }
    res.json({ success: true, sent, failed, scheduled: remainder.length, totalBatches });
  });

  // ── AppState / Cookies ────────────────────────────────────────────────────
  app.get("/appstate/info", (req, res) => {
    const appStatePath = path.resolve(__dirname, config.appStatePath);
    try {
      const stat = fs.statSync(appStatePath);
      const raw  = fs.readFileSync(appStatePath, "utf8");
      const data = JSON.parse(raw);
      res.json({ exists: true, cookieCount: Array.isArray(data) ? data.length : 0, sizeBytes: stat.size, modifiedAt: stat.mtimeMs });
    } catch { res.json({ exists: false, cookieCount: 0, sizeBytes: 0, modifiedAt: null }); }
  });

  app.post("/appstate/upload", async (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: "content required" });
    try {
      const data = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
      if (!Array.isArray(data) || data.length === 0) return res.status(400).json({ error: "Invalid appstate format" });
      const appStatePath = path.resolve(__dirname, config.appStatePath);
      const { SessionManager } = require("./utils/session");
      const sm = new SessionManager(appStatePath, process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "", "marwanbou20100-cyber/messenger-bot"); // FIXED: wrong GitHub repo URL; corrected to match index.js
      const ok = await sm.saveAndPush(data);
      if (!ok) return res.status(500).json({ error: "Failed to save state" });
      logActivitySSE("AppState uploaded and pushed via dashboard");
      res.json({ success: true, cookieCount: data.length });
    } catch (e) { res.status(400).json({ error: "Invalid JSON: " + e.message }); }
  });

  // ── State persistence ─────────────────────────────────────────────────────
  app.post("/state/save", (req, res) => {
    saveState();
    logActivitySSE("State manually saved via dashboard");
    res.json({ success: true });
  });

  // ── Restart ───────────────────────────────────────────────────────────────
  app.post("/restart", async (req, res) => {
    res.json({ success: true, message: "Restarting in 2 seconds..." });
    logActivitySSE("Restart triggered via dashboard");
    try {
      if (botApi) {
        const state = botApi.getAppState();
        if (Array.isArray(state) && state.length > 0) {
          const { SessionManager } = require("./utils/session");
          const s = new SessionManager(path.resolve(__dirname, config.appStatePath), process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "", "marwanbou20100-cyber/messenger-bot"); // FIXED: wrong GitHub repo URL; corrected to match index.js
          s.save(state);
        }
      }
    } catch {}
    setTimeout(() => process.exit(0), 2000);
  });

  // ── Logs & audit ──────────────────────────────────────────────────────────
  app.get("/activity",   (req, res) => res.json(activityLog.slice(-100).reverse()));
  app.get("/violations", (req, res) => res.json(lockViolations.slice(-100).reverse()));

  // ── Reconnect ─────────────────────────────────────────────────────────────
  app.post("/reconnect", (req, res) => {
    res.json({ success: true, message: "Reconnecting..." });
    logActivitySSE("Reconnect triggered via dashboard");
    setTimeout(() => process.exit(0), 1500);
  });

  // ── Session aliases ───────────────────────────────────────────────────────
  app.get("/session", (req, res) => {
    const appStatePath = path.resolve(__dirname, config.appStatePath);
    try {
      const stat = fs.statSync(appStatePath);
      const data = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
      res.json({ valid: true, lastSaved: stat.mtimeMs, size: stat.size, cookieCount: Array.isArray(data) ? data.length : 0 });
    } catch { res.json({ valid: false, lastSaved: null, size: 0 }); }
  });

  app.post("/session/upload", async (req, res) => {
    const raw = req.body.appstate || req.body.content;
    if (!raw) return res.status(400).json({ error: "appstate required" });
    try {
      const data = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
      if (!Array.isArray(data) || !data.length) return res.status(400).json({ error: "Invalid appstate" });
      fs.writeFileSync(path.resolve(__dirname, config.appStatePath), JSON.stringify(data, null, 2));
      logActivitySSE("AppState uploaded via dashboard");
      res.json({ success: true, cookieCount: data.length });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/session/refresh", (req, res) => {
    try {
      if (botApi) {
        const state = botApi.getAppState();
        if (Array.isArray(state) && state.length > 0)
          fs.writeFileSync(path.resolve(__dirname, config.appStatePath), JSON.stringify(state, null, 2));
      }
      logActivitySSE("Session refreshed via dashboard");
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/session", (req, res) => {
    try {
      const p = path.resolve(__dirname, config.appStatePath);
      if (fs.existsSync(p)) fs.writeFileSync(p, "[]");
      logActivitySSE("Session cleared via dashboard");
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Config (full save) ────────────────────────────────────────────────────
  app.post("/config", (req, res) => {
    const allowed = ["features", "humanSimulator", "loginOptions", "messages", "bot"];
    for (const k of allowed) { if (k in req.body) Object.assign(config[k], req.body[k]); }
    logActivitySSE("Config updated via dashboard");
    res.json({ success: true });
  });

  app.get("/features",  (req, res) => res.json(config.features || {}));
  app.post("/features", (req, res) => { Object.assign(config.features, req.body); logActivitySSE("Features updated via dashboard"); res.json({ success: true }); });

  // ── Security ──────────────────────────────────────────────────────────────
  const _secPath = path.join(__dirname, "data", "security.json");
  function _loadSec() { try { return JSON.parse(fs.readFileSync(_secPath, "utf8")); } catch { return {}; } }
  function _saveSec(d) { fs.mkdirSync(path.dirname(_secPath), { recursive: true }); fs.writeFileSync(_secPath, JSON.stringify(d, null, 2)); }

  app.get("/security", (req, res) => {
    const sec = _loadSec();
    res.json({ antiSpamCooldownMs: config.features?.antiSpamCooldownMs ?? 3000, maxRequestsPerMinute: sec.maxRequestsPerMinute ?? 40, requestCooldownMs: sec.requestCooldownMs ?? 60000, maxConcurrentRequests: sec.maxConcurrentRequests ?? 5, bannedWords: sec.bannedWords ?? [] });
  });

  app.post("/security", (req, res) => {
    const sec = _loadSec();
    if (req.body.antiSpamCooldownMs) { config.features = config.features || {}; config.features.antiSpamCooldownMs = parseInt(req.body.antiSpamCooldownMs); }
    if (req.body.maxRequestsPerMinute)  sec.maxRequestsPerMinute  = parseInt(req.body.maxRequestsPerMinute);
    if (req.body.requestCooldownMs)     sec.requestCooldownMs     = parseInt(req.body.requestCooldownMs);
    if (req.body.maxConcurrentRequests) sec.maxConcurrentRequests = parseInt(req.body.maxConcurrentRequests);
    if (Array.isArray(req.body.bannedWords)) sec.bannedWords = req.body.bannedWords.map(w => String(w).toLowerCase().trim()).filter(Boolean);
    _saveSec(sec);
    rateLimiter.reconfigure(sec);
    logActivitySSE("Security settings updated via dashboard — rate limiter reconfigured live");
    res.json({ success: true });
  });

  // ── Bans ──────────────────────────────────────────────────────────────────
  const _bansPath = path.join(__dirname, "data", "bans.json");
  function _loadBans() { try { return JSON.parse(fs.readFileSync(_bansPath, "utf8")); } catch { return []; } }
  function _saveBans(d) { fs.mkdirSync(path.dirname(_bansPath), { recursive: true }); fs.writeFileSync(_bansPath, JSON.stringify(d, null, 2)); }

  app.get("/bans", (req, res) => res.json(_loadBans()));
  app.post("/bans", (req, res) => {
    const uid = sanitize(req.body.uid, 50);
    if (!uid) return res.status(400).json({ error: "uid required" });
    const bans = _loadBans();
    if (bans.find(b => b.uid === uid)) return res.json({ success: true, alreadyBanned: true });
    bans.push({ uid, reason: sanitize(req.body.reason || "", 200), bannedAt: Date.now() });
    _saveBans(bans);
    logActivitySSE("User " + uid + " banned via dashboard");
    res.json({ success: true });
  });
  app.delete("/bans/:uid", (req, res) => {
    const bans = _loadBans().filter(b => b.uid !== req.params.uid);
    _saveBans(bans);
    logActivitySSE("User " + req.params.uid + " unbanned via dashboard");
    res.json({ success: true });
  });

  // ── Audit log ─────────────────────────────────────────────────────────────
  app.get("/audit", (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const all = [...activityLog].reverse().map(a => ({ time: a.time, action: "activity", actor: "bot", detail: a.message, level: "info" }));
    res.json(all.slice(offset, offset + limit));
  });

  // ── Jobs ──────────────────────────────────────────────────────────────────
  const _activeJobs = new Map();
  app.get("/jobs", (req, res) => { const jobs = []; for (const [id, j] of _activeJobs) jobs.push({ id, ...j }); res.json(jobs); });
  app.delete("/jobs/:id", (req, res) => {
    const j = _activeJobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: "Not found" });
    if (j.timer) clearTimeout(j.timer);
    _activeJobs.delete(req.params.id);
    res.json({ success: true });
  });

  // ── Allowlist ─────────────────────────────────────────────────────────────
  const _alPath = path.join(__dirname, "data", "allowlist.json");
  function _loadAl() { try { return JSON.parse(fs.readFileSync(_alPath, "utf8")); } catch { return { mode: "off", list: [] }; } }
  function _saveAl(d) { fs.mkdirSync(path.dirname(_alPath), { recursive: true }); fs.writeFileSync(_alPath, JSON.stringify(d, null, 2)); }

  app.get("/allowlist",         (req, res) => res.json(_loadAl()));
  app.post("/allowlist/mode",   (req, res) => { const d = _loadAl(); d.mode = req.body.mode || "off"; _saveAl(d); res.json({ success: true }); });
  app.post("/allowlist/add",    (req, res) => {
    const uid = sanitize(req.body.uid, 50); if (!uid) return res.status(400).json({ error: "uid required" });
    const d = _loadAl(); if (!d.list.includes(uid)) d.list.push(uid); _saveAl(d); res.json({ success: true });
  });
  app.post("/allowlist/remove", (req, res) => {
    const d = _loadAl(); d.list = d.list.filter(x => x !== req.body.uid); _saveAl(d); res.json({ success: true });
  });

  // ── Files (sandboxed) ─────────────────────────────────────────────────────
  const _editableFiles = [
    { name: "config.json",  path: "config.json",  icon: "⚙️" },
    { name: "index.js",     path: "index.js",     icon: "🚀" },
    { name: "api.js",       path: "api.js",        icon: "🔌" },
    { name: "state.js",     path: "state.js",      icon: "💾" },
    { name: "package.json", path: "package.json",  icon: "📦" },
  ];

  app.get("/files", (req, res) => res.json(_editableFiles));

  app.get("/files/:filePath", (req, res) => {
    const safe    = sanitize(req.params.filePath, 100).replace(/\.\./g, "");
    const allowed = _editableFiles.find(f => f.path === safe);
    if (!allowed) return res.status(403).json({ error: "Forbidden: file not in editable list" });
    const abs = path.resolve(__dirname, safe);
    if (!abs.startsWith(__dirname)) return res.status(403).json({ error: "Forbidden" });
    try { res.json({ content: fs.readFileSync(abs, "utf8") }); }
    catch { res.status(404).json({ error: "File not found" }); }
  });

  app.post("/files/:filePath", (req, res) => {
    const safe    = sanitize(req.params.filePath, 100).replace(/\.\./g, "");
    const allowed = _editableFiles.find(f => f.path === safe);
    if (!allowed) return res.status(403).json({ error: "Forbidden: file not in editable list" });
    const abs = path.resolve(__dirname, safe);
    if (!abs.startsWith(__dirname)) return res.status(403).json({ error: "Forbidden" });
    if (typeof req.body.content !== "string") return res.status(400).json({ error: "content required" });
    try { fs.writeFileSync(abs, req.body.content, "utf8"); logActivitySSE("File " + safe + " saved via dashboard"); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete("/files/:filePath", (req, res) => {
    const safe    = sanitize(req.params.filePath, 100).replace(/\.\./g, "");
    const allowed = _editableFiles.find(f => f.path === safe);
    if (!allowed) return res.status(403).json({ error: "Forbidden: file not in editable list" });
    const abs = path.resolve(__dirname, safe);
    if (!abs.startsWith(__dirname)) return res.status(403).json({ error: "Forbidden" });
    try { fs.unlinkSync(abs); logActivitySSE("File " + safe + " deleted via dashboard"); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });


  // ── Cookie update endpoint ────────────────────────────────────────────────────
  app.get("/cookies", (req, res) => {
    res.sendFile(path.resolve(__dirname, "dashboard/cookies.html"));
  });

  app.post("/cookies/update", express.json({ limit: "2mb" }), async (req, res) => { // FIXED: removed inconsistent /api/ prefix; all other routes use no prefix
    const { appState } = req.body || {};
    if (!Array.isArray(appState) || appState.length === 0) {
      return res.status(400).json({ error: "appState must be a non-empty array" });
    }
    // Validate basic cookie structure
    const hasCUser = appState.some(c => c && c.key === "c_user");
    if (!hasCUser) {
      return res.status(400).json({ error: "الكوكيز لا تحتوي على c_user — تأكد من تصدير كوكيز Facebook الصحيحة" });
    }

    const appStatePath = path.resolve(__dirname, "appstate.json");
    try {
      // Backup old appstate
      const backupPath = appStatePath.replace(".json", ".backup.json");
      if (fs.existsSync(appStatePath)) fs.copyFileSync(appStatePath, backupPath);

      // Write new appstate
      fs.writeFileSync(appStatePath, JSON.stringify(appState, null, 2), "utf8");
      logger.success("API", "appstate.json updated via dashboard (" + appState.length + " cookies).");

      // Push to GitHub if session manager is accessible
      try {
        const { SessionManager } = require("./utils/session");
        const ghToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "";
        const ghRepo  = "marwanbou20100-cyber/messenger-bot";
        if (ghToken) {
          const sm = new SessionManager(appStatePath, ghToken, ghRepo);
          await sm.pushToGitHub();
        }
      } catch (e) {
        logger.warn("API", "GitHub push after cookie update failed: " + e.message);
      }

      res.json({ message: "تم حفظ الكوكيز. البوت يُعاد تشغيله خلال 5 ثوانٍ..." });

      // Restart after 5 seconds
      setTimeout(() => {
        logger.info("API", "Restarting bot after cookie update...");
        process.exit(1);
      }, 5000);
    } catch (e) {
      logger.error("API", "Cookie update failed: " + e.message);
      res.status(500).json({ error: "فشل حفظ الكوكيز: " + e.message });
    }
  });


  return app;
}

  function startApiServer() {
  const key = _getEffectiveApiKey();
  if (!_isKeySecure(key)) {
    logger.error("Dashboard", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.error("Dashboard", "FATAL: Dashboard API key is missing or insecure.");
    logger.error("Dashboard", "Set a strong key (≥12 chars) via:");
    logger.error("Dashboard", "  • Env var:    DASHBOARD_API_KEY=<your-strong-key>");
    logger.error("Dashboard", "  • config.json: dashboard.apiKey field");
    logger.error("Dashboard", "Dashboard will NOT start without a secure key.");
    logger.error("Dashboard", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    process.exit(1);
  }
  const app  = createApiServer();
  const port = process.env.PORT || (config.dashboard && config.dashboard.port) || 3001;
  app.listen(port, "0.0.0.0", () => logger.success("Dashboard", "API + Dashboard listening on port " + port));
}

module.exports = { setBotApi, setBotStatus, setCookieRefresher, logActivity: logActivitySSE, logViolation, startApiServer };
