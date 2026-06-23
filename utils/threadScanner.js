"use strict";

/**
 * threadScanner — production-grade Messenger group discovery engine.
 *
 * Architecture:
 *   Phase 1 — Paginated getThreadList (INBOX + ARCHIVED) to find all threads.
 *   Phase 2 — Merge with existing groupsCache (recover groups not in recent pages).
 *   Phase 3 — Targeted enrichment via getThreadInfo for entries with missing/stale data.
 *   Phase 4 — Validate, deduplicate, update cache, return sorted results.
 *
 * Key properties:
 *   - Never crashes the bot on partial failures.
 *   - Rate-limited batch enrichment (configurable concurrency + inter-batch delay).
 *   - Scan cooldown prevents hammering the Messenger API.
 *   - Forced scan bypasses cooldown (e.g. after bot restart).
 *   - Thread ID validated before any operation.
 *   - Each phase isolated — a failure in phase 3 still returns phase 1+2 results.
 */

const logger      = require("./logger");
const { groupsCache } = require("../state");

// ── Tuning constants ──────────────────────────────────────────────────────────
const FETCH_LIMIT     = 20;         // threads per getThreadList page
const MAX_PAGES       = 20;         // safety ceiling (20 × 20 = 400 threads max)
const PAGE_DELAY_MS   = 500;        // pause between pages (ms) — avoid rate-limit
const ENRICH_BATCH    = 4;          // concurrent getThreadInfo calls
const ENRICH_DELAY_MS = 300;        // pause between enrichment batches
const INFO_TIMEOUT_MS = 9_000;      // per-thread getThreadInfo timeout
const SCAN_COOLDOWN   = 30_000;     // 30s min between full scans
const STALE_AGE_MS    = 10 * 60_000; // names older than 10 min are re-fetched

// ── Module state ──────────────────────────────────────────────────────────────
let _api        = null;
let _scanning   = false;
let _lastScanAt = 0;
let _lastResult = null;  // { groups, errors, duration }
let _scanCount  = 0;

// ── Public: wire up the Facebook API instance ─────────────────────────────────
function setApi(api) {
  _api = api;
  logger.debug("ThreadScanner", "API instance registered.");
}

// ── Validation helpers ────────────────────────────────────────────────────────
function _isValidThreadID(tid) {
  return typeof tid === "string" && /^\d{5,20}$/.test(tid);
}

function _isGroupThread(t) {
  if (!t || !_isValidThreadID(t.threadID)) return false;
  if (t.isGroup === true) return true;
  if (t.threadType === "GROUP") return true;
  if (Array.isArray(t.participantIDs) && t.participantIDs.length > 2) return true;
  return false;
}

function _isStale(info) {
  if (!info) return true;
  if (!info.name) return true;
  const age = Date.now() - (info._refreshedAt || info.lastSeen || 0);
  return age > STALE_AGE_MS;
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────
function _withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    ),
  ]);
}

// ── Fetch one page of threads ─────────────────────────────────────────────────
async function _fetchPage(timestamp, tags) {
  return _withTimeout(
    _api.getThreadList(FETCH_LIMIT, timestamp || null, tags),
    15_000
  );
}

// ── Enrich a single thread with getThreadInfo ─────────────────────────────────
async function _enrichOne(threadID) {
  const info = await _withTimeout(_api.getThreadInfo(threadID), INFO_TIMEOUT_MS);
  if (!info) throw new Error("null response");

  const name        = (info.name || "").trim() || null;
  const memberCount = (info.participantIDs || []).length;

  return { name, memberCount, _enriched: true, _refreshedAt: Date.now() };
}

