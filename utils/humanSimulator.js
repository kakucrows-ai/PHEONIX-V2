"use strict";

/**
 * humanSimulator v3 — محاكاة إنسانية متقدمة لتفادي كشف فيسبوك.
 *
 * السلوكيات:
 *  1. Presence heartbeat       — يبقي الحساب متصلاً باستمرار
 *  2. Typing bursts            — يحاكي كتابة ردود
 *  3. Mark as read             — يحاكي فتح المحادثات
 *  4. Browse session           — يتصفح مجموعة من المحادثات دفعة واحدة
 *  5. Reels / Homepage         — يحاكي تصفح الصفحة الرئيسية
 *  6. Profile views            — يزور ملفات أعضاء المجموعات
 *  7. Inbox scroll  ★ NEW     — يفتح قائمة المحادثات (inbox) كأنه يتصفح الإشعارات
 *  8. History scroll ★ NEW    — يقرأ رسائل قديمة في مجموعات عشوائية
 */

const logger      = require("./logger");
const rateLimiter = require("./rateLimiter");

const DEFAULT_CONFIG = {
  enabled:              true,
  presenceIntervalMs:   5  * 60_000,
  typingIntervalMs:     12 * 60_000,
  readIntervalMs:       4  * 60_000,
  browseIntervalMs:     18 * 60_000,
  jitterMs:             45_000,
  maxTypingMs:          5_000,
  maxGroupsPerCycle:    3,
  browseBatchSize:      6,
  reelsIntervalMs:      60 * 60_000,
  inboxScrollIntervalMs: 25 * 60_000,   // كل 25 دقيقة
  historyScrollIntervalMs: 35 * 60_000, // كل 35 دقيقة
};

