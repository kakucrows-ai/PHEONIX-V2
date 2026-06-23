"use strict";

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");

const LOGS_DIR     = path.resolve(__dirname, "../logs");
const MAX_LOG_AGE  = 7;   // keep compressed logs for 7 days
const MAX_FILE_MB  = 5;   // rotate when log file exceeds 5 MB

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4, OK: 1 };
const COLORS = {
  DEBUG: "\x1b[90m", INFO: "\x1b[36m", WARN: "\x1b[33m",
  ERROR: "\x1b[31m", FATAL: "\x1b[35m", OK:   "\x1b[32m",
};
const RESET = "\x1b[0m";

let _minLevel   = LEVELS[((process.env.LOG_LEVEL || "").toUpperCase())] ?? 1;
let _silent     = process.env.LOG_SILENT === "true";
let _debugMode  = process.env.LOG_DEBUG === "true" || process.env.NODE_ENV === "development";
if (_debugMode) _minLevel = 0;

try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}

let _curFile   = null;
let _curStream = null;

function _todayFileName() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  return path.join(LOGS_DIR, `madox-${ymd}.log`);
}

function _needsRotation(file) {
  try {
    const s = fs.statSync(file);
    return s.size > MAX_FILE_MB * 1024 * 1024;
  } catch { return false; }
}

function _openStream() {
  const file = _todayFileName();
  if (file !== _curFile || _needsRotation(file)) {
    if (_curStream) { try { _curStream.end(); } catch {} }
    _curFile   = file;
    _curStream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
    _curStream.on("error", () => {});
  }
  return _curStream;
}

function _compressOldLogs() {
  try {
    const today = _todayFileName();
    const cutoff = Date.now() - MAX_LOG_AGE * 86400000;
    const files  = fs.readdirSync(LOGS_DIR);
    for (const f of files) {
      const fp = path.join(LOGS_DIR, f);
      if (!f.endsWith(".log") || fp === today) continue;
      try {
        const stat = fs.statSync(fp);
        const gzFp = fp + ".gz";
        if (!fs.existsSync(gzFp)) {
          fs.writeFileSync(gzFp, zlib.gzipSync(fs.readFileSync(fp)));
          fs.unlinkSync(fp);
        }
        if (stat.mtimeMs < cutoff && fs.existsSync(gzFp)) fs.unlinkSync(gzFp);
      } catch {}
    }
  } catch {}
}

_compressOldLogs();
setInterval(_compressOldLogs, 12 * 3600 * 1000).unref();

function _ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function _write(levelLabel, tag, args) {
  const parts = args.map(a => (a instanceof Error) ? `${a.message}\n${a.stack}` : typeof a === "object" ? JSON.stringify(a) : String(a));
  const line  = `[${_ts()}] [${levelLabel.padEnd(5)}] [${tag}] ${parts.join(" ")}`;
  try { _openStream().write(line + "\n"); } catch {}
  return { parts, line };
}

function _log(levelNum, levelLabel, tag, args) {
  if (levelNum < _minLevel) return;
  const { parts } = _write(levelLabel, tag, args);
  if (_silent) return;
  const color  = COLORS[levelLabel] || COLORS.INFO;
  const prefix = `${color}[${_ts()}] [${levelLabel.padEnd(5)}] [${tag}]${RESET}`;
  if (levelNum >= LEVELS.ERROR) console.error(prefix, ...parts);
  else console.log(prefix, ...parts);
}

function success(tag, ...args) {
  if (LEVELS.OK < _minLevel) return; // FIXED: success/OK level now respects minLevel filter like all other levels
  _write("OK", tag, args);
  if (_silent) return;
  const parts = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a));
  console.log(`${COLORS.OK}[${_ts()}] [OK   ] [${tag}]${RESET}`, ...parts);
}

module.exports = {
  debug:   (tag, ...a) => _log(LEVELS.DEBUG, "DEBUG", tag, a),
  info:    (tag, ...a) => _log(LEVELS.INFO,  "INFO",  tag, a),
  warn:    (tag, ...a) => _log(LEVELS.WARN,  "WARN",  tag, a),
  error:   (tag, ...a) => _log(LEVELS.ERROR, "ERROR", tag, a),
  fatal:   (tag, ...a) => _log(LEVELS.FATAL, "FATAL", tag, a),
  success,
  setSilent:  (v) => { _silent = !!v; },
  setDebug:   (v) => { _debugMode = !!v; _minLevel = v ? 0 : 1; },
  setLevel:   (l) => { _minLevel = LEVELS[(l || "").toUpperCase()] ?? 1; },
  getLogsDir: () => LOGS_DIR,
};
