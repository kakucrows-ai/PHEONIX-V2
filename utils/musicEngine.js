"use strict";

/**
 * musicEngine — production-grade audio delivery engine for Phoenix bot. // FIXED: updated bot name from Madox to Phoenix
 *
 * Provider chain:
 *   1. YouTube via yt-dlp — tries 4 player clients in sequence:
 *        android → ios → tv_embedded → mweb
 *   2. iTunes Search API (direct preview URL) — 30s preview fallback
 *
 * Resilience features:
 *   - Auto-updates yt-dlp once per process start (fixes stale-binary 403s)
 *   - 4-client retry loop with per-client User-Agent headers
 *   - Exponential back-off between client retries (0.5s → 2s)
 *   - Concurrency semaphore (max 2 parallel downloads)
 *   - Per-user cooldown (35 s)
 *   - Temp file cleanup (30 s after send, hourly stale sweep)
 */

const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const https  = require("https");
const http   = require("http");
const { spawn, execFile } = require("child_process");

const logger   = require("./logger");
const ytSearch = require("yt-search"); // FIXED: moved from inside _searchYouTube() to module top-level to avoid repeated require() on every call

// ── Config ────────────────────────────────────────────────────────────────────
const TMP_DIR          = path.join(os.tmpdir(), "madox_music");
const YTDLP_LOCAL      = path.join(TMP_DIR, "yt-dlp");
const MAX_CONCURRENT   = 2;
const QUEUE_MAX        = 5;
const SEARCH_TIMEOUT   = 15_000;
const DOWNLOAD_TIMEOUT = 120_000;
const BINARY_TIMEOUT   = 90_000;
const MAX_DURATION_SEC = 720;        // 12 min
const MAX_FILE_BYTES   = 48 * 1024 * 1024;
const USER_COOLDOWN_MS = 35_000;

// Player clients to try in order — each bypasses 403 in different regions/times
const YT_CLIENTS = [
  {
    name: "android",
    args: [
      "--extractor-args", "youtube:player_client=android",
      "--add-header", "User-Agent:com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
    ],
  },
  {
    name: "ios",
    args: [
      "--extractor-args", "youtube:player_client=ios",
      "--add-header", "User-Agent:com.google.ios.youtube/19.09.3 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)",
    ],
  },
  {
    name: "tv_embedded",
    args: [
      "--extractor-args", "youtube:player_client=tv_embedded",
      "--add-header", "User-Agent:Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) SamsungBrowser/3.1",
    ],
  },
  {
    name: "mweb",
    args: [
      "--extractor-args", "youtube:player_client=mweb",
      "--add-header", "User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    ],
  },
];

// ── State ─────────────────────────────────────────────────────────────────────
const _userCooldowns = new Map();
let   _ytdlpPath     = null;
let   _ytdlpPromise  = null;
let   _autoUpdated   = false;   // only try to auto-update once per process

// ── Semaphore ─────────────────────────────────────────────────────────────────
class Semaphore {
  constructor(max) { this._max = max; this._running = 0; this._queue = []; }
  acquire() {
    return new Promise(resolve => {
      const release = () => { this._running--; this._flush(); };
      if (this._running < this._max) { this._running++; resolve(release); }
      else this._queue.push(() => { this._running++; resolve(release); });
    });
  }
  _flush() { if (this._queue.length > 0) this._queue.shift()(); }
  get running() { return this._running; }
  get waiting() { return this._queue.length; }
  get total()   { return this._running + this._queue.length; }
}

const _sem = new Semaphore(MAX_CONCURRENT);

// ── Startup cleanup ───────────────────────────────────────────────────────────
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch {}
setImmediate(_cleanStaleFiles);
setInterval(_cleanStaleFiles, 60 * 60 * 1000).unref();

function _cleanStaleFiles() {
  try {
    const cutoff = Date.now() - 3_600_000;
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (!f.startsWith("music_")) continue;
      const fp = path.join(TMP_DIR, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
    }
  } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("انتهت مهلة: " + label + " (" + Math.round(ms / 1000) + "s)")), ms)
    ),
  ]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpFetch(url, redirects = 8) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error("too many redirects"));
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      timeout: 30_000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return httpFetch(next, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error("HTTP " + res.statusCode));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("HTTP timeout")); });
  });
}

