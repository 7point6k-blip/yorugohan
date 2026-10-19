const C = self.APP_CONFIG;
const STORE = "yorugohan-auth";

/* ---- 誰のスマホか（URLの ?me= / ?mom= で判定し、この端末に覚える） ---- */
function readAuth() {
  const q = new URLSearchParams(location.search);
  let a = null;
  if (q.get("me")) a = { role: "me", key: q.get("me") };
  else if (q.get("mom")) a = { role: "mom", key: q.get("mom") };
  if (a) { try { localStorage.setItem(STORE, JSON.stringify(a)); } catch (e) {} return a; }
  try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { return null; }
}
const AUTH = readAuth();
const BOOT = { role: AUTH ? AUTH.role : null, key: AUTH ? AUTH.key : "", days: {}, momReady: true };

/* ---- サーバー（Google Apps Script）との通信 ---- */
async function apiGet() {
  const r = await fetch(`${C.gasUrl}?a=state&k=${encodeURIComponent(BOOT.key)}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "読み込めませんでした");
  return j;
}
async function apiPost(body) {
  // Content-Type を付けない（text/plain）ことで、Apps Script にそのまま届く
  const r = await fetch(C.gasUrl, { method: "POST", body: JSON.stringify({ ...body, k: BOOT.key }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "送れませんでした");
  return j;
}


const DINNER = {
  "19":  { label: "19:00" },
  "20":  { label: "20:00" },
  "21":  { label: "21:00", sfx: "以降" },
  "out": { label: "大丈夫", sub: "外食" },
  "tbd": { label: "未定" },
};
const ROLE = BOOT.role;
const DRAFT_KEY = "yorugohan-draft";

/* ---- 日付 ---- */
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => iso(new Date());
function addDays(s, n) { const [y, m, d] = s.split("-").map(Number); return iso(new Date(y, m - 1, d + n)); }
function ymd(s) { const [y, m, d] = s.split("-").map(Number); return `${y}/${m}/${d}（${"日月火水木金土"[new Date(y, m - 1, d).getDay()]}）`; }
function md(s) { const [y, m, d] = s.split("-").map(Number); return `${m}/${d}（${"日月火水木金土"[new Date(y, m - 1, d).getDay()]}）`; }

/* ---- 時刻 ---- */
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const hm = (x) => { x = ((x % 1440) + 1440) % 1440; return `${Math.floor(x / 60)}:${pad(x % 60)}`; };
const hhmm = (x) => `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
const breakfast = (t) => hm(toMin(t) + 20);

/* ---- データ ---- */
const EMPTY = { dinner: "tbd", wake: { mode: "tbd" } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const S = { sent: {}, days: {}, momReady: true, sending: false, lastWake: "08:00", loaded: false, error: "", push: "idle" };
// 送信前に閉じても、この端末では下書きが残る
function applyServer(j, keepDraft) {
  S.sent = j.days || {}; S.momReady = j.momReady;
  const draft = keepDraft ? changedDates().reduce((o, d) => ((o[d] = S.days[d]), o), {}) : {};
  S.days = clone(S.sent);
  if (ROLE === "me") {
    try { const dr = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); if (dr && dr.days && !keepDraft) Object.assign(S.days, dr.days); } catch (e) {}
    Object.assign(S.days, draft);
  }
}
async function load(keepDraft) {
  try { applyServer(await apiGet(), keepDraft); S.loaded = true; S.error = ""; }
  catch (e) { S.error = e.message || "読み込めませんでした"; }
  render();
}
function saveDraft() {
  if (ROLE !== "me") return;
  try {
    const ch = {}; changedDates().forEach((d) => (ch[d] = S.days[d]));
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ days: ch }));
  } catch (e) {}
}
const day = (d) => (ROLE === "mom" ? S.sent[d] : S.days[d]) || EMPTY;
const norm = (x) => { x = x || EMPTY; const w = x.wake || {}; return JSON.stringify([x.dinner || "tbd", w.mode || "tbd", w.mode === "time" ? w.t : null]); };
function changedDates() {
  const t = todayIso(), out = [];
  for (let i = 0; i <= 6; i++) { const d = addDays(t, i); if (norm(S.days[d]) !== norm(S.sent[d])) out.push(d); }
  return out;
}