// ── Scan: full group discovery ────────────────────────────────────────────────
async function scan({ force = false } = {}) {
  const now = Date.now();

  if (!_api) {
    return _fallback(["API not initialized yet — bot may still be logging in."]);
  }

  // Return cached result within cooldown unless forced
  if (!force && _lastResult && (now - _lastScanAt) < SCAN_COOLDOWN) {
    logger.debug("ThreadScanner", `Returning cached result (age ${Math.round((now - _lastScanAt) / 1000)}s)`);
    return { ..._lastResult, fromCache: true };
  }

  // Prevent concurrent scans
  if (_scanning) {
    logger.warn("ThreadScanner", "Scan already in progress — returning last result");
    return _lastResult
      ? { ..._lastResult, fromCache: true }
      : _fallback(["scan in progress"]);
  }

  _scanning = true;
  _scanCount++;
  const scanID = _scanCount;
  const start  = Date.now();
  const errors = [];
  const seenIDs = new Set();
  const rawMap  = new Map(); // threadID → raw thread data

  logger.info("ThreadScanner", `[Scan #${scanID}] Starting — forced=${force}`);

  try {
    // ════════════════════════════════════════════════════════════════════════
    // PHASE 1: Paginated thread list fetch (INBOX)
    // ════════════════════════════════════════════════════════════════════════
    await _fetchPages(rawMap, seenIDs, errors, ["INBOX"], scanID);

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 2: Merge existing groupsCache (recovers groups not in recent pages)
    // ════════════════════════════════════════════════════════════════════════
    let cacheRecovered = 0;
    for (const [tid, info] of groupsCache.entries()) {
      if (!_isValidThreadID(tid) || seenIDs.has(tid)) continue;
      seenIDs.add(tid);
      rawMap.set(tid, {
        threadID:    tid,
        name:        info.name || null,
        memberCount: info.memberCount || 0,
        lastSeen:    info.lastSeen || 0,
        _fromCache:  true,
      });
      cacheRecovered++;
    }
    logger.debug("ThreadScanner", `[Scan #${scanID}] Phase 2: +${cacheRecovered} from cache (total ${rawMap.size})`);

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 3: Targeted enrichment (missing names / stale data)
    // ════════════════════════════════════════════════════════════════════════
    const needsEnrich = [];
    for (const [tid, raw] of rawMap.entries()) {
      const cached = groupsCache.get(tid);
      if (!raw.name || _isStale(cached)) {
        needsEnrich.push(tid);
      }
    }

    logger.debug("ThreadScanner", `[Scan #${scanID}] Phase 3: enriching ${needsEnrich.length} thread(s)`);

    let enrichOK = 0, enrichFail = 0;
    for (let i = 0; i < needsEnrich.length; i += ENRICH_BATCH) {
      const batch = needsEnrich.slice(i, i + ENRICH_BATCH);
      const results = await Promise.allSettled(batch.map(tid => _enrichOne(tid)));

      results.forEach((r, j) => {
        const tid = batch[j];
        if (r.status === "fulfilled") {
          const existing = rawMap.get(tid) || {};
          rawMap.set(tid, { ...existing, ...r.value });
          enrichOK++;
        } else {
          const msg = `enrich failed for ${tid}: ${r.reason?.message}`;
          errors.push(msg);
          logger.debug("ThreadScanner", `[Scan #${scanID}] ${msg}`);
          enrichFail++;
        }
      });

      if (i + ENRICH_BATCH < needsEnrich.length) {
        await new Promise(res => setTimeout(res, ENRICH_DELAY_MS));
      }
    }

    logger.debug("ThreadScanner", `[Scan #${scanID}] Enrichment done: ${enrichOK} ok, ${enrichFail} failed`);

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 4: Validate, update cache, build final list
    // ════════════════════════════════════════════════════════════════════════
    const groups = [];
    for (const [tid, raw] of rawMap.entries()) {
      // Final name resolution
      const cached = groupsCache.get(tid) || {};
      const name   = (raw.name || cached.name || "").trim() || tid;

      // Update cache
      groupsCache.set(tid, {
        ...cached,
        name,
        memberCount:  raw.memberCount || cached.memberCount || 0,
        lastSeen:     raw.lastSeen || cached.lastSeen || Date.now(),
        _refreshedAt: raw._refreshedAt || cached._refreshedAt || null,
      });

      groups.push({
        threadID:    tid,
        name,
        memberCount: raw.memberCount || cached.memberCount || 0,
        lastSeen:    raw.lastSeen || cached.lastSeen || Date.now(),
        _enriched:   raw._enriched || false,
        _fromCache:  !!raw._fromCache,
      });
    }

    // Sort: Arabic-aware, alphabetical by name
    groups.sort((a, b) => String(a.name).localeCompare(String(b.name), "ar", { sensitivity: "base" }));

    const duration = Date.now() - start;
    logger.success(
      "ThreadScanner",
      `[Scan #${scanID}] Complete — ${groups.length} groups, ${errors.length} error(s), ${duration}ms`
    );

    _lastResult = { groups, errors, duration };
    _lastScanAt = Date.now();
    return { ..._lastResult, fromCache: false };

  } catch (fatal) {
    const msg = `Fatal scan error: ${fatal.message}`;
    logger.error("ThreadScanner", `[Scan #${scanID}] ${msg}`);
    errors.push(msg);
    return _fallback(errors, Date.now() - start);

  } finally {
    _scanning = false;
  }
}