async function httpFetchJson(url) {
  const buf = await httpFetch(url);
  return JSON.parse(buf.toString("utf8"));
}

function spawnAsync(cmd, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const proc   = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    proc.stdout.on("data", d => stdout.push(d));
    proc.stderr.on("data", d => stderr.push(d));
    proc.on("error", err => { if (!done) { done = true; reject(err); } });
    proc.on("close", code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) return resolve(Buffer.concat(stdout).toString() + Buffer.concat(stderr).toString());
      reject(new Error(
        path.basename(cmd) + " exit " + code + ": " +
        Buffer.concat(stderr).toString().slice(0, 400)
      ));
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error(path.basename(cmd) + " timeout (" + Math.round(timeout / 1000) + "s)"));
    }, timeout);
  });
}

// ── yt-dlp binary resolution ──────────────────────────────────────────────────
async function ensureYtDlp() {
  if (_ytdlpPath) return _ytdlpPath;
  if (_ytdlpPromise) return _ytdlpPromise;
  _ytdlpPromise = _resolveYtDlp().finally(() => { _ytdlpPromise = null; });
  return _ytdlpPromise;
}

async function _resolveYtDlp() {
  const HOME = process.env.HOME || "/root";
  const candidates = [
    "/usr/local/bin/yt-dlp",
    "yt-dlp",
    "/usr/bin/yt-dlp",
    path.join(HOME, ".local/bin/yt-dlp"),
    "/root/.local/bin/yt-dlp",
    "/nix/var/nix/profiles/default/bin/yt-dlp",
    path.join(HOME, ".nix-profile/bin/yt-dlp"),
    YTDLP_LOCAL,
  ];

  for (const cmd of candidates) {
    try {
      const ver = await spawnAsync(cmd, ["--version"], { timeout: 6_000 });
      logger.info("MusicEngine", `yt-dlp found: ${cmd} (${ver.trim()})`);
      _ytdlpPath = cmd;
      // Trigger background auto-update (once per process)
      _maybeAutoUpdate(cmd);
      return cmd;
    } catch {}
  }

  // Download standalone Linux binary from GitHub releases
  logger.info("MusicEngine", "Downloading yt-dlp binary (first-time setup)...");
  await _downloadYtDlpBinary(YTDLP_LOCAL);
  _ytdlpPath = YTDLP_LOCAL;
  return YTDLP_LOCAL;
}

async function _downloadYtDlpBinary(dest) {
  const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
  const buf = await withTimeout(httpFetch(url), BINARY_TIMEOUT, "تحميل yt-dlp");
  fs.writeFileSync(dest, buf, { mode: 0o755 });
  const ver = await spawnAsync(dest, ["--version"], { timeout: 6_000 });
  logger.success("MusicEngine", "yt-dlp binary ready: " + ver.trim());
}

// Auto-update yt-dlp in the background so the next download uses the latest version.
// Old binaries are the #1 cause of 403 errors from YouTube.
function _maybeAutoUpdate(binPath) {
  if (_autoUpdated) return;
  _autoUpdated = true;
  setImmediate(async () => {
    try {
      logger.info("MusicEngine", "Auto-updating yt-dlp to latest...");
      await spawnAsync(binPath, ["-U", "--no-colors"], { timeout: 60_000 });
      // Re-read version after update
      const ver = await spawnAsync(binPath, ["--version"], { timeout: 5_000 });
      logger.success("MusicEngine", "yt-dlp updated: " + ver.trim());
      _ytdlpPath = binPath; // refresh cached path
    } catch (e) {
      // Not fatal — just log it
      logger.warn("MusicEngine", "yt-dlp auto-update skipped: " + e.message);
    }
  });
}

// ── Detect system ffmpeg path ─────────────────────────────────────────────────
function _findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const HOME = process.env.HOME || "/root";
  const candidates = [
    "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg",
    "/nix/var/nix/profiles/default/bin/ffmpeg",
    path.join(HOME, ".nix-profile/bin/ffmpeg"),
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return "ffmpeg";
}