let editing = null;
function patch(d, p) {
  S.days[d] = { ...day(d), ...p };
  saveDraft(); render();
}
async function sendAll() {
  const ch = changedDates();
  if (!ch.length || S.sending) return;
  const changes = {}; ch.forEach((d) => (changes[d] = S.days[d] || EMPTY));
  S.sending = true; render();
  try {
    const res = await apiPost({ a: "send", changes });
    S.sent = res.days; S.momReady = res.momReady;
    ch.forEach((d) => { S.days[d] = clone(res.days[d] || EMPTY); });
    saveDraft();
    if (res.pushed) toast("お母さんに通知しました");
    else if (!res.momReady) toast("保存しました（お母さんのスマホで通知がまだオンになっていません）");
    else toast("保存しましたが、通知に失敗しました：" + res.error);
  } catch (e) {
    toast("送れませんでした：" + (e.message || "通信を確認してください"));
  }
  S.sending = false; render();
}

/* ---- お母さん側：通知をオンにする ---- */
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushRegistered = () => { try { return localStorage.getItem("yorugohan-push") === "1"; } catch (e) { return false; } };
async function enablePush() {
  S.push = "working"; render();
  try {
    if (!("serviceWorker" in navigator) || !("Notification" in window)) throw new Error("このスマホのブラウザでは通知が使えません");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("通知が許可されませんでした。設定アプリ →「夜ご飯」→ 通知 から許可できます");
    const reg = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
    await navigator.serviceWorker.ready;
    const B = "https://www.gstatic.com/firebasejs/10.12.2/";
    const [{ initializeApp }, M] = await Promise.all([import(B + "firebase-app.js"), import(B + "firebase-messaging.js")]);
    const messaging = M.getMessaging(initializeApp(C.firebase));
    const token = await M.getToken(messaging, { vapidKey: C.vapidKey, serviceWorkerRegistration: reg });
    if (!token) throw new Error("通知の登録に失敗しました");
    await apiPost({ a: "register", token });
    try { localStorage.setItem("yorugohan-push", "1"); } catch (e) {}
    S.push = "idle"; toast("通知をオンにしました");
  } catch (e) {
    S.push = "idle"; toast(e.message || "通知をオンにできませんでした");
  }
  render();
}
function pushNotice() {
  if (pushRegistered() && "Notification" in window && Notification.permission === "granted") return "";
  if (isIOS && !standalone) {
    return `<div class="card notice"><b>通知を受け取るには</b><span>下の共有ボタン →「ホーム画面に追加」→ ホーム画面の「夜ご飯」から開き直してください</span></div>`;
  }
  return `<div class="card notice"><span>予定が変わったときに通知が届くようにします</span>
    <button data-act="push" ${S.push === "working" ? "disabled" : ""}>${S.push === "working" ? "設定中…" : "通知をオンにする"}</button></div>`;
}

/* ---- 表示部品 ---- */
let tt;
function toast(m) { const el = document.getElementById("toast"); el.textContent = m; el.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("show"), 3200); }

