"use strict";
/**
 * banManager — bot-level user ban system.
 * Banned users cannot use any bot commands.
 * Persists to data/bans.json using atomic writes.
 */
const fs   = require("fs");
const path = require("path");
const logger = require("./logger");

const FILE = path.resolve(__dirname, "../data/bans.json");

// Map<userID, {reason, bannedAt, bannedBy, threadID}>
const _bans = new Map();
let _dirty = false;

function _save() {
  if (!_dirty) return;
  _dirty = false;
  try {
    const obj = {};
    for (const [uid, info] of _bans) obj[uid] = info;
    const tmp = FILE + ".tmp";
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, FILE);
  } catch (e) {
    logger.warn("BanManager", "Save failed: " + e.message);
  }
}

function _load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const obj = JSON.parse(fs.readFileSync(FILE, "utf8"));
    for (const [uid, info] of Object.entries(obj)) _bans.set(uid, info);
    logger.debug("BanManager", `Loaded ${_bans.size} ban(s) from disk.`);
  } catch (e) {
    logger.warn("BanManager", "Load failed: " + e.message);
  }
}

_load();
setInterval(_save, 5 * 60_000).unref();
process.on("SIGINT",  _save);
process.on("SIGTERM", _save);

function ban(userID, { reason = "لم يُذكر سبب", bannedBy = "admin", threadID = null } = {}) {
  _bans.set(String(userID), {
    reason: reason.slice(0, 300),
    bannedAt: Date.now(),
    bannedBy: String(bannedBy),
    threadID,
  });
  _dirty = true;
  _save();
}

function unban(userID) {
  const had = _bans.has(String(userID));
  _bans.delete(String(userID));
  if (had) { _dirty = true; _save(); }
  return had;
}

function isBanned(userID) { return _bans.has(String(userID)); }
function getBan(userID)   { return _bans.get(String(userID)) || null; }

function listBans() {
  return [..._bans.entries()].map(([uid, info]) => ({ userID: uid, ...info }));
}

function count() { return _bans.size; }

module.exports = { ban, unban, isBanned, getBan, listBans, count };