// ── Provider 1: YouTube ───────────────────────────────────────────────────────
async function _searchYouTube(query) {
  const result   = await withTimeout(ytSearch(query), SEARCH_TIMEOUT, "YouTube search");
  const videos   = (result.videos || []).filter(v =>
    v.seconds && v.seconds > 15 && v.seconds < MAX_DURATION_SEC
  );
  if (!videos.length) throw new Error("no_results");
  const v = videos[0];
  return {
    provider: "youtube",
    url:      v.url,
    title:    v.title || query,
    artist:   v.author?.name || "",
    duration: v.timestamp || "",
    seconds:  v.seconds,
    preview:  false,
  };
}

// Download with multi-client retry loop
// Tries: android → ios → tv_embedded → mweb
// Each is a fully separate yt-dlp invocation with its own User-Agent / extractor args.
async function _downloadYouTube(track, outPath) {
  const bin    = await withTimeout(ensureYtDlp(), BINARY_TIMEOUT + 5_000, "تجهيز أداة التحميل");
  const ffmpeg = _findFfmpeg();

  const BASE_ARGS = [
    "--no-playlist",
    "--max-filesize", "48m",
    "-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=mp4]/bestaudio",
    "--ffmpeg-location", ffmpeg,
    "-o", outPath,
    "--no-part",
    "--no-cache-dir",
    "--quiet",
    "--no-warnings",
    "--force-ipv4",
    "--geo-bypass",
    "--no-check-certificates",
    "--retries", "3",
    "--fragment-retries", "3",
    "--socket-timeout", "30",
  ];

  let lastError = null;
  for (let i = 0; i < YT_CLIENTS.length; i++) {
    const client = YT_CLIENTS[i];
    // Remove a previous failed partial output
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}

    logger.info("MusicEngine", `Trying player_client=${client.name} for: ${track.title}`);
    try {
      await withTimeout(
        spawnAsync(bin, [...BASE_ARGS, ...client.args, track.url], { timeout: DOWNLOAD_TIMEOUT }),
        DOWNLOAD_TIMEOUT + 5_000,
        `تحميل (${client.name})`
      );
      // Validate the file exists before returning
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
        logger.success("MusicEngine", `Download succeeded with client=${client.name}`);
        return; // success
      }
      throw new Error("الملف فارغ أو مفقود بعد التحميل");
    } catch (e) {
      lastError = e;
      const errMsg = e.message || "";
      const is403  = errMsg.includes("403") || errMsg.includes("Forbidden");
      const is429  = errMsg.includes("429") || errMsg.includes("rate limit");
      logger.warn(
        "MusicEngine",
        `client=${client.name} failed${is403 ? " (403)" : is429 ? " (429)" : ""}: ${errMsg.slice(0, 120)}`
      );
      if (i < YT_CLIENTS.length - 1) {
        // Back-off before next client: 0.5s, 1s, 2s
        await sleep(Math.min(500 * Math.pow(2, i), 2000));
      }
    }
  }

  // All clients failed — propagate last error
  throw new Error(lastError?.message || "فشل التحميل من YouTube بجميع العملاء");
}

// ── Provider 2: iTunes (30s preview) ─────────────────────────────────────────
async function _searchItunes(query) {
  const url  = "https://itunes.apple.com/search?term=" + encodeURIComponent(query) + "&media=music&limit=10&entity=song";
  const data = await withTimeout(httpFetchJson(url), SEARCH_TIMEOUT, "iTunes search");
  const hits = (data.results || []).filter(r => r.previewUrl && r.trackName);
  if (!hits.length) throw new Error("no_results");
  const h = hits[0];
  return {
    provider: "itunes",
    url:      h.previewUrl,
    title:    h.trackName || query,
    artist:   h.artistName || "",
    duration: "0:30",
    seconds:  30,
    preview:  true,
  };
}

async function _downloadItunes(track, outPath) {
  const buf = await withTimeout(httpFetch(track.url), 30_000, "تحميل معاينة iTunes");
  fs.writeFileSync(outPath, buf);
}