function dinnerBig(x) {
  if (!x.dinner || x.dinner === "tbd") return `<div class="big none">未定</div>`;
  const i = DINNER[x.dinner];
  return `<div class="big ${i.sub ? "mid" : ""}">${i.label}${i.sfx ? `<span class="sfx">${i.sfx}</span>` : ""}</div>${i.sub ? `<div class="s">${i.sub}</div>` : ""}`;
}
function wakeBig(w) {
  if (!w || w.mode === "tbd") return `<div class="big none">未定</div>`;
  if (w.mode === "free") return `<div class="big mid">無制限</div>`;
  return `<div class="big">${hm(toMin(w.t))}<i>w</i></div><div class="big sub">${breakfast(w.t)}<i>b</i></div>`;
}
function todayCard() {
  const x = day(todayIso());
  return `<section class="card today">
    <div class="half"><span class="k">今日の夜</span>${dinnerBig(x)}</div>
    <div class="half"><span class="k">明日の朝</span>${wakeBig(x.wake)}</div></section>`;
}
function dinnerPicker(d) {
  const cur = day(d).dinner || "tbd";
  const btn = (k, cls = "") => {
    const i = DINNER[k];
    return `<button class="opt ${cls} ${cur === k ? "on" : ""}" data-dinner="${k}" data-date="${d}"><b>${i.label}${i.sfx ? `<span class="sfx">${i.sfx}</span>` : ""}</b>${i.sub ? `<small>${i.sub}</small>` : ""}</button>`;
  };
  return `<div class="dinner">${btn("19")}${btn("20")}${btn("21")}${btn("out", "wide")}${btn("tbd", "wide tbd")}</div>`;
}
function wakePicker(d) {
  const w = day(d).wake || { mode: "tbd" };
  const seg = (m, l) => `<button class="${w.mode === m ? "on" : ""}" data-wmode="${m}" data-date="${d}">${l}</button>`;
  let body = "";
  if (w.mode === "time") {
    const m = toMin(w.t), h = Math.floor(m / 60), mi = m % 60, mi5 = mi - (mi % 5);
    const col = (kind, n, step, sel) => {
      let rows = `<div class="padrow"></div><div class="padrow"></div>`;
      for (let v = 0; v < n; v += step) rows += `<div class="${v === sel ? "sel" : ""}">${kind === "h" ? v : pad(v)}</div>`;
      return rows + `<div class="padrow"></div><div class="padrow"></div>`;
    };
    body = `<div class="wheelwrap">
      <div class="wheels">
        <div class="wheel" data-wheel="h" data-date="${d}" data-sel="${h}" aria-label="時">${col("h", 24, 1, h)}</div>
        <span class="colon">:</span>
        <div class="wheel" data-wheel="m" data-date="${d}" data-sel="${mi5 / 5}" aria-label="分">${col("m", 60, 5, mi5)}</div>
        <span class="wlabel">w</span>
      </div>
      <div class="b">${breakfast(w.t)}b</div></div>`;
  }
  return `<div class="seg">${seg("time", "時間")}${seg("free", "無制限")}${seg("tbd", "未定")}</div>${body}`;
}
function weekList(editable) {
  const t = todayIso();
  const rows = [1, 2, 3, 4, 5, 6].map((i) => {
    const d = addDays(t, i), x = day(d), w = x.wake || {};
    const di = DINNER[x.dinner || "tbd"];
    const dn = x.dinner && x.dinner !== "tbd" ? `${di.label}${di.sfx || ""}${di.sub ? `<small>${di.sub}</small>` : ""}` : "未定";
    const wk = w.mode === "time" ? `${hm(toMin(w.t))}w<br>${breakfast(w.t)}b` : w.mode === "free" ? "無制限" : "未定";
    const tag = editable ? "button" : "div";
    return `<${tag} class="row ${editable ? "" : "static"}" ${editable ? `data-edit="${d}"` : ""}>
      <span class="d">${md(d)}</span>
      <span class="c ${x.dinner && x.dinner !== "tbd" ? "" : "m"}">${dn}</span>
      <span class="c ${w.mode && w.mode !== "tbd" ? "" : "m"}">${wk}</span>
      ${editable ? `<span class="chev">›</span>` : ""}</${tag}>`;
  }).join("");
  return `<section class="card week"><p class="label">先の予定</p>${rows}</section>`;
}
function sendBar() {
  const n = changedDates().length;
  const label = S.sending ? "送信中…" : n ? `お母さんに送信（${n}日分）` : "送信済み";
  return `<div class="sendbar"><button data-act="send" ${n && !S.sending ? "" : "disabled"}>${label}</button></div>`;
}
function renderMe() {
  const t = todayIso();
  return `<header class="top">${ymd(t)}</header>
    ${S.momReady ? "" : `<div class="card notice"><span>お母さんのスマホで、まだ通知がオンになっていません</span></div>`}
    ${todayCard()}
    <section class="card"><p class="label">夜ご飯</p>${dinnerPicker(t)}</section>
    <section class="card"><p class="label">明日の起床</p>${wakePicker(t)}</section>
    ${weekList(true)}${sendBar()}`;
}
function renderMom() {
  return `<header class="top">${ymd(todayIso())}</header>${pushNotice()}${todayCard()}${weekList(false)}`;
}
function renderSheet() {
  if (!editing) return "";
  return `<div class="shade" data-act="close"></div>
  <section class="sheet" role="dialog" aria-label="${ymd(editing)}"><div class="sheet-in">
    <div class="grab"></div>
    <div class="sheet-head"><h2>${ymd(editing)}</h2><button class="done" data-act="close">完了</button></div>
    <div class="card"><p class="label">夜ご飯</p>${dinnerPicker(editing)}</div>
    <div class="card"><p class="label">翌朝の起床</p>${wakePicker(editing)}</div>
  </div></section>`;
}
function render() {
  const app = document.getElementById("app");
  document.body.classList.toggle("has-send", ROLE === "me");
  if (!ROLE) { app.innerHTML = `<p class="center">URLが正しくありません。<br>送られてきたURLから開き直してください。</p>`; return; }
  if (!S.loaded) { app.innerHTML = `<p class="center">${S.error ? `読み込めませんでした<br>${S.error}` : "読み込み中…"}</p>`; return; }
  app.innerHTML = (ROLE === "me" ? renderMe() : renderMom()) + renderSheet();
  app.querySelectorAll("[data-wheel]").forEach((el) => { el.scrollTop = Number(el.dataset.sel) * 40; bindWheel(el); });
}
function bindWheel(el) {
  let timer;
  const settle = () => {
    const i = Math.round(el.scrollTop / 40);
    const d = el.dataset.date, w = day(d).wake, m = toMin(w.t);
    let h = Math.floor(m / 60), mi = m % 60;
    if (el.dataset.wheel === "h") h = Math.min(Math.max(i, 0), 23); else mi = Math.min(Math.max(i, 0), 11) * 5;
    const next = h * 60 + mi;
    if (next !== m) setWake(d, next);
  };
  el.addEventListener("scroll", () => {
    clearTimeout(timer);
    const i = Math.round(el.scrollTop / 40);
    el.querySelectorAll("div:not(.padrow)").forEach((r, k) => r.classList.toggle("sel", k === i));
    timer = setTimeout(settle, 160);
  }, { passive: true });
}

