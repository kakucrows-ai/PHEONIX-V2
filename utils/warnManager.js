"use strict";
/**
 * warnManager — persistent per-user warning system.
 * Warns are stored per (threadID, userID) pair.
 * Persists to data/warns.json using atomic writes.
 */
const fs   = require("fs");
const path = require("path");
const logger = require("./logger");

const FILE = path.resolve(__dirname, "../data/warns.json");

// Structure: Map<threadID, Map<userID, {count, reasons[], lastAt}>>
const _warns = new Map();
let _dirty = false;

// ── Persist ────────────────────────────────────────────────────────────────
function _save() {
  if (!_dirty) return;
  _dirty = false;
  try {
    const obj = {};
    for (const [tid, users] of _warns) {
      obj[tid] = {};
      for (const [uid, w] of users) obj[tid][uid] = w;
    }
    const tmp = FILE + ".tmp";
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, FILE);
  } catch (e) {
    logger.warn("WarnManager", "Save failed: " + e.message);
  }
}

function _load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const obj = JSON.parse(fs.readFileSync(FILE, "utf8"));
    for (const [tid, users] of Object.entries(obj)) {
      const um = new Map();
      for (const [uid, w] of Object.entries(users)) um.set(uid, w);
      _warns.set(tid, um);
    }
    logger.debug("WarnManager", "Loaded warns from disk.");
  } catch (e) {
    logger.warn("WarnManager", "Load failed: " + e.message);
  }
}

_load();
// Auto-save every 5 minutes
setInterval(_save, 5 * 60_000).unref();
process.on("SIGINT",  _save);
process.on("SIGTERM", _save);

// ── Public API ─────────────────────────────────────────────────────────────
function addWarn(threadID, userID, reason = "لم يُذكر سبب") {
  if (!_warns.has(threadID)) _warns.set(threadID, new Map());
  const um = _warns.get(threadID);
  const w  = um.get(userID) || { count: 0, reasons: [], lastAt: 0 };
  w.count++;
  w.reasons.push({ reason: reason.slice(0, 200), at: Date.now() });
  if (w.reasons.length > 20) w.reasons.shift();
  w.lastAt = Date.now();
  um.set(userID, w);
  _dirty = true;
  _save();
  return w;
}

function getWarns(threadID, userID) {
  return _warns.get(threadID)?.get(userID) || { count: 0, reasons: [], lastAt: 0 };
}

function clearWarns(threadID, userID) {
  const um = _warns.get(threadID);
  if (!um) return false;
  if (userID) { um.delete(userID); }
  else        { _warns.delete(threadID); }
  _dirty = true;
  _save();
  return true;
}

function listWarns(threadID) {
  const um = _warns.get(threadID);
  if (!um) return [];
  return [...um.entries()].map(([uid, w]) => ({ userID: uid, ...w }));
}

function getWarnCount(threadID, userID) {
  return getWarns(threadID, userID).count;
}

module.exports = { addWarn, getWarns, clearWarns, listWarns, getWarnCount };
