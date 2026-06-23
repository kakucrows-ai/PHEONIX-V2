"use strict";

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function fmtUptime(s) {
  if (s < 60)   return `${s}ث`;
  if (s < 3600) return `${Math.floor(s/60)}د ${s%60}ث`;
  return `${Math.floor(s/3600)}س ${Math.floor((s%3600)/60)}د`;
}
function fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString("ar") : "—"; }
function fmtDate(ts) { return ts ? new Date(ts).toLocaleString("ar") : "—"; }
function fmtMem(mb)  { return mb >= 1024 ? `${(mb/1024).toFixed(1)}GB` : `${mb}MB`; }

// ── Auth ──────────────────────────────────────────────────────────────────────
let _token = sessionStorage.getItem("token") || "";
const _base = "";

function getToken()  { return _token; }
function setToken(t) { _token = t; sessionStorage.setItem("token", t); }
function clearToken(){ _token = ""; sessionStorage.removeItem("token"); }

async function API(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (_token) headers["Authorization"] = `Bearer ${_token}`;
  const r = await fetch(_base + path, { headers, ...opts });
  if (r.status === 401) { showLogin(); throw new Error("Unauthorized"); }
  return r;
}
async function apiFetch(path, opts)  { return (await API(path, opts)).json(); }
async function apiPost(path, body)   { return apiFetch(path, { method: "POST",   body: JSON.stringify(body || {}) }); }
async function apiPut(path, body)    { return apiFetch(path, { method: "PUT",    body: JSON.stringify(body || {}) }); }
async function apiDel(path)          { return apiFetch(path, { method: "DELETE" }); }

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, type = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show ${type}-t`;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.className = "toast"; }, 3000);
}

// ── Login / Logout ────────────────────────────────────────────────────────────
async function doLogin() {
  const key = $("#loginKey").value.trim();
  const btn = $("#loginBtn");
  btn.disabled = true; btn.textContent = "جاري التحقق…";
  try {
    const r = await apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ key }) });
    if (r.success) { setToken(r.token); showApp(); }
    else           { $("#loginError").textContent = "مفتاح خاطئ"; }
  } catch { $("#loginError").textContent = "تعذر الاتصال بالخادم"; }
  finally  { btn.disabled = false; btn.textContent = "دخول"; }
}

document.addEventListener("keydown", e => {
  if (e.key === "Enter" && $("#loginScreen").style.display !== "none") doLogin();
});

function doLogout() { clearToken(); showLogin(); }

function showLogin() {
  $("#loginScreen").style.display = "flex";
  $("#app").style.display = "none";
  stopPolling(); disconnectWS();
}

function showApp() {
  $("#loginScreen").style.display = "none";
  $("#app").style.display = "flex";
  buildTabs();
  loadTab("overview");
  startPolling();
  connectWS();
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
const TAB_LIST = [
  { id: "overview",    label: "📊 نظرة عامة" },
  { id: "control",     label: "🎛️ التحكم" },
  { id: "commands",    label: "📜 الأوامر" },
  { id: "cookies",     label: "🍪 الجلسة" },
  { id: "config",      label: "⚙️ الإعدادات" },
  { id: "files",       label: "📁 الملفات" },
  { id: "active",      label: "⚡ النشاط" },
  { id: "protection",  label: "🛡️ الحماية" },
  { id: "allowlist",   label: "✅ القوائم" },
  { id: "features",    label: "🎛️ المميزات" },
  { id: "security",    label: "🔒 الأمان" },
  { id: "bans",        label: "⛔ الحظر" },
  { id: "audit",       label: "📋 سجل المراجعة" },
];

let _currentTab = "";

function buildTabs() {
  const bar = $("#tabBar");
  bar.innerHTML = "";
  for (const t of TAB_LIST) {
    const btn = el("button", { class: "tab-btn", onclick: () => loadTab(t.id) }, t.label);
    btn.dataset.tab = t.id;
    bar.appendChild(btn);
  }
}

async function loadTab(name) {
  if (_currentTab === name) return;
  const prev = $("#content");
  if (prev._cleanup) { prev._cleanup(); prev._cleanup = null; }
  _currentTab = name;
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  const root = $("#content");
  root.innerHTML = `<div class="loading"><div class="spinner"></div> جاري التحميل…</div>`;
  if (TABS[name]) {
    try { await TABS[name](root); }
    catch (e) { root.innerHTML = `<div class="card"><p style="color:var(--err)">خطأ: ${e.message}</p></div>`; }
  }
}

// ── Topbar polling ────────────────────────────────────────────────────────────
let _pollingInterval = null;

function startPolling() { pollTopbar(); _pollingInterval = setInterval(pollTopbar, 5000); }
function stopPolling()  { if (_pollingInterval) { clearInterval(_pollingInterval); _pollingInterval = null; } }

async function pollTopbar() {
  try {
    const d = await apiFetch("/overview");
    const status = d.status || "unknown";
    const pill = $("#pillStatus");
    if (pill) {
      pill.textContent = status === "online" ? "🟢 متصل" : `🔴 ${status}`;
      pill.className = `pill ${status === "online" ? "ok" : "err"}`;
    }
    const pg = $("#pillGroups"); if (pg) pg.textContent = `${d.groupCount || 0} مجموعة`;
    const pu = $("#pillUptime"); if (pu) pu.textContent = d.uptime ? fmtUptime(d.uptime) : "—";
    const pm = $("#pillMem");    if (pm) pm.textContent = `RAM: ${d.health ? fmtMem(d.health.memMB) : "—"}`;
  } catch {}
}

// ── SSE live feed ─────────────────────────────────────────────────────────────
let _sse = null;
const _wsHandlers = [];

function connectWS() {
  if (_sse) _sse.close();
  const url = `https://messenger-bot-production-c98b.up.railway.app/stream${_token ? "?token=" + encodeURIComponent(_token) : ""}`;
  try {
    _sse = new EventSource(url);
    _sse.onmessage = e => {
      try { const d = JSON.parse(e.data); for (const h of _wsHandlers) h(d); } catch {}
    };
    _sse.onerror = () => { setTimeout(() => { if (_token) connectWS(); }, 5000); };
  } catch {}
}

