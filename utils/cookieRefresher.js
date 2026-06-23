"use strict";

/**
 * cookieRefresher.js v3 — Conflict-Free Cookie Auto-Save
 *
 * Improvements over v2:
 *  ✅ Mutex (_ticking) prevents concurrent tick execution
 *  ✅ Hash computed AFTER pruneExpired (accurate change detection)
 *  ✅ Post-login save conflict window: skips first tick if save < 60s ago
 *  ✅ Consecutive error limit: pauses GitHub push after 5 failures, retries after 10 min
 *  ✅ Separate "local save" from "GitHub push" — local always saves, GitHub only when gap allows
 *  ✅ Self-healing: resets error counter on next successful push
 */

const crypto = require("crypto");
const logger  = require("./logger");

const INTERVAL_MS      = 5 * 60 * 1000;   // 5 min between ticks
const FIRST_TICK       = 90 * 1000;        // first tick 90s after start (avoids post-login race)
const MIN_PUSH_GAP     = 3 * 60 * 1000;    // min 3 min between GitHub pushes
const MAX_PUSH_ERRORS  = 5;                // pause GitHub push after 5 consecutive errors
const ERROR_PAUSE_MS   = 10 * 60 * 1000;  // 10 min pause when error limit hit

let _timer         = null;
let _firstTimer    = null;
let _api           = null;
let _session       = null;
let _lastHash      = null;      // hash of last SAVED (pruned) state
let _lastSaveAt    = 0;         // last local save timestamp
let _lastPushAt    = 0;         // last GitHub push timestamp
let _ticking       = false;     // mutex: prevents concurrent _tick() calls
let _pushCount     = 0;
let _skipCount     = 0;
let _saveCount     = 0;
let _pushErrors    = 0;         // consecutive GitHub push errors
let _errorPauseUntil = 0;      // timestamp until push is paused
let _startedAt     = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _hashState(state) {
  try { return crypto.createHash("sha1").update(JSON.stringify(state)).digest("hex"); }
  catch { return null; }
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function _tick() {
  if (!_api || !_session) return;

  // Mutex: skip if previous tick is still running
  if (_ticking) {
    logger.debug("CookieRefresher", "Tick skipped — previous tick still running (mutex).");
    return;
  }
  _ticking = true;

  try {
    // 1. Get current in-memory state
    let state;
    try { state = _api.getAppState(); }
    catch (e) {
      logger.warn("CookieRefresher", "getAppState() failed: " + e.message);
      return;
    }
    if (!Array.isArray(state) || state.length === 0) return;

    // 2. Prune expired/duplicate cookies BEFORE hashing
    //    This ensures _lastHash always reflects what's actually on disk
    try {
      if (typeof _session.pruneExpired === "function") {
        const { kept, removed } = _session.pruneExpired(state);
        if (removed > 0) {
          state = kept;
          logger.debug("CookieRefresher", "Pre-tick pruned " + removed + " cookie(s).");
        }
      }
    } catch {}

    // 3. Compare hash with last SAVED state
    const hash    = _hashState(state);
    const now     = Date.now();
    const changed = hash && hash !== _lastHash;

    if (!changed) {
      _skipCount++;
      logger.debug("CookieRefresher", "No cookie change detected — skip #" + _skipCount + ".");
      return;
    }

    // 4. Save locally (always, regardless of GitHub push gap)
    try {
      const saved = _session.save(state);
      if (saved) {
        _lastHash  = hash;   // update hash to match the pruned state that was saved
        _lastSaveAt = now;
        _saveCount++;
        logger.debug("CookieRefresher",
          "Local save #" + _saveCount + " ✅ (" + state.length + " cookies)"
        );
      } else {
        logger.warn("CookieRefresher", "Local save returned false — will retry next tick.");
        return;
      }
    } catch (e) {
      logger.warn("CookieRefresher", "Local save error: " + e.message);
      return;
    }

    // 5. GitHub push — only if gap allows AND error limit not hit
    const pushGapOk    = now - _lastPushAt >= MIN_PUSH_GAP;
    const notPaused    = now >= _errorPauseUntil;

    if (!pushGapOk) {
      const waitSec = Math.ceil((MIN_PUSH_GAP - (now - _lastPushAt)) / 1000);
      logger.debug("CookieRefresher", "GitHub push skipped — gap not met (" + waitSec + "s remaining).");
      return;
    }
    if (!notPaused) {
      const pauseSec = Math.ceil((_errorPauseUntil - now) / 1000);
      logger.warn("CookieRefresher", "GitHub push paused — too many errors. Resuming in " + pauseSec + "s.");
      return;
    }

    // 6. Push to GitHub
    try {
      await _session.pushToGitHub();
      _lastPushAt   = now;
      _pushCount++;
      _pushErrors   = 0;  // reset error counter on success
      logger.success("CookieRefresher",
        "Cookies pushed to GitHub ✅ (push #" + _pushCount + " | " + state.length + " entries)"
      );
    } catch (e) {
      _pushErrors++;
      logger.warn("CookieRefresher",
        "GitHub push failed (#" + _pushErrors + "): " + e.message
      );
      if (_pushErrors >= MAX_PUSH_ERRORS) {
        _errorPauseUntil = now + ERROR_PAUSE_MS;
        logger.warn("CookieRefresher",
          "Push error limit reached — pausing GitHub push for " + (ERROR_PAUSE_MS / 60000) + " min."
        );
      }
    }

  } finally {
    _ticking = false;  // always release mutex
  }
}

// ── Emergency flush ───────────────────────────────────────────────────────────

async function emergencyFlush() {
  if (!_api || !_session) return;
  try {
    const state = _api.getAppState();
    if (Array.isArray(state) && state.length > 0) {
      _session.emergencySave(state);
      logger.success("CookieRefresher", "Emergency flush complete — session preserved ✅");
    }
  } catch (e) {
    logger.warn("CookieRefresher", "Emergency flush error: " + e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function start(api, session) {
  stop();
  _api           = api;
  _session       = session;
  _lastHash      = null;
  _lastSaveAt    = 0;
  _lastPushAt    = 0;
  _ticking       = false;
  _pushCount     = 0;
  _skipCount     = 0;
  _saveCount     = 0;
  _pushErrors    = 0;
  _errorPauseUntil = 0;
  _startedAt     = Date.now();

  _firstTimer = setTimeout(() => {
    _firstTimer = null;
    _tick().catch(e => logger.warn("CookieRefresher", "First tick error: " + e.message));
    _timer = setInterval(
      () => _tick().catch(e => logger.warn("CookieRefresher", "Tick error: " + e.message)),
      INTERVAL_MS
    );
    if (_timer.unref) _timer.unref();
  }, FIRST_TICK);
  if (_firstTimer.unref) _firstTimer.unref();

  logger.info("CookieRefresher",
    "Started v3 — first tick in " + (FIRST_TICK / 1000) + "s, then every " +
    (INTERVAL_MS / 60000) + " min | push gap: " + (MIN_PUSH_GAP / 60000) + " min."
  );
}

function stop() {
  if (_firstTimer) { clearTimeout(_firstTimer);  _firstTimer = null; }
  if (_timer)      { clearInterval(_timer);       _timer      = null; }
  _api     = null;
  _session = null;
  _ticking = false;
}

async function forceRefresh() {
  if (!_api || !_session) throw new Error("CookieRefresher not running.");
  _lastHash = null;  // force change detection
  await _tick();
  return status();
}

function status() {
  return {
    active:          !!_timer || !!_firstTimer,
    intervalMinutes: INTERVAL_MS / 60000,
    firstTickSec:    FIRST_TICK / 1000,
    saveCount:       _saveCount,
    pushCount:       _pushCount,
    skipCount:       _skipCount,
    pushErrors:      _pushErrors,
    errorPausedUntil: _errorPauseUntil > Date.now() ? _errorPauseUntil : null,
    lastSaveAt:      _lastSaveAt || null,
    lastPushAt:      _lastPushAt || null,
    isTicking:       _ticking,
    uptimeSec:       _startedAt ? Math.floor((Date.now() - _startedAt) / 1000) : 0,
  };
}

module.exports = { start, stop, forceRefresh, status, emergencyFlush };
