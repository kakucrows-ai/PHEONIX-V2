"use strict";
/**
 * fmt.js — Shared formatting helpers for consistent bot message style.
 *
 * Design language (Phoenix theme):
 *   ╔══[ 🔥 PHOENIX • v2.1.0 ]══╗
 *   ╚═══════════════════════════╝
 *   ◆ LABEL        ▸  value
 *   ══════════════════════════════
 */

const config = require("../config.json");

/**
 * Header box — used at start of rich responses.
 * @param {string} [subtitle]  optional line below bot name
 */
function header(subtitle) {
  const name = (config.bot?.name || "PHOENIX").toUpperCase();
  const ver  =  config.bot?.version || "2.1.0";
  const top  = `╔══[ 🔥 ${name}  •  v${ver} ]══╗`;
  const bot  = `╚${"═".repeat(top.length - 2)}╝`;
  if (subtitle) {
    return `${top}\n║  ${subtitle}\n${bot}`;
  }
  return `${top}\n${bot}`;
}

/** Bold section separator */
function divider(char) {
  return (char || "═").repeat(33);
}

/** Thin separator */
function thin() {
  return "─".repeat(33);
}

/**
 * Data row:  ◆ LABEL        ▸  value
 * Pads label to 12 chars for alignment.
 */
function row(label, value, icon) {
  const ic  = icon ? icon + " " : "◆ ";
  const lbl = (label + " ").padEnd(12, "·");
  return `${ic}${lbl}▸  ${value}`;
}

/** Bold section title */
function section(title) {
  return `\n【 ${title} 】`;
}

/** Success / error / warning / info shortcuts */
const ok  = (msg) => `✅  ${msg}`;
const err = (msg) => `✗  ${msg}`;
const wrn = (msg) => `⚠️  ${msg}`;
const inf = (msg) => `◆  ${msg}`;

/** Uptime formatter */
function uptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600)  / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

const LINE = "═════════════════════════════════";
const THIN = "─────────────────────────────────";

module.exports = { header, divider, thin, row, section, ok, err, wrn, inf, uptime, LINE, THIN };
