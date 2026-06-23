"use strict";

const logger = require("./logger");

// Map<threadID, Map<userID, nickname>>
const lockedNicknames = new Map();

let _apiRef         = null;
let _enforceTimer   = null;
let _enforcing      = false;

const ENFORCE_INTERVAL = 60_000;  // re-enforce every 60 s as safety net
const CALL_DELAY_MS    = 600;     // ms between API calls (rate-limit safety)

// ── API helper (callback → Promise) ──────────────────────────────────────────
function _setNick(api, nick, threadID, userID) {
  return new Promise((resolve, reject) => {
    if (typeof api.changeNickname === "function") {
      api.changeNickname(nick, threadID, userID, e => e ? reject(e) : resolve());
    } else if (typeof api.nickname === "function") {
      api.nickname(nick, threadID, userID, e => e ? reject(e) : resolve());
    } else {
      reject(new Error("No nickname API available"));
    }
  });
}

// ── Immediate revert: call this when a nickname-change event is detected ──────
async function revertIfLocked(threadID, userID) {
  if (!_apiRef) return false;
  const members = lockedNicknames.get(threadID);
  if (!members) return false;
  const locked = members.get(String(userID));
  if (!locked) return false;

  try {
    await _setNick(_apiRef, locked, threadID, String(userID));
    logger.info("NickLock", `Reverted nickname for ${userID} in ${threadID} → "${locked}"`);
    return true;
  } catch (e) {
    logger.debug("NickLock", `Instant revert failed [${threadID}/${userID}]: ${e.message}`);
    return false;
  }
}

// ── Periodic enforce: safety net in case the event was missed ─────────────────
async function _enforce() {
  if (!_apiRef || lockedNicknames.size === 0 || _enforcing) return;
  _enforcing = true;
  try {
    for (const [threadID, members] of lockedNicknames.entries()) {
      for (const [userID, nickname] of members.entries()) {
        try {
          await _setNick(_apiRef, nickname, threadID, userID);
        } catch (e) {
          logger.debug("NickLock", `Re-enforce failed [${threadID}/${userID}]: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, CALL_DELAY_MS));
      }
    }
  } finally {
    _enforcing = false;
  }
}

function setApi(api) {
  _apiRef = api;
  if (!_enforceTimer) {
    _enforceTimer = setInterval(_enforce, ENFORCE_INTERVAL);
    _enforceTimer.unref();
    logger.debug("NickLock", `Enforce timer started (every ${ENFORCE_INTERVAL / 1000}s).`);
  }
}

// Called by clearall to stop enforce mid-run and clear state for this thread
function clearThread(threadID) {
  lockedNicknames.delete(threadID);
}

module.exports = { lockedNicknames, setApi, revertIfLocked, clearThread };
