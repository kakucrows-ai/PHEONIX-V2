"use strict";

const os     = require("os");
const logger = require("./logger");

const MEM_WARN_MB     = 400;
const MEM_CRIT_MB     = 700;
const LOOP_WARN_MS    = 500;
const LOOP_CRIT_MS    = 3000;
const CHECK_INTERVAL  = 30000;

let _onCritical  = null;
let _diagnostics = null;
let _lastReport  = null;
let _prevCpus    = null; // FIXED: stores previous CPU snapshot for delta-based calculation

function _memMB()  { return Math.round(process.memoryUsage().rss / 1024 / 1024); }
function _cpuPct() {
  // FIXED: use delta between two snapshots instead of lifetime aggregate (was always returning a lifetime average, not current CPU%)
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) { for (const t of Object.values(c.times)) total += t; idle += c.times.idle; }
  const snap = { idle, total };
  if (!_prevCpus) { _prevCpus = snap; return 0; }
  const dIdle  = snap.idle  - _prevCpus.idle;
  const dTotal = snap.total - _prevCpus.total;
  _prevCpus = snap;
  return dTotal ? ((1 - dIdle / dTotal) * 100) : 0;
}
function _loopLag() {
  return new Promise(resolve => {
    const t = process.hrtime.bigint();
    setImmediate(() => resolve(Number(process.hrtime.bigint() - t) / 1e6));
  });
}

async function check() {
  const memMB      = _memMB();
  const cpuPct     = _cpuPct();
  const loopLagMs  = await _loopLag();

  _lastReport = { memMB, cpuPct: +cpuPct.toFixed(1), loopLagMs: +loopLagMs.toFixed(1), ts: Date.now() };
  if (_diagnostics) _diagnostics.recordHealth(_lastReport);

  // Memory
  if (memMB >= MEM_CRIT_MB) {
    logger.error("Health", `CRITICAL memory: ${memMB} MB (limit ${MEM_CRIT_MB} MB)`);
    if (_onCritical) _onCritical("memory_critical", _lastReport);
  } else if (memMB >= MEM_WARN_MB) {
    logger.warn("Health", `High memory: ${memMB} MB`);
  }

  // Event loop lag
  if (loopLagMs >= LOOP_CRIT_MS) {
    logger.error("Health", `CRITICAL event-loop lag: ${loopLagMs.toFixed(0)} ms`);
    if (_onCritical) _onCritical("loop_critical", _lastReport);
  } else if (loopLagMs >= LOOP_WARN_MS) {
    logger.warn("Health", `High event-loop lag: ${loopLagMs.toFixed(0)} ms`);
  }

  // CPU
  if (cpuPct > 90) logger.warn("Health", `High CPU: ${cpuPct.toFixed(1)}%`);

  logger.debug("Health", `RAM ${memMB} MB | Loop ${loopLagMs.toFixed(0)} ms | CPU ${cpuPct.toFixed(1)}%`);
  return _lastReport;
}

function start({ onCritical, diagnostics } = {}) {
  _onCritical  = onCritical  || null;
  _diagnostics = diagnostics || null;
  const t = setInterval(() => check().catch(e => logger.warn("Health", `Check failed: ${e.message}`)), CHECK_INTERVAL);
  t.unref();
  check().catch(() => {});
  logger.info("Health", `Watchdog started — checks every ${CHECK_INTERVAL / 1000}s`);
}

function snapshot() {
  return _lastReport || { memMB: _memMB(), cpuPct: +_cpuPct().toFixed(1), loopLagMs: 0, ts: Date.now() };
}

module.exports = { start, snapshot, check };
