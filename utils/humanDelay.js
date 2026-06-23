"use strict";
/**
 * humanDelay — makes every bot response feel human-typed.
 *
 * Flow per command:
 *   1. readPause      — simulate noticing / reading the message
 *   2. deliveryMark   — mark message as delivered (optional, if api supports it)
 *   3. typingStart    — start typing indicator
 *   4. thinkPause     — simulate composing a reply
 *   5. execute        — command runs and sends response
 *   6. typingStop     — stop indicator
 *
 * Occasionally (~10%) a "slow" response is injected (user was busy),
 * adding an extra 5–20 s before typing starts — just like real people.
 */

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _rnd(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

// ── Command buckets ───────────────────────────────────────────────────────────
const INSTANT = new Set([
  "ping","pong","id","roll","coinflip","time","emoji","react","uptime","up","stats",
]);

const HEAVY = new Set([
  "ai","chat","gpt",
  "imagine","img","image","صورة",
  "music","song","اغنية","أغنية","mp3",
  "lyrics","lyric","lrc","كلمات",
  "muhrik","محرك",
  "announce","broadcast","ann",
]);

// Admin-only commands skip the slow "user was busy" delay entirely
const NO_SLOW = new Set([
  "addadmin","removeadmin","admins","مشرف","مشرفين",
  "control","lock","unlock","ban","unban","kick","nickname",
  "help",
]);

// ── readPause: time to notice and glance at the message ──────────────────────
function readPause(messageText) {
  const text  = String(messageText || "").trim();
  const words = text.split(/\s+/).length;
  const chars = text.length;

  // Longer messages take longer to notice (more to process)
  const base = _rnd(150, 400);
  const wordFactor = Math.min(words * 18, 400);
  const charFactor = Math.min(chars * 1.5, 300);
  return Math.min(base + wordFactor + charFactor, 1_200);
}

// ── thinkPause: composing time before sending ─────────────────────────────────
function thinkPause(cmdName) {
  const n = String(cmdName || "").toLowerCase();
  if (INSTANT.has(n)) return _rnd(350,  800);
  if (HEAVY.has(n))   return _rnd(300,  700);
  return _rnd(800, 2_000);
}

// ── slowChance: 10% of responses get a "user was busy" extra delay ────────────
function _slowDelay() {
  if (Math.random() > 0.10) return 0;
  // 5–20 s extra delay — like glancing at phone, then putting it down, then replying
  return _rnd(5_000, 20_000);
}

// ── withTyping: full human-response wrapper ───────────────────────────────────
async function withTyping(api, threadID, cmdName, messageText, fn) {
  const n = String(cmdName || "").toLowerCase();

  // 1. Read pause
  await _sleep(readPause(messageText));

  // 2. Optional slow response (user was busy) — skipped for admin/utility commands
  if (!NO_SLOW.has(n)) {
    const slow = _slowDelay();
    if (slow > 0) {
      // During the slow period: no typing indicator — just silence (like real delay)
      await _sleep(slow);
    }
  }

  // 3. Mark as delivered before typing (natural order)
  if (typeof api.markAsDelivered === "function") {
    try { await api.markAsDelivered(threadID); } catch {}
    await _sleep(_rnd(300, 900));
  }

  // 4. Start typing indicator
  let stopTyping = null;
  try { stopTyping = await api.sendTypingIndicator(threadID); } catch {}

  // 5. Think pause
  await _sleep(thinkPause(cmdName));

  // 6. Execute
  try {
    return await fn();
  } finally {
    try { if (typeof stopTyping === "function") stopTyping(); } catch {}
  }
}

module.exports = { withTyping, readPause, thinkPause, _sleep, _rnd };
