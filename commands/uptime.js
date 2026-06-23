"use strict";

const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const config = require("../config.json");

try {
  GlobalFonts.registerFromPath(
    path.join(__dirname, "../assets/JetBrainsMono-Bold.ttf"), "JBMono"
  );
} catch {}

function pad(n) { return String(n).padStart(2, "0"); }
function f(size, bold = true) { return (bold ? "bold " : "") + size + "px JBMono, monospace"; }

// ── Rounded rect path ─────────────────────────────────────────────────────────
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Hexagon path (flat-top) ───────────────────────────────────────────────────
function hexPath(ctx, cx, cy, rx, ry) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    const x = cx + rx * Math.cos(a);
    const y = cy + ry * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// ── Draw knob (decorative dial) ───────────────────────────────────────────────
function drawKnob(ctx, cx, cy, r) {
  // Outer ring
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#1a1a20"; ctx.fill();
  ctx.strokeStyle = "#333344"; ctx.lineWidth = 2; ctx.stroke();
  // Inner circle
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = "#101015"; ctx.fill();
  ctx.strokeStyle = "#252532"; ctx.lineWidth = 1.5; ctx.stroke();
  // Center dot
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.18, 0, Math.PI * 2);
  ctx.fillStyle = "#2a2a36"; ctx.fill();
}

// ── Draw RAM chip ─────────────────────────────────────────────────────────────
function drawChip(ctx, x, y, w, h) {
  const leg = 6, legW = 4, legs = 4; // FIXED: removed dead variable legH (declared but never used anywhere in drawChip)
  const gap = (h - legs * legW) / (legs + 1);
  // Legs left
  for (let i = 0; i < legs; i++) {
    const ly = y + gap + i * (legW + gap / legs);
    ctx.fillStyle = "#9a7030";
    ctx.fillRect(x - leg, ly, leg, legW);
  }
  // Legs right
  for (let i = 0; i < legs; i++) {
    const ly = y + gap + i * (legW + gap / legs);
    ctx.fillStyle = "#9a7030";
    ctx.fillRect(x + w, ly, leg, legW);
  }
  // Body
  ctx.fillStyle = "#1a1200";
  rrect(ctx, x, y, w, h, 4); ctx.fill();
  ctx.strokeStyle = "#c8831a"; ctx.lineWidth = 1.5;
  rrect(ctx, x, y, w, h, 4); ctx.stroke();
  // Label
  ctx.fillStyle = "#c8831a";
  ctx.font = f(9); ctx.textAlign = "center";
  ctx.fillText("RAM", x + w / 2, y + h / 2 + 4);
}

// ── Draw lock icon ────────────────────────────────────────────────────────────
function drawLock(ctx, cx, cy, locked) {
  const col = locked ? "#3fff7a" : "#404055";
  const W2 = 22, H2 = 18, arc = W2 / 2;
  // Shackle
  ctx.beginPath();
  ctx.arc(cx, cy - H2 / 2, arc, Math.PI, 0);
  ctx.strokeStyle = col; ctx.lineWidth = 3;
  ctx.stroke();
  // Body
  ctx.fillStyle = "#1a1a24";
  rrect(ctx, cx - W2 / 2 - 2, cy - H2 / 2, W2 + 4, H2, 3); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 1.5;
  rrect(ctx, cx - W2 / 2 - 2, cy - H2 / 2, W2 + 4, H2, 3); ctx.stroke();
  // Keyhole
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy - H2 / 2 + 7, 3.5, 0, Math.PI * 2); ctx.fill();
}

// ── Draw crown icon ───────────────────────────────────────────────────────────
function drawCrown(ctx, cx, cy, size, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - size, cy + size / 2);
  ctx.lineTo(cx - size, cy - size / 2);
  ctx.lineTo(cx - size / 2, cy);
  ctx.lineTo(cx, cy - size);
  ctx.lineTo(cx + size / 2, cy);
  ctx.lineTo(cx + size, cy - size / 2);
  ctx.lineTo(cx + size, cy + size / 2);
  ctx.closePath();
  ctx.fill();
  // Gems
  for (let i = -1; i <= 1; i++) {
    ctx.fillStyle = "#ffd700";
    ctx.beginPath(); ctx.arc(cx + i * size * 0.7, cy + size / 2 - 2, 2, 0, Math.PI * 2); ctx.fill();
  }
}