// ── File validation ───────────────────────────────────────────────────────────
function _validateFile(fp) {
  if (!fs.existsSync(fp)) throw new Error("الملف الصوتي لم يُنشأ");
  const sz = fs.statSync(fp).size;
  if (sz < 1024)           throw new Error("الملف فارغ (" + sz + " bytes)");
  if (sz > MAX_FILE_BYTES) throw new Error("الملف كبير جداً (" + Math.round(sz / 1048576) + "MB)");
  return sz;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function search(query) {
  const q = query.slice(0, 200).trim();
  try   { return await _searchYouTube(q); }
  catch (e) { if (e.message !== "no_results") logger.warn("MusicEngine", "YouTube search: " + e.message); }
  try   { return await _searchItunes(q); }
  catch (e) { if (e.message !== "no_results") logger.warn("MusicEngine", "iTunes search: " + e.message); }
  throw new Error("لم يُعثر على نتائج لـ: " + q);
}

async function download(track) {
  if (_sem.total >= QUEUE_MAX) throw new Error("قائمة الانتظار ممتلئة، حاول بعد قليل.");

  const ext     = track.provider === "itunes" ? "m4a" : "mp3"; // FIXED: both branches were identical "m4a" (dead ternary); YouTube downloads use mp3
  const outPath = path.join(TMP_DIR, "music_" + Date.now() + "_" + Math.random().toString(36).slice(2) + "." + ext);
  const release = await _sem.acquire();

  try {
    logger.info("MusicEngine", `Downloading [${track.provider}]: ${track.title}`);
    if (track.provider === "itunes") {
      await _downloadItunes(track, outPath);
    } else {
      // ── YouTube: try all 4 clients; on total failure fall back to iTunes ──
      try {
        await _downloadYouTube(track, outPath);
      } catch (ytErr) {
        logger.warn("MusicEngine", "All YouTube clients failed — trying iTunes fallback: " + ytErr.message.slice(0, 100));
        // Re-search on iTunes using same query (title + artist)
        const fallbackQuery = track.title + (track.artist ? " " + track.artist : "");
        let itunesTrack;
        try {
          itunesTrack = await _searchItunes(fallbackQuery);
        } catch {
          throw ytErr; // propagate YouTube error if iTunes also fails
        }
        const itunesPath = path.join(TMP_DIR, "music_itunes_" + Date.now() + ".m4a");
        await _downloadItunes(itunesTrack, itunesPath);
        // Swap outPath content
        const buf = fs.readFileSync(itunesPath);
        fs.writeFileSync(outPath, buf);
        fs.unlinkSync(itunesPath);
        // Update track metadata so the message reflects the preview
        track.duration = "0:30";
        track.preview  = true;
        logger.info("MusicEngine", "Serving iTunes 30s preview as fallback.");
      }
    }
    const bytes = _validateFile(outPath);
    logger.success("MusicEngine", `Done: ${Math.round(bytes / 1024)}KB — ${track.title}`);
    return outPath;
  } catch (e) {
    safeDelete(outPath, 0);
    throw e;
  } finally {
    release();
  }
}

function safeDelete(fp, delayMs = 30_000) {
  if (delayMs === 0) { try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch {} return; }
  setTimeout(() => { try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch {} }, delayMs);
}

function userCooldown(senderID) {
  const last    = _userCooldowns.get(senderID) || 0;
  const elapsed = Date.now() - last;
  return elapsed < USER_COOLDOWN_MS ? Math.ceil((USER_COOLDOWN_MS - elapsed) / 1000) : 0;
}

function markUser(senderID) { _userCooldowns.set(senderID, Date.now()); }

function diagnostics() {
  let tmpFiles = 0;
  try { tmpFiles = fs.readdirSync(TMP_DIR).filter(f => f.startsWith("music_")).length; } catch {}
  return {
    ytdlpPath:  _ytdlpPath || "(not resolved yet)",
    autoUpdated: _autoUpdated,
    concurrent: _sem.running,
    queued:     _sem.waiting,
    tmpFiles,
    tmpDir:     TMP_DIR,
  };
}

module.exports = { search, download, safeDelete, userCooldown, markUser, diagnostics };
