"use strict";

const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const logger = require("./logger");

const DATA_DIR   = path.resolve(__dirname, "../data");
const LOGS_DIR   = path.resolve(__dirname, "../logs");
const BACK_DIR   = path.resolve(__dirname, "../backups");
const SNAP_DIR   = path.resolve(__dirname, "../data/snapshots");
const TMP_DIR    = os.tmpdir();

const TMP_PATTERNS    = [
  /^uptime_\d+\.png$/,
  /^music_\d+\./,
  /^phoenix_\d+\./,
  /^img_\d+\.jpg$/,
  /^imagine_\d+\.jpg$/,
];
const MAX_LOG_AGE_MS  = 30 * 86400000;

function ensureDirs() {
  for (const d of [DATA_DIR, LOGS_DIR, BACK_DIR, SNAP_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
}

function cleanTempFiles() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (TMP_PATTERNS.some(p => p.test(f))) {
        try { fs.unlinkSync(path.join(TMP_DIR, f)); n++; } catch {}
      }
    }
  } catch {}
  if (n > 0) logger.debug("Maintenance", `Removed ${n} temp file(s).`);
}

function cleanOldLogs() {
  const now = Date.now();
  let n = 0;
  try {
    for (const f of fs.readdirSync(LOGS_DIR)) {
      const fp = path.join(LOGS_DIR, f);
      try {
        if (fs.statSync(fp).mtimeMs < now - MAX_LOG_AGE_MS) { fs.unlinkSync(fp); n++; }
      } catch {}
    }
  } catch {}
  if (n > 0) logger.debug("Maintenance", `Purged ${n} old log file(s).`);
}

function checkStorageIntegrity(appStatePath) {
  const dirs = [DATA_DIR, LOGS_DIR, appStatePath ? path.dirname(appStatePath) : null].filter(Boolean);
  for (const d of dirs) {
    const probe = path.join(d, ".write_probe");
    try { fs.writeFileSync(probe, "ok"); fs.unlinkSync(probe); }
    catch { logger.error("Maintenance", `Directory not writable: ${d}`); }
  }
}

function checkDependencies() {
  const required = ["@neoaz07/nkxfca", "express", "cors"];
  const missing  = [];
  for (const dep of required) {
    try { require.resolve(dep); } catch { missing.push(dep); }
  }
  if (missing.length) logger.error("Maintenance", `Missing packages: ${missing.join(", ")} — run npm install`);
  return missing;
}

function startupSelfCheck(appStatePath) {
  logger.info("Maintenance", "Running startup self-checks...");
  ensureDirs();
  cleanTempFiles();
  checkStorageIntegrity(appStatePath);
  checkDependencies();
  logger.success("Maintenance", "Self-checks complete.");
}

function schedule() {
  const now    = new Date();
  const next3am = new Date(now);
  next3am.setHours(3, 0, 0, 0);
  if (next3am <= now) next3am.setDate(next3am.getDate() + 1);
  const delay = next3am - now;

  const run = () => { cleanTempFiles(); cleanOldLogs(); logger.info("Maintenance", "Daily maintenance done."); };
  setTimeout(() => { run(); setInterval(run, 86400000).unref(); }, delay).unref();
  logger.debug("Maintenance", `Next maintenance in ${Math.round(delay / 3600000)}h`);
}

module.exports = { startupSelfCheck, schedule, cleanTempFiles, cleanOldLogs, ensureDirs };