function disconnectWS() { if (_sse) { _sse.close(); _sse = null; } }

function subscribeWS(fn) {
  _wsHandlers.push(fn);
  return () => { const i = _wsHandlers.indexOf(fn); if (i >= 0) _wsHandlers.splice(i, 1); };
}

// ── Helper builders ───────────────────────────────────────────────────────────
function statCard(label, value, sub) {
  return el("div", { class: "stat" },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, String(value)),
    sub ? el("div", { class: "sub" }, sub) : null,
  );
}

function infoRow(label, value) {
  return el("div", { class: "info-row" },
    el("span", { class: "info-label" }, label),
    el("span", { class: "info-value" }, String(value ?? "—")),
  );
}

function toggleRow(label, desc, checked, onChange) {
  const id = "tog_" + Math.random().toString(36).slice(2);
  const inp = el("input", { type: "checkbox" });
  inp.checked = !!checked;
  inp.addEventListener("change", () => onChange(inp.checked));
  const lbl = el("label", { class: "toggle" });
  lbl.appendChild(inp);
  lbl.appendChild(el("span", { class: "toggle-slider" }));
  return el("div", { class: "toggle-row" },
    el("div", { class: "toggle-info" },
      el("div", { class: "toggle-label" }, label),
      desc ? el("div", { class: "toggle-desc" }, desc) : null,
    ),
    lbl,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TABS
// ══════════════════════════════════════════════════════════════════════════════
const TABS = {};

// ── OVERVIEW ─────────────────────────────────────────────────────────────────
TABS.overview = async (root) => {
  root.innerHTML = "";
  let d;
  try { d = await apiFetch("/overview"); } catch { d = {}; }
  const hs = d.health || {};

  root.appendChild(el("div", { class: "grid cols-4", style: "margin-bottom:16px" },
    statCard("الحالة",       d.status === "online" ? "متصل ✅" : (d.status || "غير معروف"), ""),
    statCard("المجموعات",    d.groupCount  || 0,    "مجموعة نشطة"),
    statCard("وقت التشغيل",  fmtUptime(d.uptime || 0), "منذ آخر تشغيل"),
    statCard("الرسائل",      d.totalMessages || 0,  "إجمالي الرسائل"),
  ));

  const grid = el("div", { class: "page-cols" });

  // Health card
  const hc = el("div", { class: "card" });
  hc.appendChild(el("h2", {}, "📊 صحة النظام"));
  hc.appendChild(infoRow("الذاكرة المستخدمة", hs.memMB ? fmtMem(hs.memMB) : "—"));
  hc.appendChild(infoRow("CPU", hs.cpuPct !== undefined ? `${hs.cpuPct}%` : "—"));
  hc.appendChild(infoRow("تأخير حلقة الأحداث", hs.loopLagMs !== undefined ? `${hs.loopLagMs.toFixed(0)}ms` : "—"));
  hc.appendChild(infoRow("المجموعات المقفولة", d.lockedCount || 0));
  hc.appendChild(infoRow("المجموعات المكتومة", d.mutedCount  || 0));
  hc.appendChild(infoRow("الأوامر المنفَّذة",  d.totalCommands || 0));
  if (hs.memMB) {
    const pct = Math.min(100, (hs.memMB / 700) * 100);
    const color = pct > 85 ? "var(--err)" : pct > 55 ? "var(--warn)" : "var(--ok)";
    const bar = el("div", { class: "progress-bar" });
    bar.appendChild(el("div", { class: "progress-fill", style: `width:${pct}%;background:linear-gradient(90deg,${color},var(--blue))` }));
    hc.appendChild(bar);
  }
  grid.appendChild(hc);

  // Human sim card
  const hs2 = d.humanSim || {};
  const hsc = el("div", { class: "card" });
  hsc.appendChild(el("h2", {}, "🧠 محاكاة بشرية"));
  const dot = el("span", { style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${hs2.running ? "var(--ok)" : "var(--text-faint)"};margin-left:8px;box-shadow:${hs2.running ? "0 0 6px var(--ok)" : "none"}` });
  hsc.appendChild(el("div", { style: "display:flex;align-items:center;margin-bottom:12px;font-size:13px;color:var(--text-dim)" }, dot, hs2.running ? "نشط — يحاكي سلوك إنساني" : "متوقف"));
  if (hs2.stats) {
    hsc.appendChild(infoRow("إشارات التواجد",  hs2.stats.presenceSent  || 0));
    hsc.appendChild(infoRow("محاكاة الكتابة",  hs2.stats.typingSimulated || 0));
    hsc.appendChild(infoRow("قراءة المحادثات", hs2.stats.threadsRead   || 0));
    hsc.appendChild(infoRow("آخر نشاط",        fmtTime(hs2.stats.lastActionAt)));
  }
  grid.appendChild(hsc);
  root.appendChild(grid);

  // Recent activity
  const ac = el("div", { class: "card", style: "margin-top:16px" });
  ac.appendChild(el("h2", {}, "🕐 النشاط الأخير"));
  const logDiv = el("div", { class: "log-stream" });
  const activities = d.recentActivity || [];
  if (!activities.length) logDiv.appendChild(el("div", { class: "log-line DEFAULT" }, "لا يوجد نشاط حديث"));
  else for (const a of activities) logDiv.appendChild(el("div", { class: "log-line OK" }, `[${fmtTime(a.time)}] ${a.message}`));
  ac.appendChild(logDiv);
  root.appendChild(ac);

  const unsub = subscribeWS(msg => {
    if (msg.type === "activity") {
      const line = el("div", { class: "log-line OK" }, `[${fmtTime(msg.data?.time)}] ${msg.data?.message || ""}`);
      logDiv.insertBefore(line, logDiv.firstChild);
    }
  });
  root._cleanup = unsub;
};

// ── CONTROL ──────────────────────────────────────────────────────────────────
TABS.control = async (root) => {
  root.innerHTML = "";

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "🎛️ التحكم في البوت"));

  // Status section
  let status;
  try { status = await apiFetch("/overview"); } catch { status = {}; }

  const statusBadge = el("span", { class: `badge ${status.status === "online" ? "ok" : "err"}` }, status.status === "online" ? "متصل" : "غير متصل");
  card.appendChild(el("div", { class: "info-row" }, el("span", { class: "info-label" }, "حالة البوت"), statusBadge));
  card.appendChild(el("div", { class: "info-row" }, el("span", { class: "info-label" }, "آخر تحديث"), el("span", { class: "info-value" }, fmtDate(Date.now()))));

  card.appendChild(el("div", { class: "card-section" },
    el("div", { class: "card-section-title" }, "إجراءات النظام"),
    el("div", { class: "btn-row", style: "margin-top:8px" },
      el("button", { class: "btn primary",
        onclick: async () => {
          if (!confirm("هل تريد إعادة تشغيل البوت؟")) return;
          const r = await apiPost("/restart");
          r.success ? toast("جاري إعادة التشغيل…", "warn") : toast("فشل", "err");
        }
      }, "🔄 إعادة تشغيل البوت"),
      el("button", { class: "btn ghost",
        onclick: async () => {
          const r = await apiPost("/reconnect");
          r.success ? toast("جاري إعادة الاتصال…", "warn") : toast("فشل", "err");
        }
      }, "🔌 إعادة الاتصال"),
      el("button", { class: "btn ghost",
        onclick: async () => {
          const r = await apiPost("/diagnostics/snapshot");
          r.success ? toast("تم إنشاء Snapshot", "ok") : toast("فشل", "err");
        }
      }, "📸 إنشاء Snapshot"),
    )
  ));

  // Broadcast
  const bc = el("div", { class: "card-section" });
  bc.appendChild(el("div", { class: "card-section-title" }, "📣 بث جماعي"));
  const msgArea = el("textarea", { placeholder: "اكتب رسالة لبثها لجميع المجموعات…" });
  bc.appendChild(msgArea);
  const res = el("div", { style: "margin-top:8px;font-size:12px;color:var(--text-dim)" });
  bc.appendChild(res);
  bc.appendChild(el("button", { class: "btn primary", style: "margin-top:10px",
    onclick: async () => {
      const msg = msgArea.value.trim();
      if (!msg) { toast("أدخل رسالة أولاً", "warn"); return; }
      res.textContent = "⏳ جاري الإرسال…";
      try {
        const r = await apiPost("/broadcast", { message: msg });
        res.textContent = r.success ? `✅ تم الإرسال إلى ${r.sent} مجموعة · فشل ${r.failed}` : "❌ فشل الإرسال";
        r.success ? toast(`بث ناجح: ${r.sent} مجموعة`, "ok") : toast("فشل", "err");
      } catch { res.textContent = "❌ خطأ"; }
    }
  }, "📣 إرسال للجميع"));
  card.appendChild(bc);

  root.appendChild(card);
};

// ── COMMANDS ──────────────────────────────────────────────────────────────────
TABS.commands = async (root) => {
  root.innerHTML = "";
  let cmds;
  try { cmds = await apiFetch("/commands"); } catch { cmds = []; }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, `📜 الأوامر (${cmds.length})`));

  if (!cmds.length) {
    card.appendChild(el("div", { class: "empty" }, el("div", { class: "empty-icon" }, "📜"), "لا توجد أوامر مسجّلة"));
    root.appendChild(card);
    return;
  }

  const tbl = el("table", { class: "tbl" });
  tbl.appendChild(el("thead", {}, el("tr", {},
    el("th", {}, "الاسم"), el("th", {}, "الوصف"), el("th", {}, "المستعارات"), el("th", {}, "الصلاحيات")
  )));
  const tbody = el("tbody");
  for (const c of cmds) {
    const perms = [];
    if (c.adminOnly) perms.push(el("span", { class: "badge warn" }, "مشرف"));
    if (c.groupOnly) perms.push(el("span", { class: "badge blue" }, "مجموعات"));
    if (!perms.length) perms.push(el("span", { class: "badge ok" }, "الجميع"));
    tbody.appendChild(el("tr", {},
      el("td", {}, el("code", { style: "color:var(--cyan);font-family:'JetBrains Mono',monospace;font-size:12px" }, `-${c.name}`)),
      el("td", { style: "color:var(--text-dim);font-size:12px" }, c.description || "—"),
      el("td", { style: "color:var(--text-faint);font-size:11px;font-family:'JetBrains Mono',monospace" }, c.aliases?.map(a => `-${a}`).join(", ") || "—"),
      el("td", {}, ...perms),
    ));
  }
  tbl.appendChild(tbody);
  card.appendChild(tbl);
  root.appendChild(card);
};

// ── COOKIES ──────────────────────────────────────────────────────────────────
TABS.cookies = async (root) => {
  root.innerHTML = "";
  let info;
  try { info = await apiFetch("/session"); } catch { info = {}; }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "🍪 إدارة الجلسة"));

  const statusColor = info.valid ? "ok" : "err";
  card.appendChild(infoRow("حالة الجلسة", el("span", { class: `badge ${statusColor}` }, info.valid ? "صالحة ✅" : "غير صالحة ❌")));
  card.appendChild(infoRow("آخر تحديث", fmtDate(info.lastSaved)));
  card.appendChild(infoRow("حجم الملف",  info.size ? `${info.size} bytes` : "—"));

  const sec = el("div", { class: "card-section" });
  sec.appendChild(el("div", { class: "card-section-title" }, "رفع ملف AppState"));

  const fileInput = el("input", { type: "file" });
  fileInput.setAttribute("accept", ".json");
  fileInput.style.cssText = "display:block;margin-bottom:12px;color:var(--text-dim);font-size:13px;";
  sec.appendChild(fileInput);

  sec.appendChild(el("div", { class: "btn-row" },
    el("button", { class: "btn primary",
      onclick: async () => {
        const file = fileInput.files[0];
        if (!file) { toast("اختر ملفاً أولاً", "warn"); return; }
        const text = await file.text();
        try { JSON.parse(text); } catch { toast("الملف غير صالح (JSON خاطئ)", "err"); return; }
        const r = await apiPost("/session/upload", { appstate: text });
        r.success ? toast("تم رفع الجلسة بنجاح ✅", "ok") : toast("فشل الرفع", "err");
      }
    }, "⬆️ رفع AppState"),
    el("button", { class: "btn ghost",
      onclick: async () => {
        const r = await apiPost("/session/refresh");
        r.success ? toast("تم التحديث بنجاح", "ok") : toast("فشل", "err");
      }
    }, "🔄 تحديث الجلسة"),
    el("button", { class: "btn danger",
      onclick: async () => {
        if (!confirm("هل تريد حذف الجلسة الحالية؟")) return;
        const r = await apiDel("/session");
        r.success ? toast("تم حذف الجلسة", "ok") : toast("فشل", "err");
      }
    }, "🗑️ حذف الجلسة"),
  ));

  card.appendChild(sec);
  root.appendChild(card);
};

// ── CONFIG ────────────────────────────────────────────────────────────────────
TABS.config = async (root) => {
  root.innerHTML = "";
  let cfg;
  try { cfg = await apiFetch("/config"); } catch { cfg = {}; }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "⚙️ الإعدادات (config.json)"));

  const info = el("div", { style: "font-size:12px;color:var(--text-dim);margin-bottom:12px" }, "تعديل مباشر على config.json — احرص على صحة JSON قبل الحفظ.");
  card.appendChild(info);

  const ta = el("textarea", { style: "min-height:400px;width:100%" });
  ta.value = JSON.stringify(cfg, null, 2);
  card.appendChild(ta);

  const errDiv = el("div", { style: "color:var(--err);font-size:12px;margin-top:8px;min-height:16px" });
  card.appendChild(errDiv);

  card.appendChild(el("div", { class: "btn-row", style: "margin-top:12px" },
    el("button", { class: "btn primary",
      onclick: async () => {
        errDiv.textContent = "";
        let parsed;
        try { parsed = JSON.parse(ta.value); }
        catch (e) { errDiv.textContent = `JSON خاطئ: ${e.message}`; return; }
        const r = await apiPost("/config", parsed);
        r.success ? toast("تم حفظ الإعدادات ✅", "ok") : toast("فشل الحفظ", "err");
      }
    }, "💾 حفظ"),
    el("button", { class: "btn ghost",
      onclick: async () => {
        try { cfg = await apiFetch("/config"); ta.value = JSON.stringify(cfg, null, 2); toast("تم التحديث", "ok"); }
        catch { toast("فشل", "err"); }
      }
    }, "🔄 تحديث"),
  ));

  root.appendChild(card);
};

// ── FILES ─────────────────────────────────────────────────────────────────────
TABS.files = async (root) => {
  root.innerHTML = "";
  let files;
  try { files = await apiFetch("/files"); } catch { files = []; }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "📁 إدارة الملفات"));

  const layout = el("div", { class: "file-layout" });

  const tree = el("div", { class: "file-tree" });
  const editor = el("div", {});
  const ta = el("textarea", { placeholder: "اختر ملفاً من القائمة…", style: "min-height:380px" });
  const editorTitle = el("div", { style: "font-size:12px;color:var(--text-dim);margin-bottom:8px;font-family:'JetBrains Mono',monospace" }, "");
  const btnRow = el("div", { class: "btn-row", style: "margin-top:10px" });
  editor.appendChild(editorTitle);
  editor.appendChild(ta);
  editor.appendChild(btnRow);

  let _selectedFile = null;

  for (const f of files) {
    const item = el("div", { class: "file-item",
      onclick: async () => {
        $$(".file-item", tree).forEach(i => i.classList.remove("active"));
        item.classList.add("active");
        _selectedFile = f.path;
        editorTitle.textContent = f.path;
        ta.value = "جاري التحميل…";
        try {
          const r = await apiFetch(`/files/${encodeURIComponent(f.path)}`);
          ta.value = r.content || "";
        } catch { ta.value = "فشل التحميل"; }
      }
    }, f.icon || "📄", " ", f.name || f.path);
    tree.appendChild(item);
  }

  if (!files.length) tree.appendChild(el("div", { style: "color:var(--text-faint);font-size:12px;padding:8px" }, "لا توجد ملفات"));

  btnRow.appendChild(el("button", { class: "btn primary",
    onclick: async () => {
      if (!_selectedFile) { toast("اختر ملفاً أولاً", "warn"); return; }
      const r = await apiPost(`/files/${encodeURIComponent(_selectedFile)}`, { content: ta.value });
      r.success ? toast("تم الحفظ ✅", "ok") : toast("فشل الحفظ", "err");
    }
  }, "💾 حفظ"));

  btnRow.appendChild(el("button", { class: "btn danger",
    onclick: async () => {
      if (!_selectedFile) return;
      if (!confirm(`هل تريد حذف "${_selectedFile}"؟`)) return;
      const r = await apiDel(`/files/${encodeURIComponent(_selectedFile)}`);
      if (r.success) { toast("تم الحذف", "ok"); await loadTab("files"); }
      else toast("فشل الحذف", "err");
    }
  }, "🗑️ حذف"));

  layout.appendChild(tree);
  layout.appendChild(editor);
  card.appendChild(layout);
  root.appendChild(card);
};

// ── ACTIVE JOBS ───────────────────────────────────────────────────────────────
TABS.active = async (root) => {
  root.innerHTML = "";
  let jobs;
  try { jobs = await apiFetch("/jobs"); } catch { jobs = []; }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, `⚡ المهام النشطة (${jobs.length})`));

  if (!jobs.length) {
    card.appendChild(el("div", { class: "empty" }, el("div", { class: "empty-icon" }, "⚡"), "لا توجد مهام نشطة"));
    root.appendChild(card);
    return;
  }

  for (const job of jobs) {
    const row = el("div", { class: "info-row" });
    const info = el("div", {});
    info.appendChild(el("div", { style: "font-weight:600;font-size:13px" }, job.name || job.id));
    info.appendChild(el("div", { style: "font-size:11px;color:var(--text-dim);margin-top:2px;font-family:'JetBrains Mono',monospace" },
      `بدأ: ${fmtTime(job.startedAt)} · المجموعة: ${job.threadID || "—"}`
    ));
    row.appendChild(info);
    row.appendChild(el("button", { class: "btn danger",
      onclick: async () => {
        const r = await apiDel(`/jobs/${job.id}`);
        r.success ? (toast("تم إيقاف المهمة", "ok"), await loadTab("active")) : toast("فشل", "err");
      }
    }, "⛔ إيقاف"));
    card.appendChild(row);
  }

  root.appendChild(card);
};

// ── PROTECTION ────────────────────────────────────────────────────────────────
TABS.protection = async (root) => {
  root.innerHTML = "";
  let groups;
  try { groups = await apiFetch("/groups"); } catch { groups = []; }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "🛡️ إعدادات الحماية لكل مجموعة"));

  if (!groups.length) {
    card.appendChild(el("div", { class: "empty" }, el("div", { class: "empty-icon" }, "🛡️"), "لا توجد مجموعات"));
    root.appendChild(card);
    return;
  }

  for (const g of groups) {
    const sec = el("div", { class: "card-section" });
    sec.appendChild(el("div", { class: "card-section-title" }, g.name || g.threadID));

    sec.appendChild(toggleRow("🔒 قفل المجموعة", "منع الرسائل من غير المشرفين", g.isLocked, async v => {
      const r = await apiPost(`/groups/${g.threadID}/lock`, { locked: v });
      r.success ? toast(v ? "تم قفل المجموعة" : "تم فتح المجموعة", "ok") : toast("فشل", "err");
    }));

    sec.appendChild(toggleRow("🔇 كتم المجموعة", "تجاهل جميع الرسائل الواردة", g.isMuted, async v => {
      const r = await apiPost(`/groups/${g.threadID}/mute`, { muted: v });
      r.success ? toast(v ? "تم كتم المجموعة" : "تم تفعيل المجموعة", "ok") : toast("فشل", "err");
    }));

    sec.appendChild(toggleRow("🤖 الرد التلقائي", "تفعيل الردود التلقائية", g.hasAutoReply, async v => {
      const r = await apiPost(`/groups/${g.threadID}/autoreply`, { enabled: v });
      r.success ? toast("تم الحفظ", "ok") : toast("فشل", "err");
    }));

    card.appendChild(sec);
  }

  root.appendChild(card);
};

// ── ALLOWLIST ─────────────────────────────────────────────────────────────────
TABS.allowlist = async (root) => {
  root.innerHTML = "";
  let data;
  try { data = await apiFetch("/allowlist"); } catch { data = { mode: "off", list: [] }; }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "✅ إدارة القوائم"));

  // Mode selector
  const modes = [
    { id: "off",       label: "⭕ إيقاف", desc: "لا قيود" },
    { id: "whitelist", label: "✅ قائمة بيضاء", desc: "مسموح فقط للمدرجين" },
    { id: "blacklist", label: "⛔ قائمة سوداء", desc: "محظور على المدرجين" },
  ];

  let _mode = data.mode || "off";
  const modeRow = el("div", { class: "radio-group" });
  const opts = {};
  for (const m of modes) {
    const opt = el("div", { class: `radio-opt${_mode === m.id ? " selected" : ""}`,
      onclick: async () => {
        _mode = m.id;
        Object.values(opts).forEach(o => o.classList.remove("selected"));
        opt.classList.add("selected");
        await apiPost("/allowlist/mode", { mode: _mode });
        toast(`تم تعيين الوضع: ${m.label}`, "ok");
      }
    }, el("div", { style: "font-size:18px" }, m.label.split(" ")[0]),
       el("div", { style: "font-size:12px;font-weight:700" }, m.label.split(" ").slice(1).join(" ")),
       el("div", { style: "font-size:10px;color:var(--text-dim)" }, m.desc));
    opts[m.id] = opt;
    modeRow.appendChild(opt);
  }
  card.appendChild(modeRow);

  // List editor
  card.appendChild(el("div", { class: "card-section-title", style: "margin-top:16px" }, "القائمة"));
  const listDiv = el("div", { class: "list-editor" });

  const renderList = () => {
    listDiv.innerHTML = "";
    for (const uid of (data.list || [])) {
      listDiv.appendChild(el("div", { class: "list-item" },
        el("span", {}, uid),
        el("button", { onclick: async () => {
          data.list = data.list.filter(x => x !== uid);
          await apiPost("/allowlist/remove", { uid });
          renderList();
          toast("تم الحذف", "ok");
        }}, "✕")
      ));
    }
    if (!data.list?.length) listDiv.appendChild(el("div", { style: "color:var(--text-faint);font-size:12px;padding:8px" }, "القائمة فارغة"));
  };
  renderList();
  card.appendChild(listDiv);

  const addRow = el("div", { style: "display:flex;gap:8px" });
  const addInp = el("input", { type: "text", placeholder: "أدخل معرف المستخدم (UID)…", style: "flex:1" });
  addRow.appendChild(addInp);
  addRow.appendChild(el("button", { class: "btn primary",
    onclick: async () => {
      const uid = addInp.value.trim();
      if (!uid) return;
      await apiPost("/allowlist/add", { uid });
      data.list = [...(data.list || []), uid];
      addInp.value = "";
      renderList();
      toast("تمت الإضافة", "ok");
    }
  }, "إضافة"));
  card.appendChild(addRow);
  root.appendChild(card);
};

// ── FEATURES ──────────────────────────────────────────────────────────────────
TABS.features = async (root) => {
  root.innerHTML = "";
  let data;
  try { data = await apiFetch("/features"); } catch { data = {}; }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "🎛️ تفعيل / تعطيل المميزات"));

  const featureList = [
    { key: "autoSaveAppState",  label: "حفظ الجلسة تلقائياً",    desc: "يحفظ AppState بشكل دوري" },
    { key: "greetNewMembers",   label: "استقبال الأعضاء الجدد",  desc: "رسالة ترحيب عند الانضمام" },
    { key: "farewellMembers",   label: "وداع الأعضاء",           desc: "رسالة وداع عند المغادرة" },
    { key: "antiSpam",          label: "مكافحة السبام",           desc: "تأخير بين الرسائل المتكررة" },
    { key: "logMessages",       label: "تسجيل الرسائل",          desc: "حفظ الرسائل في السجل" },
    { key: "humanSimulator",    label: "محاكاة الإنسان",         desc: "يجعل الحساب يبدو طبيعياً" },
    { key: "autoReconnect",     label: "إعادة الاتصال التلقائي", desc: "يتصل تلقائياً عند الانقطاع" },
    { key: "simulateTyping",    label: "محاكاة الكتابة",         desc: "يظهر مؤشر الكتابة" },
    { key: "autoMarkRead",      label: "قراءة تلقائية",          desc: "يحدد الرسائل كمقروءة" },
  ];

  const grid = el("div", { class: "checkbox-grid" });

  for (const f of featureList) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !!(data[f.key]);
    cb.addEventListener("change", async () => {
      const r = await apiPost("/features", { [f.key]: cb.checked });
      r.success ? toast(`${f.label}: ${cb.checked ? "مفعّل" : "معطّل"}`, "ok") : toast("فشل", "err");
    });
    const item = el("label", { class: "checkbox-item" }, cb,
      el("div", {},
        el("div", { class: "checkbox-item-label" }, f.label),
        el("div", { class: "checkbox-item-desc" }, f.desc),
      )
    );
    grid.appendChild(item);
  }

  card.appendChild(grid);
  root.appendChild(card);
};

// ── SECURITY ──────────────────────────────────────────────────────────────────
TABS.security = async (root) => {
  root.innerHTML = "";
  let cfg;
  try { cfg = await apiFetch("/security"); } catch { cfg = {}; }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "🔒 إعدادات الأمان"));

  function numField(label, key, placeholder) {
    const grp = el("div", { class: "form-group" });
    grp.appendChild(el("label", {}, label));
    const inp = el("input", { type: "number", placeholder });
    inp.value = cfg[key] ?? "";
    grp.appendChild(inp);
    return { grp, inp, key };
  }

  const fields = [
    numField("تأخير مكافحة السبام (ms)", "antiSpamCooldownMs", "3000"),
    numField("الحد الأقصى للطلبات في الدقيقة", "maxRequestsPerMinute", "40"),
    numField("تأخير الطلبات (ms)", "requestCooldownMs", "60000"),
    numField("الحد الأقصى للطلبات المتزامنة", "maxConcurrentRequests", "5"),
  ];

  const grid = el("div", { class: "grid cols-2" });
  for (const f of fields) grid.appendChild(f.grp);
  card.appendChild(grid);

  // Content filter
  const cfSec = el("div", { class: "card-section" });
  cfSec.appendChild(el("div", { class: "card-section-title" }, "فلتر المحتوى (كلمات محظورة)"));
  const filterTa = el("textarea", { placeholder: "كلمة واحدة في كل سطر…", style: "min-height:100px" });
  filterTa.value = (cfg.bannedWords || []).join("\n");
  cfSec.appendChild(filterTa);
  card.appendChild(cfSec);

  card.appendChild(el("div", { class: "btn-row", style: "margin-top:16px" },
    el("button", { class: "btn primary",
      onclick: async () => {
        const body = {};
        for (const f of fields) { const v = parseInt(f.inp.value); if (!isNaN(v)) body[f.key] = v; }
        body.bannedWords = filterTa.value.split("\n").map(s => s.trim()).filter(Boolean);
        const r = await apiPost("/security", body);
        r.success ? toast("تم حفظ إعدادات الأمان ✅", "ok") : toast("فشل الحفظ", "err");
      }
    }, "💾 حفظ"),
  ));

  root.appendChild(card);
};

// ── BANS ──────────────────────────────────────────────────────────────────────
TABS.bans = async (root) => {
  root.innerHTML = "";
  let bans;
  try { bans = await apiFetch("/bans"); } catch { bans = []; }

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, `⛔ قائمة الحظر (${bans.length})`));

  // Add ban
  const addSec = el("div", { class: "card-section" });
  addSec.appendChild(el("div", { class: "card-section-title" }, "حظر مستخدم جديد"));
  const banRow = el("div", { style: "display:flex;gap:8px" });
  const banInp = el("input", { type: "text", placeholder: "معرف المستخدم (UID)…", style: "flex:1" });
  const banReason = el("input", { type: "text", placeholder: "السبب (اختياري)…", style: "flex:1" });
  banRow.appendChild(banInp);
  banRow.appendChild(banReason);
  banRow.appendChild(el("button", { class: "btn danger",
    onclick: async () => {
      const uid = banInp.value.trim();
      if (!uid) { toast("أدخل معرف المستخدم", "warn"); return; }
      const r = await apiPost("/bans", { uid, reason: banReason.value.trim() });
      if (r.success) { toast("تم حظر المستخدم", "ok"); await loadTab("bans"); }
      else toast("فشل", "err");
    }
  }, "⛔ حظر"));
  addSec.appendChild(banRow);
  card.appendChild(addSec);

  if (!bans.length) {
    card.appendChild(el("div", { class: "empty" }, el("div", { class: "empty-icon" }, "✅"), "لا يوجد مستخدمون محظورون"));
    root.appendChild(card);
    return;
  }

  const tbl = el("table", { class: "tbl" });
  tbl.appendChild(el("thead", {}, el("tr", {},
    el("th", {}, "المعرف"), el("th", {}, "السبب"), el("th", {}, "التاريخ"), el("th", {}, "إجراء")
  )));
  const tbody = el("tbody");
  for (const b of bans) {
    tbody.appendChild(el("tr", {},
      el("td", { style: "font-family:'JetBrains Mono',monospace;color:var(--cyan);font-size:12px" }, b.uid),
      el("td", { style: "font-size:12px;color:var(--text-dim)" }, b.reason || "—"),
      el("td", { style: "font-size:11px;color:var(--text-faint)" }, fmtDate(b.bannedAt)),
      el("td", {}, el("button", { class: "btn ok-btn",
        onclick: async () => {
          const r = await apiDel(`/bans/${b.uid}`);
          r.success ? (toast("تم رفع الحظر ✅", "ok"), await loadTab("bans")) : toast("فشل", "err");
        }
      }, "رفع الحظر")),
    ));
  }
  tbl.appendChild(tbody);
  card.appendChild(tbl);
  root.appendChild(card);
};

// ── AUDIT LOG ─────────────────────────────────────────────────────────────────
TABS.audit = async (root) => {
  root.innerHTML = "";
  let page = 0;
  const limit = 50;
  let allEntries = [];
  let loading = false;

  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "📋 سجل المراجعة"));

  const tbl = el("table", { class: "tbl" });
  tbl.appendChild(el("thead", {}, el("tr", {},
    el("th", {}, "الوقت"), el("th", {}, "الإجراء"), el("th", {}, "المستخدم"), el("th", {}, "التفاصيل")
  )));
  const tbody = el("tbody");
  tbl.appendChild(tbody);
  card.appendChild(tbl);

  const loadMore = el("div", { style: "text-align:center;margin-top:16px" },
    el("button", { class: "btn ghost",
      onclick: async () => {
        if (loading) return;
        loading = true;
        try {
          page++;
          const entries = await apiFetch(`/audit?offset=${page * limit}&limit=${limit}`);
          for (const e of entries) {
            allEntries.push(e);
            tbody.appendChild(el("tr", {},
              el("td", { style: "font-family:'JetBrains Mono',monospace;font-size:11px;white-space:nowrap" }, fmtDate(e.time)),
              el("td", {}, el("span", { class: `badge ${e.level === "warn" ? "warn" : e.level === "err" ? "err" : "blue"}` }, e.action || "action")),
              el("td", { style: "font-family:'JetBrains Mono',monospace;color:var(--cyan);font-size:11px" }, e.actor || "—"),
              el("td", { style: "font-size:12px;color:var(--text-dim)" }, e.detail || "—"),
            ));
          }
          if (entries.length < limit) loadMore.style.display = "none";
        } catch {} finally { loading = false; }
      }
    }, "تحميل المزيد…")
  );

  // Initial load
  try {
    const entries = await apiFetch(`/audit?offset=0&limit=${limit}`);
    for (const e of entries) {
      allEntries.push(e);
      tbody.appendChild(el("tr", {},
        el("td", { style: "font-family:'JetBrains Mono',monospace;font-size:11px;white-space:nowrap" }, fmtDate(e.time)),
        el("td", {}, el("span", { class: `badge ${e.level === "warn" ? "warn" : e.level === "err" ? "err" : "blue"}` }, e.action || "action")),
        el("td", { style: "font-family:'JetBrains Mono',monospace;color:var(--cyan);font-size:11px" }, e.actor || "—"),
        el("td", { style: "font-size:12px;color:var(--text-dim)" }, e.detail || "—"),
      ));
    }
    if (entries.length < limit) loadMore.style.display = "none";
  } catch {
    tbody.appendChild(el("tr", {}, el("td", { colspan: "4", style: "text-align:center;color:var(--text-faint);padding:24px" }, "لا يوجد سجل متاح")));
  }

  card.appendChild(loadMore);
  root.appendChild(card);

  // Live WS updates
  const unsub = subscribeWS(msg => {
    if (msg.type === "audit") {
      const e = msg.data;
      const row = el("tr", {},
        el("td", { style: "font-family:'JetBrains Mono',monospace;font-size:11px;white-space:nowrap" }, fmtDate(e.time)),
        el("td", {}, el("span", { class: `badge ${e.level === "warn" ? "warn" : e.level === "err" ? "err" : "blue"}` }, e.action || "action")),
        el("td", { style: "font-family:'JetBrains Mono',monospace;color:var(--cyan);font-size:11px" }, e.actor || "—"),
        el("td", { style: "font-size:12px;color:var(--text-dim)" }, e.detail || "—"),
      );
      tbody.insertBefore(row, tbody.firstChild);
    }
  });
  root._cleanup = unsub;
};

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  if (_token) {
    try { await apiFetch("/health"); showApp(); }
    catch { showLogin(); }
  } else {
    showLogin();
  }
}

boot();
