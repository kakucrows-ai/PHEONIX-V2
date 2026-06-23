"use strict";

const fs     = require("fs");
const path   = require("path");
const logger = require("./utils/logger");

const DATA_DIR   = path.resolve(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const lockedThreads      = new Set();
const totalLockedThreads = new Set(); // قفل تام — bot admin only
const mutedThreads   = new Map();
const groupsCache    = new Map();
const activityLog    = [];
const lockViolations = [];
const autoReplies    = new Map();
const groupStats     = new Map();
const replyDelay     = { enabled: false, ms: 1500 };

// FIX: Evict stale groups not seen in 30 days to prevent memory leak
const STALE_GROUP_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function evictStaleGroups() {
  const now     = Date.now();
  let evicted   = 0;
  for (const [tid, info] of groupsCache.entries()) {
    const age = now - (info.lastSeen || 0);
    if (age > STALE_GROUP_AGE_MS) {
      groupsCache.delete(tid);
      groupStats.delete(tid);
      autoReplies.delete(tid);
      lockedThreads.delete(tid);
      totalLockedThreads.delete(tid);
      mutedThreads.delete(tid);
      evicted++;
    }
  }
  if (evicted > 0) logger.debug("State", `Evicted ${evicted} stale group(s) from cache.`);
  return evicted;
}

function _serialize() {
  return {
    version:     2,
    savedAt:     Date.now(),
    lockedThreads: [...lockedThreads],
    totalLockedThreads: [...totalLockedThreads],
    mutedThreads:  [...mutedThreads.entries()].filter(([, exp]) => exp > Date.now()),
    groupsCache:   [...groupsCache.entries()],
    groupStats:    [...groupStats.entries()],
    replyDelay:    { ...replyDelay },
    autoReplies:   [...autoReplies.entries()].map(([tid, ar]) => [
      tid, { message: ar.message, enabled: ar.enabled, cooldownMs: ar.cooldownMs, delayMs: ar.delayMs || 0 }
    ]),
  };
}

function save() {
  try {
    // Evict stale groups before saving to keep state file lean
    evictStaleGroups();
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(_serialize(), null, 2), "utf8");
    fs.renameSync(tmp, STATE_FILE);
    logger.debug("State", "State persisted to disk.");
  } catch (e) {
    logger.warn("State", `Persist failed: ${e.message}`);
  }
}

function load() {
  if (!fs.existsSync(STATE_FILE)) { logger.debug("State", "No saved state — fresh start."); return; }
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!data || data.version !== 2) { logger.warn("State", "State version mismatch — resetting."); return; }
    const now = Date.now();
    for (const tid of (data.lockedThreads || []))           lockedThreads.add(tid);
    for (const tid of (data.totalLockedThreads || []))  totalLockedThreads.add(tid);
    for (const [tid, exp] of (data.mutedThreads || []))     if (exp > now) mutedThreads.set(tid, exp);
    for (const [tid, info] of (data.groupsCache || []))     groupsCache.set(tid, info);
    for (const [tid, stats] of (data.groupStats || []))     groupStats.set(tid, stats);
    for (const [tid, ar] of (data.autoReplies || []))       autoReplies.set(tid, { ...ar, delayMs: ar.delayMs || 0, lastSent: new Map() });
    if (data.replyDelay) { replyDelay.enabled = !!data.replyDelay.enabled; replyDelay.ms = data.replyDelay.ms || 1500; }
    logger.success("State", `Restored: ${lockedThreads.size} locked, ${mutedThreads.size} muted, ${groupsCache.size} groups.`);
    // Run eviction on load to clean up any stale data from before fix
    evictStaleGroups();
  } catch (e) {
    logger.warn("State", `Could not load state: ${e.message} — starting fresh.`);
  }
}

// Save every 2 minutes
const _saveTimer = setInterval(save, 120000);
_saveTimer.unref();

// Evict stale groups every 6 hours
const _evictTimer = setInterval(evictStaleGroups, 6 * 60 * 60 * 1000);
_evictTimer.unref();

process.on("SIGINT",  save);
process.on("SIGTERM", save);
process.on("exit",    save);
load();

module.exports = { lockedThreads, totalLockedThreads, mutedThreads, groupsCache, activityLog, lockViolations, autoReplies, groupStats, replyDelay, save, load, evictStaleGroups };
