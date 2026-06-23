# Madox v2.1.0 — Engineering Repair Report

**Date:** 2026-05-19  
**Scope:** Full codebase audit, bug repair, security hardening, and optimization  
**Files modified:** 12  
**Commits:** 12 (individual commit per file for traceable history)

---

## Critical Fixes

### 1. `commands/lockname.js` — SyntaxError (command failed to load entirely)

**Bug:** Raw literal newlines were embedded inside JavaScript string literals throughout the file.  
In JavaScript strict mode, a newline character inside a single- or double-quoted string literal is a syntax error. Every string that spanned more than one line using actual newlines (instead of `\n` escape sequences) caused Node's parser to throw a SyntaxError at module load time, making the entire `lockname` command permanently unavailable.

**Fix:** Rewrote all multi-line strings to use proper `\n` escape sequences.  
Affected messages: unlock confirmation, usage instructions, error messages, lock confirmation.

---

### 2. `api.js` — Path Traversal Security Vulnerability (3 endpoints)

**Bug:** The file sanitization code in the GET/POST/DELETE `/files/:filePath` endpoints used:
```js
const safe = sanitize(req.params.filePath, 100).replace(/../g, '');
```
In a JavaScript regex, `.` matches **any character** — not just a literal dot. The pattern `/../` therefore matches **any two-character sequence**, meaning every filename passed through this code had its characters progressively stripped (e.g. `config.json` → `nfig.json`). This mangled all valid filenames and silently broke the file-read/write dashboard features.

Worse: the intent of the replacement was to strip `..` (parent directory traversal). Because the regex was wrong, `../` sequences were NOT correctly stripped, leaving a residual path traversal risk that the `path.resolve() + startsWith()` guard only partially mitigated (it correctly blocks absolute escapes, but relative ones within the sanitized string could still behave unexpectedly).

**Fix:** Changed the regex to properly escape the dots:
```js
const safe = sanitize(req.params.filePath, 100).replace(/\.\./g, '');
```
Applied to all three endpoints (GET, POST, DELETE).

---

### 3. `api.js` — Wrong Environment Variable Name (2 endpoints)

**Bug:** The `/appstate/upload` and `/restart` endpoints used `process.env.GITHUB_TOKEN` to construct a `SessionManager` for GitHub cookie backup. The actual configured secret is `GITHUB_PERSONAL_ACCESS_TOKEN`. This caused all dashboard-triggered appstate uploads and pre-restart saves to silently use an empty token, making GitHub pushes fail with authentication errors.

**Fix:** Corrected both usages to `process.env.GITHUB_PERSONAL_ACCESS_TOKEN`.

---

## Robustness / API Guard Fixes

### 4. `commands/react.js` — messageID Property Variant

**Bug:** Used `event.messageID` unconditionally to react to a message. In some nkxfca forks and versions, the property is `messageId` (camelCase `d`) or `mid`. If the property was missing, `setMessageReaction` was called with `undefined`, which nkxfca silently rejects or throws.

**Fix:**
```js
const msgID = event.messageID || event.messageId || event.mid;
```
Added a null-check with a user-facing error if no ID is found.

---

### 5. `commands/profile.js` — getUserInfoV2 May Not Exist

**Bug:** Called `api.getUserInfoV2(targetID)` unconditionally. This method does not exist in the standard nkxfca API; it is present only in some forks. Calling an undefined function throws a TypeError that crashes the command handler.

**Fix:** Check `typeof api.getUserInfoV2 === "function"` before calling it, then fall back to the universally available `api.getUserInfo([targetID])`.

---

### 6. `commands/kick.js` — getThreadInfo Unguarded

**Bug:** `api.getThreadInfo(event.threadID)` was called without a try/catch to determine admin IDs. If the API call fails (network error, invalid thread, bot not in thread), the unhandled rejection crashed the command handler silently.

**Fix:** Wrapped in try/catch. On failure, `adminIDs` defaults to `[]` and the kick proceeds as a best-effort action, consistent with how other commands handle partial info loss.

---

### 7. `commands/members.js` — getUserInfo Unguarded + Large Group Support

**Bug:** A single `api.getUserInfo(allIDs)` call was made for all members at once. For groups with 100+ members, this exceeds Facebook's API batch size limit and throws. Also, the call had no error handling.

