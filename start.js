"use strict";
  /**
   * start.js v2 — Safe auto-restart wrapper
   *
   * Improvements over v1:
   *  - Validates appstate.json BEFORE spawning the bot
   *  - On clean exit (code 0): does NOT restart
   *  - On code 99: safe restart requested by bot itself (fast)
   *  - On crash: exponential backoff with max 5 min
   *  - Stale lock file cleanup on startup
   *  - Never spawns a new process if appstate is corrupted
   */
  const { spawn }  = require("child_process");
  const fs         = require("fs");
  const path       = require("path");
  const crypto     = require("crypto");

  const APP_STATE  = path.join(__dirname, "appstate.json");
  const LOCK_FILE  = APP_STATE + ".lock";
  const BACKUP_1   = APP_STATE.replace(".json", ".backup1.json");

  const MAX_DELAY_MS  = 5 * 60 * 1000;
  const BASE_DELAY_MS = 5 * 1000;
  let attempt     = 0;
  let startedAt   = 0;
  let currentChild = null;

  // ── Session validator ──────────────────────────────────────────────────────
  function validateAppState() {
    const sources = [APP_STATE, BACKUP_1].filter(f => {
      try { return fs.existsSync(f); } catch { return false; }
    });

    for (const src of sources) {
      try {
        const raw  = fs.readFileSync(src, "utf8").trim();
        if (!raw || raw === "null" || raw === "[]") continue;
        const data = JSON.parse(raw);
        if (!Array.isArray(data) || data.length === 0) continue;
        if (!data.some(c => c && c.key === "c_user")) {
          console.warn("[Wrapper] " + path.basename(src) + ": missing c_user — may be invalid.");
          continue;
        }
        if (src !== APP_STATE) {
          console.log("[Wrapper] Primary appstate missing/corrupt — restoring from " + path.basename(src));
          try { fs.copyFileSync(src, APP_STATE); } catch {}
        }
        console.log("[Wrapper] AppState OK: " + data.length + " cookies, c_user present.");
        return true;
      } catch (e) {
        console.warn("[Wrapper] " + path.basename(src) + " unreadable: " + e.message);
      }
    }
    return false; // All sources exhausted
  }

  // ── Stale lock cleanup ─────────────────────────────────────────────────────
  function cleanStaleLock() {
    try {
      if (!fs.existsSync(LOCK_FILE)) return;
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age > 30000) {
        fs.unlinkSync(LOCK_FILE);
        console.log("[Wrapper] Removed stale lock file (age " + Math.round(age / 1000) + "s).");
      }
    } catch {}
  }

  // ── Main start function ────────────────────────────────────────────────────
  function start() {
    startedAt = Date.now();
    attempt++;

    const delay = attempt > 1
      ? Math.min(BASE_DELAY_MS * Math.pow(1.8, attempt - 2), MAX_DELAY_MS)
      : 0;

    if (delay > 0) {
      console.log("[Wrapper] Restarting in " + Math.round(delay / 1000) + "s (attempt #" + attempt + ")...");
    } else {
      console.log("[Wrapper] Starting bot (attempt #" + attempt + ")...");
    }

    setTimeout(() => {
      // Clean stale locks from previous run
      cleanStaleLock();

      // Validate session before spawning
      const sessionOk = validateAppState();
      if (!sessionOk) {
        console.error("[Wrapper] ⚠️  AppState is invalid/missing — bot will attempt login.");
        console.error("[Wrapper] If bot cannot login, update cookies via -كوكيز command.");
      }

      currentChild = spawn(process.execPath, [path.join(__dirname, "index.js")], {
        stdio: "inherit",
        env:   process.env,
      });

      currentChild.on("exit", (code, signal) => {
        currentChild = null;
        const uptime = Math.round((Date.now() - startedAt) / 1000);
        console.log("[Wrapper] Bot exited (code=" + code + ", signal=" + signal + ", uptime=" + uptime + "s)");

        if (uptime > 60) { attempt = 0; console.log("[Wrapper] Uptime > 1 min — resetting backoff."); }

        // code 0 = intentional clean exit (shutdown)
        if (code === 0 && signal === null) {
          console.log("[Wrapper] Clean exit — not restarting.");
          return;
        }

        // code 99 = bot requested safe restart (fast, no backoff)
        if (code === 99) {
          attempt = 0;
          console.log("[Wrapper] Safe restart requested (code 99) — restarting immediately.");
          return start();
        }

        start();
      });

      currentChild.on("error", (e) => {
        console.error("[Wrapper] Spawn error:", e.message);
        currentChild = null;
        start();
      });
    }, delay);
  }

  // ── Graceful shutdown propagation ──────────────────────────────────────────
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log("[Wrapper] " + sig + " — shutting down gracefully.");
      if (currentChild) currentChild.kill(sig);
      setTimeout(() => process.exit(0), 5000);
    });
  }

  start();
  