let _api     = null;
let _cfg     = { ...DEFAULT_CONFIG };
let _timers  = [];
let _running = false;
let _actionLock = false; // mutex: prevents 2 behaviors running simultaneously
let _stats   = {
  startedAt:        null,
  presenceSent:     0,
  typingSimulated:  0,
  threadsRead:      0,
  browseSessions:   0,
  reelsSessions:    0,
  profileViews:     0,
  inboxScrolls:     0,
  historyScrolls:   0,
  lastActionAt:     null,
  lastActionType:   null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _jitter(baseMs) {
  const j = _cfg.jitterMs || 45_000;
  return Math.max(5_000, baseMs + Math.floor((Math.random() * 2 - 1) * j));
}

function _randomGroupIDs(max) {
  try {
    const { groupsCache } = require("../state");
    const ids = [...groupsCache.keys()];
    if (ids.length === 0) return [];
    return ids.sort(() => Math.random() - 0.5).slice(0, max);
  } catch { return []; }
}

function _sleep(minMs, maxMs = minMs) {
  return new Promise(r => setTimeout(r,
    minMs + Math.floor(Math.random() * Math.max(0, maxMs - minMs))
  ));
}

function _record(type) {
  _stats.lastActionAt   = Date.now();
  _stats.lastActionType = type;
}

function _schedule(fn, delayMs) {
  const t = setTimeout(fn, delayMs);
  t.unref();
  _timers.push(t);
}


// ── Mutex wrapper — only one behaviour runs at a time ────────────────────────
async function _guarded(label, fn) {
  if (_actionLock) {
    logger.debug("HumanSim", "[skip] " + label + " — another action is running.");
    return;
  }
  _actionLock = true;
  try { await fn(); }
  catch (e) { logger.debug("HumanSim", label + " error: " + e.message); }
  finally { _actionLock = false; }
}

// ── 1. Presence heartbeat ─────────────────────────────────────────────────────
function _doPresence() {
  _schedule(async () => {
    if (!_running || !_api) return;
    await _guarded("presence", async () => {
      if (typeof _api.setOptions === "function") _api.setOptions({ online: true });
      _stats.presenceSent++;
      _record("presence");
      logger.debug("HumanSim", "Presence heartbeat #" + _stats.presenceSent);
    });
    _doPresence();
  }, _jitter(_cfg.presenceIntervalMs));
}

// ── 2. Typing simulation ──────────────────────────────────────────────────────
function _doTyping() {
  _schedule(async () => {
    if (!_running || !_api) return;
    const [threadID] = _randomGroupIDs(1);
    if (threadID) {
      try {
        const duration = Math.random() < 0.4
          ? 800  + Math.floor(Math.random() * 1_500)
          : 2_000 + Math.floor(Math.random() * (_cfg.maxTypingMs - 2_000));
        await rateLimiter.throttle();
        const stopFn = await _api.sendTypingIndicator(threadID);
        await _sleep(duration);
        if (typeof stopFn === "function") stopFn();
        _stats.typingSimulated++;
        _record("typing");
        logger.debug("HumanSim", `Typing in ${threadID} for ${duration}ms`);
      } catch (e) { logger.debug("HumanSim", `Typing error ${threadID}: ${e.message}`); }
    }
    _doTyping();
  }, _jitter(_cfg.typingIntervalMs));
}

// ── 3. Mark threads as read ───────────────────────────────────────────────────
function _doRead() {
  _schedule(async () => {
    if (!_running || !_api) return;
    for (const threadID of _randomGroupIDs(_cfg.maxGroupsPerCycle)) {
      try {
        if (typeof _api.markAsDelivered === "function") {
          await rateLimiter.throttle();
          await _api.markAsDelivered(threadID).catch(() => {});
          await _sleep(1_200, 4_000);
        }
        await rateLimiter.throttle();
        await _api.markAsRead(threadID, true);
        _stats.threadsRead++;
        _record("markRead");
        logger.debug("HumanSim", `Marked ${threadID} as read`);
        await _sleep(500, 2_000);
      } catch (e) { logger.debug("HumanSim", `markAsRead error ${threadID}: ${e.message}`); }
    }
    _doRead();
  }, _jitter(_cfg.readIntervalMs));
}

// ── 4. Browse session ─────────────────────────────────────────────────────────
function _doBrowse() {
  _schedule(async () => {
    if (!_running || !_api) return;
    const batch = _randomGroupIDs(_cfg.browseBatchSize || 6);
    if (batch.length === 0) { _doBrowse(); return; }
    logger.debug("HumanSim", `Browse session — ${batch.length} threads`);
    for (const threadID of batch) {
      if (!_running) break;
      try {
        if (typeof _api.markAsDelivered === "function") {
          await rateLimiter.throttle();
          await _api.markAsDelivered(threadID).catch(() => {});
          await _sleep(600, 2_000);
        }
        await rateLimiter.throttle();
        await _api.markAsRead(threadID, true);
        _stats.threadsRead++;
        _record("browse");
        const deep = Math.random() < 0.35;
        await _sleep(deep ? 4_000 : 1_000, deep ? 10_000 : 4_000);
        if (Math.random() < 0.35) {
          try {
            await rateLimiter.throttle();
            const stopFn = await _api.sendTypingIndicator(threadID);
            await _sleep(600, 2_500);
            if (typeof stopFn === "function") stopFn();
          } catch {}
        }
        await _sleep(300, 1_500);
      } catch (e) { logger.debug("HumanSim", `Browse error ${threadID}: ${e.message}`); }
    }
    _stats.browseSessions++;
    logger.debug("HumanSim", `Browse session #${_stats.browseSessions} complete`);
    _doBrowse();
  }, _jitter(_cfg.browseIntervalMs));
}

// ── 5. Reels / Homepage simulation ───────────────────────────────────────────
function _doReels() {
  _schedule(async () => {
    if (!_running || !_api) return;
    try {
      const botID   = _api.getCurrentUserID();
      const threads = _randomGroupIDs(3);
      logger.debug("HumanSim", "Reels/homepage simulation started");
      try { await rateLimiter.throttle(); await _api.getUserInfo([botID]); } catch {}
      await _sleep(2_000, 5_000);
      for (const tid of threads) {
        if (!_running) break;
        try {
          if (typeof _api.markAsDelivered === "function") {
            await rateLimiter.throttle();
            await _api.markAsDelivered(tid).catch(() => {});
            await _sleep(800, 2_000);
          }
          await rateLimiter.throttle();
          await _api.markAsRead(tid, true);
          await _sleep(3_000, 12_000);
          if (Math.random() < 0.40) {
            try {
              await rateLimiter.throttle();
              const stopFn = await _api.sendTypingIndicator(tid);
              await _sleep(1_500, 4_000);
              if (typeof stopFn === "function") stopFn();
            } catch {}
          }
          await _sleep(1_000, 3_000);
        } catch {}
      }
      try {
        if (typeof _api.setOptions === "function") _api.setOptions({ online: true });
      } catch {}
      _stats.reelsSessions++;
      _record("reels");
      logger.debug("HumanSim", `Reels session #${_stats.reelsSessions} complete`);
    } catch (e) { logger.debug("HumanSim", `Reels error: ${e.message}`); }
    _doReels();
  }, _jitter(_cfg.reelsIntervalMs || 60 * 60_000));
}

// ── 6. Profile view simulation ────────────────────────────────────────────────
function _doProfileViews() {
  _schedule(async () => {
    if (!_running || !_api) return;
    try {
      const { groupsCache } = require("../state");
      const threadIDs = [...groupsCache.keys()];
      if (threadIDs.length === 0) { _doProfileViews(); return; }
      const threadID = threadIDs[Math.floor(Math.random() * threadIDs.length)];
      await rateLimiter.throttle();
      const info     = await _api.getThreadInfo(threadID).catch(() => null);
      if (!info) { _doProfileViews(); return; }
      const members = (info.participantIDs || []).filter(id => id !== _api.getCurrentUserID());
      if (members.length === 0) { _doProfileViews(); return; }
      const toView = members.sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
      await rateLimiter.throttle();
      await _api.getUserInfo(toView).catch(() => {});
      _stats.profileViews += toView.length;
      _record("profileView");
      logger.debug("HumanSim", `Viewed ${toView.length} profile(s) from thread ${threadID}`);
      // أحياناً يزور ملفين متتاليين بفاصل زمني (مثل إنسان يضغط على أسماء)
      if (Math.random() < 0.3 && members.length > 3) {
        await _sleep(3_000, 8_000);
        const extra = members.sort(() => Math.random() - 0.5).slice(0, 2);
        await rateLimiter.throttle();
        await _api.getUserInfo(extra).catch(() => {});
        _stats.profileViews += extra.length;
        logger.debug("HumanSim", `Extra profile visit: ${extra.length} more`);
      }
      await _sleep(1_000, 3_000);
    } catch (e) { logger.debug("HumanSim", `Profile view error: ${e.message}`); }
    _doProfileViews();
  }, _jitter(40 * 60_000));
}

// ── 7. Inbox scroll ★ ────────────────────────────────────────────────────────
// يفتح قائمة المحادثات كأنه يتصفح الإشعارات من الهاتف
function _doInboxScroll() {
  _schedule(async () => {
    if (!_running || !_api) return;
    try {
      logger.debug("HumanSim", "Inbox scroll started");

      // يفتح inbox ويقرأ قائمة المحادثات (يشبه فتح ماسنجر من الهاتف)
      const fetchLimit = 5 + Math.floor(Math.random() * 10); // 5-15 محادثة
      if (typeof _api.getThreadList === "function") {
        await rateLimiter.throttle();
        const threads = await _api.getThreadList(fetchLimit, null, ["INBOX"]).catch(() => null);
        if (threads && threads.length > 0) {
          // يتوقف عند كل محادثة لفترة كأنه يقرأ العنوان
          for (const t of threads.slice(0, Math.min(threads.length, 5))) {
            if (!_running) break;
            await _sleep(800, 3_500);
            // 40% يفتح المحادثة فعلاً ويقرأها
            if (Math.random() < 0.4 && t.threadID) {
              await rateLimiter.throttle();
              await _api.markAsRead(t.threadID, true).catch(() => {});
              _stats.threadsRead++;
              await _sleep(1_500, 5_000);
              // 25% يرد بكتابة شيء ثم يتوقف
              if (Math.random() < 0.25) {
                try {
                  await rateLimiter.throttle();
                  const stopFn = await _api.sendTypingIndicator(t.threadID);
                  await _sleep(1_000, 3_000);
                  if (typeof stopFn === "function") stopFn();
                } catch {}
              }
            }
          }
        }
      } else {
        // fallback: اقرأ بيانات المجموعات المعروفة
        const ids = _randomGroupIDs(4);
        for (const tid of ids) {
          await _sleep(600, 2_000);
          await rateLimiter.throttle();
          await _api.markAsRead(tid, true).catch(() => {});
          _stats.threadsRead++;
        }
      }

      _stats.inboxScrolls++;
      _record("inboxScroll");
      logger.debug("HumanSim", `Inbox scroll #${_stats.inboxScrolls} complete`);
    } catch (e) { logger.debug("HumanSim", `Inbox scroll error: ${e.message}`); }
    _doInboxScroll();
  }, _jitter(_cfg.inboxScrollIntervalMs || 25 * 60_000));
}

// ── 8. History scroll ★ ──────────────────────────────────────────────────────
// يقرأ رسائل قديمة في مجموعة عشوائية — يشبه إنسان يرجع يبحث عن رسالة
function _doScrollHistory() {
  _schedule(async () => {
    if (!_running || !_api) return;
    try {
      const [threadID] = _randomGroupIDs(1);
      if (!threadID) { _doScrollHistory(); return; }

      logger.debug("HumanSim", `History scroll in ${threadID}`);

      if (typeof _api.getThreadHistory === "function") {
        // يحمّل دفعة من الرسائل القديمة (10-30 رسالة)
        const amount = 10 + Math.floor(Math.random() * 20);
        await rateLimiter.throttle();
        await _api.getThreadHistory(threadID, amount, null).catch(() => {});
        // وقت القراءة: يتناسب مع عدد الرسائل
        await _sleep(amount * 300, amount * 800);
      } else {
        // fallback: قراءة معلومات الخيط
        await rateLimiter.throttle();
        await _api.getThreadInfo(threadID).catch(() => {});
        await _sleep(2_000, 6_000);
      }

      // أحياناً يكمل بالقراءة مرة ثانية (يمرر للأعلى)
      if (Math.random() < 0.4) {
        const [tid2] = _randomGroupIDs(1);
        if (tid2 && typeof _api.getThreadHistory === "function") {
          await _sleep(2_000, 5_000);
          await rateLimiter.throttle();
          await _api.getThreadHistory(tid2, 8 + Math.floor(Math.random() * 12), null).catch(() => {});
          await _sleep(1_500, 4_000);
        }
      }

      _stats.historyScrolls++;
      _record("historyScroll");
      logger.debug("HumanSim", `History scroll #${_stats.historyScrolls} complete`);
    } catch (e) { logger.debug("HumanSim", `History scroll error: ${e.message}`); }
    _doScrollHistory();
  }, _jitter(_cfg.historyScrollIntervalMs || 35 * 60_000));
}

// ── Public API ────────────────────────────────────────────────────────────────
function start(api, userConfig = {}) {
  if (_running) stop();
  _api     = api;
  _cfg     = { ...DEFAULT_CONFIG, ...userConfig };
  _running = true;
  _timers  = [];
  _stats   = {
    startedAt:        Date.now(),
    presenceSent:     0,
    typingSimulated:  0,
    threadsRead:      0,
    browseSessions:   0,
    reelsSessions:    0,
    profileViews:     0,
    inboxScrolls:     0,
    historyScrolls:   0,
    lastActionAt:     null,
    lastActionType:   null,
  };

  // تأخيرات متفرقة لتجنب بدء كل شيء في نفس الثانية
  const stagger = [
    [_doPresence,        60_000 + Math.floor(Math.random() * 30_000)],
    [_doTyping,         100_000 + Math.floor(Math.random() * 30_000)],
    [_doRead,            35_000 + Math.floor(Math.random() * 15_000)],
    [_doBrowse,         300_000 + Math.floor(Math.random() * 60_000)],
    [_doReels,          600_000 + Math.floor(Math.random() * 120_000)],
    [_doProfileViews,   180_000 + Math.floor(Math.random() * 60_000)],
    [_doInboxScroll,     90_000 + Math.floor(Math.random() * 45_000)],   // ★
    [_doScrollHistory,  240_000 + Math.floor(Math.random() * 60_000)],   // ★
  ];

  for (const [fn, offset] of stagger) {
    const t = setTimeout(fn, offset);
    t.unref();
    _timers.push(t);
  }

  logger.info("HumanSim", [
    "Started (24/7) —",
    `presence:${_cfg.presenceIntervalMs / 60_000}m`,
    `typing:${_cfg.typingIntervalMs / 60_000}m`,
    `read:${_cfg.readIntervalMs / 60_000}m`,
    `browse:${_cfg.browseIntervalMs / 60_000}m`,
    `inbox:${(_cfg.inboxScrollIntervalMs || 1_500_000) / 60_000}m`,
    `history:${(_cfg.historyScrollIntervalMs || 2_100_000) / 60_000}m`,
    `reels:${(_cfg.reelsIntervalMs || 3_600_000) / 60_000}m + profileViews`,
  ].join(" "));
}

function stop() {
  _running = false;
  _actionLock = false;
  for (const t of _timers) clearTimeout(t);
  _timers = [];
  logger.info("HumanSim", "Stopped.");
}

function configure(newConfig) {
  _cfg = { ..._cfg, ...newConfig };
  if (_running && _api) { stop(); start(_api, _cfg); }
}

function status() {
  return { running: _running, config: { ..._cfg }, stats: { ..._stats } };
}

module.exports = { start, stop, configure, status };
