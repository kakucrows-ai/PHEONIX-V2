"use strict";
const fs   = require("fs");
const path = require("path");
const CONFIG = path.resolve(__dirname, "../config.json");

let _adminIDs = [];

function _load() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    _adminIDs = (cfg.bot && cfg.bot.adminIDs ? cfg.bot.adminIDs : []).map(String);
  } catch { _adminIDs = []; }
}

function _save() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    cfg.bot.adminIDs = _adminIDs;
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), "utf8");
  } catch {}
}

_load();

module.exports = {
  isAdmin(id)  { return _adminIDs.includes(String(id)); },
  isPrimary(id){ return _adminIDs[0] === String(id); },
  list()       { return [..._adminIDs]; },

  add(id) {
    const s = String(id).trim();
    if (!s) return false;
    if (_adminIDs.includes(s)) return false;
    _adminIDs.push(s);
    _save();
    return true;
  },

  remove(id) {
    const s = String(id).trim();
    const i = _adminIDs.indexOf(s);
    if (i === -1) return false;  // FIXED: explicitly handle not-found case (was ambiguously grouped with primary-admin check)
    if (i === 0)  return false;  // FIXED: primary admin — never remove; separated from not-found case for clarity
    _adminIDs.splice(i, 1);
    _save();
    return true;
  },

  reload() { _load(); },
};