// ── Draw tux (linux penguin simplified) ──────────────────────────────────────
function drawTux(ctx, cx, cy, size) {
  ctx.fillStyle = "#d8d8d8";
  ctx.beginPath(); ctx.ellipse(cx, cy, size * 0.6, size, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#000000";
  ctx.beginPath(); ctx.ellipse(cx, cy, size * 0.35, size * 0.6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#ffa000";
  ctx.beginPath(); ctx.ellipse(cx, cy + size * 0.65, size * 0.3, size * 0.2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#000"; // eyes
  ctx.beginPath(); ctx.arc(cx - size * 0.18, cy - size * 0.55, size * 0.08, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + size * 0.18, cy - size * 0.55, size * 0.08, 0, Math.PI * 2); ctx.fill();
}

// ── Draw terminal icon ────────────────────────────────────────────────────────
function drawTerminal(ctx, x, y, w, h, color) {
  ctx.fillStyle = "#0d0d18";
  rrect(ctx, x, y, w, h, 4); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  rrect(ctx, x, y, w, h, 4); ctx.stroke();
  // Prompt arrow
  ctx.fillStyle = color;
  ctx.font = f(10, false); ctx.textAlign = "left";
  ctx.fillText(">_", x + 5, y + h / 2 + 4);
}

// ── Draw Node.js icon ─────────────────────────────────────────────────────────
function drawNodeIcon(ctx, cx, cy, r, color) {
  // Hexagon
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  hexPath(ctx, cx, cy, r, r); ctx.stroke();
  ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fill();
  // JS text
  ctx.fillStyle = color; ctx.font = f(9); ctx.textAlign = "center";
  ctx.fillText("JS", cx, cy + 4);
}

// ── Draw people/groups icon ───────────────────────────────────────────────────
function drawGroups(ctx, cx, cy, size, color) {
  // 3 overlapping circles representing people
  for (let i = -1; i <= 1; i++) {
    ctx.fillStyle = color + "99";
    ctx.beginPath(); ctx.arc(cx + i * size * 0.4, cy, size * 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ── Glass uptime panel ────────────────────────────────────────────────────────
function drawUptimePanel(ctx, x, y, w, h, value, label, isActive) {
  const r = 10;
  // Shadow
  ctx.shadowColor = isActive ? "rgba(88,166,255,0.3)" : "rgba(0,0,0,0.5)";
  ctx.shadowBlur = isActive ? 20 : 8;

  // Panel background
  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, "#1e2030");
  grad.addColorStop(1, "#13141a");
  ctx.fillStyle = grad;
  rrect(ctx, x, y, w, h, r); ctx.fill();

  // Panel border
  ctx.shadowBlur = 0;
  ctx.strokeStyle = isActive ? "#2a3a5a" : "#252535";
  ctx.lineWidth = 1.5;
  rrect(ctx, x, y, w, h, r); ctx.stroke();

  // Glass top highlight
  ctx.save();
  rrect(ctx, x, y, w, h, r); ctx.clip();
  const glassGrad = ctx.createLinearGradient(x, y, x, y + 20);
  glassGrad.addColorStop(0, "rgba(255,255,255,0.07)");
  glassGrad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glassGrad;
  ctx.fillRect(x, y, w, h / 2);
  ctx.restore();

  // Scan-line texture (subtle)
  ctx.strokeStyle = "rgba(255,255,255,0.02)"; ctx.lineWidth = 1;
  for (let ly = y + 4; ly < y + h; ly += 6) {
    ctx.beginPath(); ctx.moveTo(x + 2, ly); ctx.lineTo(x + w - 2, ly); ctx.stroke();
  }

  // Value text
  ctx.shadowColor = "#7ab8ff"; ctx.shadowBlur = 12;
  ctx.fillStyle = "#c8deff";
  ctx.font = f(44);
  ctx.textAlign = "center";
  ctx.fillText(value, x + w / 2, y + h / 2 + 16);
  ctx.shadowBlur = 0;

  // Label below panel
  ctx.fillStyle = "#3a4060";
  ctx.font = f(9, false);
  ctx.fillText(label, x + w / 2, y + h + 16);
}

// ── Stat panel ────────────────────────────────────────────────────────────────
function drawStatPanel(ctx, x, y, w, h, label, value, valueColor, drawIcon) {
  // Background
  ctx.fillStyle = "#0f1018";
  rrect(ctx, x, y, w, h, 6); ctx.fill();
  ctx.strokeStyle = "#1e2030"; ctx.lineWidth = 1;
  rrect(ctx, x, y, w, h, 6); ctx.stroke();

  // Label
  ctx.fillStyle = "#3a4060";
  ctx.font = f(8, false);
  ctx.textAlign = "left";
  ctx.fillText(label.toUpperCase(), x + 10, y + 18);

  // Value
  ctx.fillStyle = valueColor;
  ctx.font = f(22);
  ctx.fillText(value, x + 10, y + 44);

  // Icon (if provided)
  if (drawIcon) drawIcon(ctx, x + w - 28, y + h / 2);
}

// ── Main card builder ─────────────────────────────────────────────────────────
async function buildCard(info) {
  const W = 920, H = 530;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  // ── Base background ──────────────────────────────────────────────────────
  ctx.fillStyle = "#0b0c10";
  ctx.fillRect(0, 0, W, H);

  // Subtle radial glow in center
  const bgGlow = ctx.createRadialGradient(W/2, H/2, 50, W/2, H/2, 500);
  bgGlow.addColorStop(0, "rgba(30,40,80,0.3)");
  bgGlow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = bgGlow;
  ctx.fillRect(0, 0, W, H);

  // ── Outer frame ──────────────────────────────────────────────────────────
  ctx.strokeStyle = "#1e2035";
  ctx.lineWidth = 2;
  rrect(ctx, 1, 1, W - 2, H - 2, 12); ctx.stroke();
  ctx.strokeStyle = "#101520";
  ctx.lineWidth = 1;
  rrect(ctx, 4, 4, W - 8, H - 8, 10); ctx.stroke();

  // ── HEADER (0-68) ────────────────────────────────────────────────────────
  const headerGrad = ctx.createLinearGradient(0, 0, 0, 68);
  headerGrad.addColorStop(0, "#0f1018");
  headerGrad.addColorStop(1, "#0b0c10");
  ctx.fillStyle = headerGrad;
  ctx.fillRect(0, 0, W, 68);
  // Header separator
  ctx.strokeStyle = "#1e2035"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, 68); ctx.lineTo(W, 68); ctx.stroke();

  // Online dot
  ctx.shadowColor = "#3fff7a"; ctx.shadowBlur = 14;
  ctx.fillStyle = "#3fff7a";
  ctx.beginPath(); ctx.arc(26, 34, 7, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  // MADOX label
  ctx.fillStyle = "#b8c8e0";
  ctx.font = f(16); ctx.textAlign = "left";
  ctx.fillText((info.botName || "PHOENIX").toUpperCase(), 44, 40);

  // ── ONLINE hexagon badge ─────────────────────────────────────────────────
  const hexRx = 60, hexRy = 26;
  const hexCx = W / 2, hexCy = 34;
  // Glow
  ctx.shadowColor = "#3fff7a"; ctx.shadowBlur = 24;
  ctx.strokeStyle = "#1a4030"; ctx.lineWidth = 8;
  hexPath(ctx, hexCx, hexCy, hexRx + 6, hexRy + 4); ctx.stroke();
  ctx.shadowBlur = 0;
  // Fill
  ctx.fillStyle = "#061812";
  hexPath(ctx, hexCx, hexCy, hexRx, hexRy); ctx.fill();
  // Border
  ctx.strokeStyle = "#3fff7a"; ctx.lineWidth = 2;
  hexPath(ctx, hexCx, hexCy, hexRx, hexRy); ctx.stroke();
  // Text
  ctx.shadowColor = "#3fff7a"; ctx.shadowBlur = 10;
  ctx.fillStyle = "#3fff7a";
  ctx.font = f(15); ctx.textAlign = "center";
  ctx.fillText("ONLINE", hexCx, hexCy + 6);
  ctx.shadowBlur = 0;

  // ── Version badge ─────────────────────────────────────────────────────────
  const vbW = 74, vbH = 28;
  const vbX = W - 120, vbY = 20;
  ctx.fillStyle = "#0f1220";
  rrect(ctx, vbX, vbY, vbW, vbH, 4); ctx.fill();
  ctx.strokeStyle = "#252840"; ctx.lineWidth = 1;
  rrect(ctx, vbX, vbY, vbW, vbH, 4); ctx.stroke();
  ctx.fillStyle = "#5a6080";
  ctx.font = f(12, false); ctx.textAlign = "center";
  ctx.fillText("v" + info.version, vbX + vbW / 2, vbY + vbH / 2 + 5);

  // ── Lock icon (top right) ─────────────────────────────────────────────────
  drawLock(ctx, W - 34, 34, info.locked > 0);

  // ── RAM chip (top left of uptime section) ─────────────────────────────────
  drawChip(ctx, 24, 80, 54, 32);

  // ═════════════════════════════════════════════════════════════════════════
  // UPTIME SECTION (68–280)
  // ═════════════════════════════════════════════════════════════════════════
  // "UPTIME" label
  ctx.fillStyle = "#3a4060";
  ctx.font = f(10, false); ctx.textAlign = "center";
  ctx.fillText("U  P  T  I  M  E", W / 2, 100);

  // Knob decorations
  const knobY = 175;
  drawKnob(ctx, 90, knobY - 46, 18);   // top-left knob
  drawKnob(ctx, 90, knobY + 46, 18);   // bottom-left knob
  drawKnob(ctx, W - 90, knobY - 46, 18);  // top-right
  drawKnob(ctx, W - 90, knobY + 46, 18); // bottom-right
  drawKnob(ctx, W / 2, 254, 14);         // bottom center

  // 4 uptime panels
  const panW = 120, panH = 84;
  const totalUpW = 4 * panW + 3 * 28; // panels + colons
  const upX0 = (W - totalUpW) / 2;
  const upY  = 110;

  const segs = [
    { v: pad(info.days),  l: "DAYS" },
    { v: pad(info.hours), l: "HRS"  },
    { v: pad(info.mins),  l: "MIN"  },
    { v: pad(info.secs),  l: "SEC"  },
  ];

  segs.forEach((seg, i) => {
    const px = upX0 + i * (panW + 28);
    const isActive = i === 2 || i === 3; // FIXED: comment was wrong; indices 2 and 3 are MIN and SEC (not hours & mins) — segs = [DAYS, HRS, MIN, SEC]
    drawUptimePanel(ctx, px, upY, panW, panH, seg.v, seg.l, isActive);

    // Colon between panels
    if (i < 3) {
      ctx.fillStyle = "#1e2540";
      ctx.font = f(32); ctx.textAlign = "center";
      ctx.fillText(":", px + panW + 14, upY + 54);
    }
  });

  // Decorative line under uptime
  ctx.strokeStyle = "#1a1e30"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(24, 270); ctx.lineTo(W - 24, 270); ctx.stroke();

  // ═════════════════════════════════════════════════════════════════════════
  // STATS GRID (280–510)
  // ═════════════════════════════════════════════════════════════════════════
  const statY = 282;
  const statH  = 62;
  const col4W  = (W - 48) / 4;
  const cols   = [24, 24 + col4W + 4, 24 + (col4W + 4) * 2, 24 + (col4W + 4) * 3];
  const sw     = col4W - 4;

  // ── Row 1 ──────────────────────────────────────────────────────────────
  // RAM Usage
  drawStatPanel(ctx, cols[0], statY, sw, statH, "RAM Usage",
    info.memMB + " MB", "#ffb830",
    (c, x, y) => {
      // RAM bar
      const bW = 36, bH = 8, bX = x - bW - 2, bY = y - 4;
      ctx.fillStyle = "#1a1010";
      rrect(c, bX, bY, bW, bH, 2); c.fill();
      const pct = Math.min(info.memMB / 512, 1);
      ctx.fillStyle = "#ffb830";
      rrect(c, bX, bY, bW * pct, bH, 2); c.fill();
    }
  );

  // Active Groups
  drawStatPanel(ctx, cols[1], statY, sw, statH, "Active Groups",
    String(info.groups), "#3b8eff",
    (c, x, y) => drawGroups(c, x, y, 9, "#3b8eff")
  );

  // Commands
  drawStatPanel(ctx, cols[2], statY, sw, statH, "Commands",
    String(info.commands), "#ff3dd4",
    (c, x, y) => drawTerminal(c, x - 32, y - 11, 30, 22, "#ff3dd4")
  );

  // Locked Groups
  drawStatPanel(ctx, cols[3], statY, sw, statH, "Locked Groups",
    String(info.locked), info.locked > 0 ? "#f85149" : "#3a4060",
    (c, x, y) => drawLock(c, x, y, info.locked > 0)
  );

  // ── Row 2 ──────────────────────────────────────────────────────────────
  const statY2 = statY + statH + 6;

  // Bot Prefix
  drawStatPanel(ctx, cols[0], statY2, sw, statH, "Bot Prefix",
    info.prefix, "#e0e0e0",
    (c, x, y) => drawTerminal(c, x - 32, y - 11, 30, 22, "#555566")
  );

  // Platform
  drawStatPanel(ctx, cols[1], statY2, sw, statH, "Platform",
    info.platform, "#8899aa",
    (c, x, y) => drawTux(c, x, y - 4, 10)
  );

  // Admins
  drawStatPanel(ctx, cols[2], statY2, sw, statH, "Admins",
    String(info.admins), "#3fff7a",
    (c, x, y) => drawCrown(c, x, y - 2, 9, "#3fff7a")
  );

  // Node.js
  drawStatPanel(ctx, cols[3], statY2, sw, statH, "Node.js",
    process.version, "#f0a030",
    (c, x, y) => drawNodeIcon(c, x, y, 12, "#f0a030")
  );

  // ── Footer ──────────────────────────────────────────────────────────────
  ctx.strokeStyle = "#1a1e30"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(24, H - 38); ctx.lineTo(W - 24, H - 38); ctx.stroke();

  const now = new Date().toLocaleString("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    day: "numeric", month: "short", year: "numeric",
  });
  ctx.fillStyle = "#252840";
  ctx.font = f(10, false); ctx.textAlign = "center";
  ctx.fillText(now + "  •  " + info.botName + " v" + info.version, W / 2, H - 18);

  return canvas.toBuffer("image/png");
}

// ── Command export ────────────────────────────────────────────────────────────
module.exports = {
  name: "uptime",
  aliases: ["up", "stats"],
  description: "عرض لوحة تحكم البوت كصورة.",
  usage: "uptime",
  category: "General",

  async execute({ api, event, commands }) {
    const total  = Math.floor(process.uptime());
    const days   = Math.floor(total / 86400);
    const hours  = Math.floor((total % 86400) / 3600);
    const mins   = Math.floor((total % 3600) / 60);
    const secs   = total % 60;
    const memMB  = Math.round(process.memoryUsage().rss / 1024 / 1024);

    let groups = 0, locked = 0;
    try {
      const state = require("../state");
      groups = state.groupsCache.size;
      locked = state.lockedThreads.size;
    } catch {}

    const cmdCount = commands ? [...new Set(commands.values())].length : 0;
    const admins   = Array.isArray(config.bot.adminIDs) ? config.bot.adminIDs.length : 0;

    const info = {
      botName:  config.bot.name  || "PHOENIX",
      version:  config.bot.version || "2.1.0",
      prefix:   config.prefix    || "-",
      days, hours, mins, secs,
      memMB, groups, locked,
      commands: cmdCount,
      admins,
      platform: os.platform(),
    };

    const tmpFile = path.join(os.tmpdir(), "uptime_" + Date.now() + ".png");
    try {
      const buf = await buildCard(info);
      fs.writeFileSync(tmpFile, buf);
      await api.sendMessage(
        { body: "", attachment: [fs.createReadStream(tmpFile)] },
        event.threadID
      );
    } catch (err) {
      api.sendMessage(
        info.botName + " v" + info.version + "\n" +
        "Uptime: " + days + "d " + hours + "h " + mins + "m " + secs + "s\n" +
        "RAM: " + memMB + " MB  |  Groups: " + groups + "  |  Commands: " + cmdCount,
        event.threadID
      );
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  },
};
