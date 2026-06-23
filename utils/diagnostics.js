"use strict";

const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const logger = require("./logger");

const SNAP_DIR   = path.resolve(__dirname, "../data/snapshots");
const MAX_ERRORS = 200;
const MAX_SNAPS  = 10;

try { fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch {}

const _errors   = [];
const _health   = [];
const _crashMap = new Map();

function _fingerprint(err) {
  if (!err) return "unknown";
  const top3 = (err.stack || "").split("\n").slice(0, 3).join("|");
  return `${err.name || "Error"}:${(err.message || "").slice(0, 60)}:${top3.slice(0, 100)}`;
}

function recordError(tag, err, ctx = {}) {
  const fp    = _fingerprint(err);
  const count = (_crashMap.get(fp) || 0) + 1;
  _crashMap.set(fp, count);

  const entry = {
    time:    Date.now(),
    tag,
    message: err ? (err.message || String(err)) : "unknown",
    stack:   err ? err.stack : null,
    fp,
    count,
    ctx,
  };
  _errors.push(entry);
  if (_errors.length > MAX_ERRORS) _errors.shift();

  if (count === 5) logger.warn("Diagnostics", `Recurring error (5x): [${tag}] ${entry.message}`);
  if (count === 10) {
    logger.error("Diagnostics", `Frequent crash (10x): [${tag}] ${entry.message} — creating snapshot`);
    createSnapshot(`auto_recurring_${tag}`).catch(() => {});
  }
  return entry;
}

function recordHealth(report) {
  _health.push(report);
  if (_health.length > 120) _health.shift();
}

function topErrors(n = 10) {
  const seen = new Map();
  for (const e of _errors) {
    const ex = seen.get(e.fp);
    if (!ex || e.time > ex.time) seen.set(e.fp, e);
  }
  return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

async function createSnapshot(reason = "manual") {
  const ts   = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(SNAP_DIR, `snap-${ts}.json`);
  const mem  = process.memoryUsage();
  const snap = {
    ts:      Date.now(),
    reason,
    process: {
      pid:      process.pid,
      uptime:   Math.floor(process.uptime()),
      version:  process.version,
      platform: process.platform,
      mem: {
        rss:       Math.round(mem.rss / 1048576),
        heapUsed:  Math.round(mem.heapUsed / 1048576),
        heapTotal: Math.round(mem.heapTotal / 1048576),
      },
    },
    system: {
      loadAvg: os.loadavg(),
      freeMem: Math.round(os.freemem() / 1048576),
      totMem:  Math.round(os.totalmem() / 1048576),
    },
    recentErrors: _errors.slice(-20),
    topErrors:    topErrors(5),
    healthHistory: _health.slice(-20),
  };

  try {
    fs.writeFileSync(file, JSON.stringify(snap, null, 2));
    logger.info("Diagnostics", `Snapshot saved: ${path.basename(file)}`);
    // Prune oldest
    const snaps = fs.readdirSync(SNAP_DIR)
      .filter(f => f.startsWith("snap-"))
      .map(f => ({ f, mt: fs.statSync(path.join(SNAP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt);
    for (let i = MAX_SNAPS; i < snaps.length; i++) {
      try { fs.unlinkSync(path.join(SNAP_DIR, snaps[i].f)); } catch {}
    }
    return file;
  } catch (e) {
    logger.warn("Diagnostics", `Snapshot failed: ${e.message}`);
    return null;
  }
}

function report() {
  const hs = _health;
  return {
    totalErrors:  _errors.length,
    uniqueErrors: _crashMap.size,
    topErrors:    topErrors(10),
    health: hs.length ? {
      avgMem:     Math.round(hs.reduce((s, h) => s + h.memMB, 0) / hs.length),
      maxMem:     Math.max(...hs.map(h => h.memMB)),
      avgLoopLag: +(hs.reduce((s, h) => s + h.loopLagMs, 0) / hs.length).toFixed(1),
    } : null,
  };
}

module.exports = { recordError, recordHealth, createSnapshot, report, topErrors };