// ── Paginated fetch helper (mutates rawMap + seenIDs) ─────────────────────────
async function _fetchPages(rawMap, seenIDs, errors, tags, scanID) {
  let timestamp = null;
  let page      = 0;
  let found     = 0;

  while (page < MAX_PAGES) {
    let threads;
    try {
      threads = await _fetchPage(timestamp, tags);
    } catch (e) {
      errors.push(`Page ${page + 1} [${tags}] failed: ${e.message}`);
      logger.warn("ThreadScanner", `[Scan #${scanID}] Page ${page + 1} fetch error: ${e.message}`);
      break;
    }

    if (!Array.isArray(threads) || threads.length === 0) break;

    for (const t of threads) {
      if (!_isGroupThread(t)) continue;
      const tid = t.threadID;
      if (seenIDs.has(tid)) continue;
      seenIDs.add(tid);
      rawMap.set(tid, {
        threadID:    tid,
        name:        (t.name || "").trim() || null,
        memberCount: (t.participantIDs || []).length,
        lastSeen:    t.timestamp || Date.now(),
      });
      found++;
      timestamp = t.timestamp; // next page cursor
    }

    page++;
    if (threads.length < FETCH_LIMIT) break; // last page
    if (page < MAX_PAGES) await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
  }

  logger.debug("ThreadScanner", `[Scan #${scanID}] [${tags}] ${found} groups in ${page} page(s)`);
}

// ── Fallback: serve from groupsCache when scan fails ─────────────────────────
function _fallback(errors, duration = 0) {
  const groups = [...groupsCache.entries()]
    .filter(([tid]) => _isValidThreadID(tid))
    .map(([tid, info]) => ({
      threadID:    tid,
      name:        (info.name || "").trim() || tid,
      memberCount: info.memberCount || 0,
      lastSeen:    info.lastSeen || 0,
      _enriched:   false,
      _fromCache:  true,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "ar", { sensitivity: "base" }));

  logger.warn("ThreadScanner", `Fallback to cache: ${groups.length} groups`);
  return { groups, errors, duration, fromCache: true, fatal: errors.some(e => e.startsWith("Fatal")) };
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
function diagnostics() {
  return {
    apiReady:    !!_api,
    scanning:    _scanning,
    lastScanAt:  _lastScanAt ? new Date(_lastScanAt).toISOString() : null,
    scanCount:   _scanCount,
    cacheSize:   groupsCache.size,
    lastErrors:  _lastResult?.errors || [],
    lastDuration: _lastResult?.duration || null,
  };
}

module.exports = { setApi, scan, diagnostics };