**Fix:** Batched into chunks of 50 with a try/catch per chunk. Added message chunking: if the full member list exceeds 3,800 characters (near Messenger's limit), it is split across multiple sequential messages.

---

### 8. `commands/poll.js` — createPoll API Guard

**Bug:** Called `api.createPoll(...)` unconditionally. This method is not available in all nkxfca versions. Calling an undefined function throws a TypeError.

**Fix:**
```js
if (typeof api.createPoll !== "function") {
  return api.sendMessage("❌ The poll feature is not supported by the current API version.", event.threadID);
}
```

---

### 9. `commands/theme.js` — getTheme / createAITheme / setThreadThemeMqtt Guards

**Bug:** Three separate API methods (`api.getTheme`, `api.createAITheme`, `api.setThreadThemeMqtt`) were called unconditionally. None of these are in the base nkxfca API and all vary by fork. Any missing method caused a TypeError.

**Fix:** Added `typeof api.X === "function"` guard before each call, with a fallback to `api.changeThreadColor` where applicable and a user-facing unsupported message otherwise.

---

### 10. `commands/emoji.js` — changeThreadEmoji Guard

**Bug:** `api.changeThreadEmoji` is not universally available. Called unconditionally.

**Fix:** Added runtime guard with user-facing "not supported" message if the method is absent.

---

### 11. `commands/admin.js` — gcrule / changeAdminStatus Fallback

**Bug:** `api.gcrule` is the primary method in nkxfca for promoting/demoting admins, but it is absent in several forks. Called unconditionally, causing a TypeError crash.

**Fix:** Tries `api.gcrule` first; falls back to `api.changeAdminStatus`; returns a user-friendly "not supported" message if neither exists.

---

## Infrastructure Fix

### 12. `nixpacks.toml` — Invalid Nix Package Name + pip Invocation

**Bug:** The nixpacks setup phase listed `python3-pip` as a package name. This is not a valid nixpkgs attribute — the correct name is `python3Packages.pip`. Additionally, the build phase used `pip3 install`, which may not be in PATH depending on the Nix profile.

**Fix:**
```toml
nixPkgs = ["python3", "python3Packages.pip", "ffmpeg", "git", "curl"]
```
```bash
python3 -m pip install -q --no-cache-dir yt-dlp
```
Using `python3 -m pip` is the most reliable invocation regardless of PATH configuration. Also changed `npm install` to `npm install --production` to exclude dev-only packages from the deployment image.

---

## Memory Leak Fix

### 13. `utils/antiSpam.js` — Purge Interval Logic

**Bug:** The cleanup interval ran every 2 minutes and deleted entries older than `_cooldownMs` (often 3 seconds). In practice, entries were deleted almost immediately since 3s < 120s, causing the map to flush constantly and potentially miss active cooldowns for users who re-trigger commands in the same 2-minute window. On the other hand, if `_cooldownMs` was reconfigured to a large value (e.g. 60s), the purge interval was too infrequent.

**Fix:** Purge interval extended to 5 minutes. Retention window set to `max(_cooldownMs * 2, 120_000)` to ensure entries are kept long enough to enforce the cooldown, while still cleaning up stale entries regularly.

---

## Summary Table

| File | Severity | Type | Fix |
|------|----------|------|-----|
| `commands/lockname.js` | 🔴 Critical | SyntaxError | Raw newlines → `\n` escapes |
| `api.js` | 🔴 Critical | Security | Path traversal regex `/../g` → `/\.\./g` (×3) |
| `api.js` | 🟠 High | Bug | Wrong env var `GITHUB_TOKEN` → `GITHUB_PERSONAL_ACCESS_TOKEN` (×2) |
| `commands/react.js` | 🟠 High | Bug | `event.messageID` fallback chain added |
| `commands/profile.js` | 🟠 High | Bug | `getUserInfoV2` → `getUserInfo` fallback |
| `commands/kick.js` | 🟡 Medium | Robustness | `getThreadInfo` wrapped in try/catch |
| `commands/members.js` | 🟡 Medium | Robustness | Batched getUserInfo + message chunking |
| `commands/poll.js` | 🟡 Medium | Robustness | `createPoll` method guard |
| `commands/theme.js` | 🟡 Medium | Robustness | Three API method guards + fallbacks |
| `commands/emoji.js` | 🟡 Medium | Robustness | `changeThreadEmoji` method guard |
| `commands/admin.js` | 🟡 Medium | Robustness | `gcrule` → `changeAdminStatus` fallback |
| `nixpacks.toml` | 🟡 Medium | Infrastructure | Correct nixpkgs name + `python3 -m pip` |
| `utils/antiSpam.js` | 🟢 Low | Memory leak | Improved purge interval and retention logic |

---

*Report generated automatically during maintenance pass. All changes are committed individually with descriptive messages for traceable git history.*
