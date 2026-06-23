"use strict";
/**
 * antiSpam.js — sliding-window cooldown + abuse detection.
 *
 * Features:
 *  - Global default cooldown (configurable)
 *  - Per-command override cooldowns
 *  - Sliding-window burst detection (abuse flag)
 *  - Abuse counter: too many blocked calls in a short window → flag
 *  - Automatic expiry of stale entries
 */

const _cooldowns = new Map();     // `${userID}:${cmd}` → lastTimestamp
const _abuseMap  = new Map();     // userID → { count, firstAt }

let _defaultMs = 3000;
const _cmdOverrides = new Map();  // cmd → ms

// Abuse: if a user exceeds this many cooldown violations in a window, flag them
const ABUSE_WINDOW_MS    = 30_000;   // 30 seconds
const ABUSE_THRESHOLD    = 8;        // 8 blocked calls = abuse

// ── Configuration ─────────────────────────────────────────────────────────────
function configure(ms) {
  _defaultMs = Math.max(500, Number(ms) || 3000);
}

function setCommandCooldown(cmd, ms) {
  if (ms == null) { _cmdOverrides.delete(cmd); return; }
  _cmdOverrides.set(cmd, Math.max(500, Number(ms)));
}

function _getCooldownMs(cmd) {
  return _cmdOverrides.has(cmd) ? _cmdOverrides.get(cmd) : _defaultMs;
}

// ── Core ──────────────────────────────────────────────────────────────────────
function isOnCooldown(userID, cmd) {
  const key  = `${userID}:${cmd}`;
  const last = _cooldowns.get(key);
  if (last === undefined) return false;
  const inCooldown = Date.now() - last < _getCooldownMs(cmd);
  if (inCooldown) _recordAbuse(userID);
  return inCooldown;
}

function setCooldown(userID, cmd) {
  _cooldowns.set(`${userID}:${cmd}`, Date.now());
}

function getRemainingCooldown(userID, cmd) {
  const last = _cooldowns.get(`${userID}:${cmd}`);
  if (!last) return 0;
  return Math.max(0, _getCooldownMs(cmd) - (Date.now() - last));
}

function clearCooldown(userID, cmd) {
  if (cmd) {
    _cooldowns.delete(`${userID}:${cmd}`);
  } else {
    for (const k of [..._cooldowns.keys()]) {
      if (k.startsWith(`${userID}:`)) _cooldowns.delete(k);
    }
  }
  _abuseMap.delete(userID);
}

// ── Abuse detection ────────────────────────────────────────────────────────────
function _recordAbuse(userID) {
  const now = Date.now();
  const rec = _abuseMap.get(userID) || { count: 0, firstAt: now };
  if (now - rec.firstAt > ABUSE_WINDOW_MS) {
    // Reset window
    _abuseMap.set(userID, { count: 1, firstAt: now });
  } else {
    rec.count++;
    _abuseMap.set(userID, rec);
  }
}

function isAbuser(userID) {
  const rec = _abuseMap.get(userID);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > ABUSE_WINDOW_MS) { _abuseMap.delete(userID); return false; }
  return rec.count >= ABUSE_THRESHOLD;
}

function resetAbuse(userID) { _abuseMap.delete(userID); }

function getAbuseCount(userID) {
  const rec = _abuseMap.get(userID);
  if (!rec || Date.now() - rec.firstAt > ABUSE_WINDOW_MS) return 0;
  return rec.count;
}

// ── Purge expired entries every 5 minutes ────────────────────────────────────
setInterval(() => {
  const now    = Date.now();
  const maxAge = Math.max(_defaultMs * 3, 180_000);
  for (const [k, ts] of _cooldowns) {
    if (now - ts >= maxAge) _cooldowns.delete(k);
  }
  for (const [uid, rec] of _abuseMap) {
    if (now - rec.firstAt > ABUSE_WINDOW_MS * 2) _abuseMap.delete(uid);
  }
}, 300_000).unref();

module.exports = {
  configure,
  setCommandCooldown,
  isOnCooldown,
  setCooldown,
  getRemainingCooldown,
  clearCooldown,
  isAbuser,
  resetAbuse,
  getAbuseCount,
};