/* ---- 操作 ---- */
function setWake(d, m) {
  m = Math.min(Math.max(m, 0), 23 * 60 + 55);
  S.lastWake = hhmm(m);
  patch(d, { wake: { mode: "time", t: S.lastWake } });
}
document.addEventListener("click", (e) => {
  const r = e.target.closest(".wheel > div:not(.padrow)");
  if (r) {
    const wh = r.parentElement, i = [...wh.querySelectorAll("div:not(.padrow)")].indexOf(r);
    wh.scrollTo({ top: i * 40, behavior: "smooth" });
    return;
  }
  const b = e.target.closest("[data-dinner],[data-wmode],[data-edit],[data-act]");
  if (!b) return;
  if (b.dataset.act === "push") { enablePush(); return; }
  if (ROLE !== "me") return;
  const d = b.dataset.date;
  if (b.dataset.dinner) { patch(d, { dinner: b.dataset.dinner }); return; }
  if (b.dataset.wmode) {
    const w = day(d).wake || {};
    patch(d, { wake: b.dataset.wmode === "time" ? { mode: "time", t: w.t || S.lastWake } : { mode: b.dataset.wmode, t: w.t } });
    return;
  }
  if (b.dataset.edit) { editing = b.dataset.edit; render(); return; }
  if (b.dataset.act === "close") { editing = null; render(); }
  if (b.dataset.act === "send") sendAll();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && editing) { editing = null; render(); } });

render();
if (ROLE) load(false);
// 開き直したときに最新にする（自分側は書きかけを残す）
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && ROLE && !S.sending) load(true); });
