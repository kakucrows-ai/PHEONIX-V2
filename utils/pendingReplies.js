"use strict";

/**
 * pendingReplies — stores one pending interactive step per sender.
 *
 * Each entry: { handler: async (input, api, event) => any, expiresAt: number }
 *
 * Special return value:
 *   Return `pendingReplies.KEEP` from a handler to keep the entry alive
 *   (e.g. for paginated menus that must handle multiple inputs).
 */

const KEEP   = Symbol("pendingReplies.KEEP");
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const _pending = new Map();

// Purge expired entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of _pending) {
    if (entry.expiresAt < now) _pending.delete(id);
  }
}, 120_000).unref();

function set(senderID, entry) {
  _pending.set(senderID, { ...entry, expiresAt: Date.now() + TTL_MS });
}

function get(senderID) {
  const entry = _pending.get(senderID);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { _pending.delete(senderID); return null; }
  return entry;
}

function del(senderID) { _pending.delete(senderID); }
function has(senderID) { return get(senderID) !== null; }

module.exports = { set, get, del, has, KEEP };
