(function () {
"use strict";
const C = self.APP_CONFIG;
const AUTH_KEY = "yorugohan-auth";
const CACHE_KEY = "yorugohan-cache-v2";
const DRAFT_KEY = "yorugohan-draft-v2";

const DINNER = {
  "19":  { label: "19:00" },
  "20":  { label: "20:00" },
  "21":  { label: "21:00", sfx: "以降" },
  "out": { label: "大丈夫", sub: "外食" },
  "tbd": { label: "未定" },
};
const WD = "日月火水木金土";
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];

/* ---------- 端末への保存（失敗しても動くように） ---------- */
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};

/* ---------- 誰のスマホか ---------- */
function readAuth() {
  const q = new URLSearchParams(location.search);
  let a = null;
  if (q.get("me")) a = { role: "me", key: q.get("me") };
  else if (q.get("mom")) a = { role: "mom", key: q.get("mom") };
  if (a) { ls.set(AUTH_KEY, a); return a; }
  return ls.get(AUTH_KEY);
}
const AUTH = readAuth();
const ROLE = AUTH ? AUTH.role : null;

/* ---------- 日付・時刻 ---------- */
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => iso(new Date());
const toDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return iso(d); };
const wdOf = (s) => toDate(s).getDay();
const md = (s) => { const d = toDate(s); return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`; };
const ymd = (s) => { const d = toDate(s); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`; };
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const hm = (x) => { x = ((x % 1440) + 1440) % 1440; return `${Math.floor(x / 60)}:${pad(x % 60)}`; };
const hhmm = (x) => `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
const bOf = (t) => hm(toMin(t) + 20);
const floor10 = (x) => Math.floor(x / 10) * 10;
const clone = (o) => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- 状態 ---------- */
const EMPTY_SERVER = { days: {}, defaults: {}, momReady: true, schema: 2 };
const S = {
  server: null,     // 最後にサーバーから受け取った内容
  draft: null,      // 自分側の書きかけ
  loaded: false, error: "", sending: false, push: "idle",
  lastWake: "08:00",
  lastStart: null,  // 大学の開始時刻（前回入れた値）
  view: null,       // シート: {type:"day",date} / {type:"base"} / {type:"wd",wd}
};
function setServer(srv, keepDraft) {
  const oldServer = S.server, oldDraft = S.draft;
  S.server = srv;
  ls.set(CACHE_KEY, srv);
  if (ROLE !== "me") return;
  const draft = clone(srv);
  const saved = ls.get(DRAFT_KEY);
  const src = keepDraft && oldDraft ? { draft: oldDraft, base: oldServer } : saved && saved.draft ? saved : null;
  if (src) {
    for (const d of Object.keys(src.draft.days || {}).concat(Object.keys((src.base || {}).days || {}))) {
      if (!same(src.draft.days[d], (src.base || {}).days?.[d])) {
        if (src.draft.days[d]) draft.days[d] = clone(src.draft.days[d]); else delete draft.days[d];
      }
    }
    if (!same(src.draft.defaults, (src.base || {}).defaults)) draft.defaults = clone(src.draft.defaults || {});
  }
  S.draft = draft;
  saveDraft();
}
function saveDraft() { if (ROLE === "me") ls.set(DRAFT_KEY, { draft: S.draft, base: S.server }); }
const data = () => (ROLE === "me" ? S.draft : S.server) || EMPTY_SERVER;

/* その日の値：決めてあればそれ、なければ曜日の基本 */
function eff(date) {
  const D = data(), x = D.days[date] || {}, base = (D.defaults || {})[wdOf(date)] || {};
  return {
    dinner: x.dinner || base.dinner || "tbd",
    wake: x.wake || base.wake || { mode: "tbd" },
    dinnerBase: !x.dinner && !!base.dinner && base.dinner !== "tbd",
    wakeBase: !x.wake && !!base.wake && base.wake.mode !== "tbd",
  };
}
/* 編集の対象： "d:日付" か "w:曜日" */
function getT(t) {
  const [k, v] = t.split(":");
  if (k === "d") return eff(v);
  const b = (data().defaults || {})[v] || {};
  return { dinner: b.dinner || "tbd", wake: b.wake || { mode: "tbd" } };
}
function setT(t, field, value) {
  const [k, v] = t.split(":");
  const D = S.draft;
  const box = k === "d" ? (D.days[v] = D.days[v] || {}) : ((D.defaults = D.defaults || {})[v] = D.defaults[v] || {});
  if (value === undefined) delete box[field]; else box[field] = value;
  if (k === "d" && !Object.keys(box).length) delete D.days[v];
  if (k === "w" && !Object.keys(box).length) delete D.defaults[v];
  saveDraft(); render();
}
function changes() {
  const out = { dates: [], defaults: false };
  if (ROLE !== "me" || !S.draft || !S.server) return out;
  const t = todayIso();
  for (let i = 0; i <= 8; i++) { const d = addDays(t, i); if (!same(S.draft.days[d], S.server.days[d])) out.dates.push(d); }
  out.defaults = !same(S.draft.defaults, S.server.defaults);
  return out;
}

/* ---------- 大学に行く日：開始時刻から起床を計算 ----------
   東葛西1丁目 →(徒歩)→ 葛西 →(東西線)→ 飯田橋 →(徒歩)→ 法政 市ヶ谷 で固定 */
const COMMUTE_KEY = "yorugohan-commute";
const CM_DEF = { early: 10, campus: 15, home: 15, wake: 120 };
const CM_FIELDS = [
  ["early", "大学に着くのは開始の", "分前"],
  ["campus", "飯田橋 → 大学（徒歩）", "分"],
  ["home", "家 → 葛西（徒歩）", "分"],
  ["wake", "起床は葛西発の", "分前"],
];
const cmSet = () => Object.assign({}, CM_DEF, ls.get(COMMUTE_KEY) || {});
/* 祝日と年末年始（土休日ダイヤ） */
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29",
  "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23",
  "2026-10-12", "2026-11-03", "2026-11-23", "2026-12-30", "2026-12-31",
  "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-22", "2027-04-29",
  "2027-05-03", "2027-05-04", "2027-05-05", "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11",
  "2027-11-03", "2027-11-23", "2027-12-30", "2027-12-31",
]);
const isHolidayDia = (d) => [0, 6].includes(wdOf(d)) || HOLIDAYS.has(d);
function commute(start, hol) {
  const P = cmSet(), T = self.TOZAI;
  if (!T) return { error: "時刻表を読み込めませんでした。アプリを開き直してください" };
  const arrive = start - P.early, need = arrive - P.campus;
  const list = hol ? T.holiday : T.weekday;
  let tr = null;
  for (const x of list) if (x[1] <= need) tr = x; else break;
  if (!tr) return { error: "間に合う電車がありません（始発より前です）" };
  const w = Math.max(floor10(tr[0] - P.wake), 0);
  return { arrive, dep: tr[0], iida: tr[1], leave: tr[0] - P.home, w, b: w + 20 };
}
function commuteSheet(v) {
  const P = cmSet(), r = commute(toMin(v.start), v.hol);
  const seg = (h, l) => `<button class="${v.hol === h ? "on" : ""}" data-cmday="${h ? 1 : 0}">${l}</button>`;
  const line = (k, val, note = "") => `<div class="cm-line"><span>${k}</span><b class="num">${val}</b>${note ? `<small>${note}</small>` : ""}</div>`;
  const res = r.error ? `<div class="card"><p class="cm-err">${r.error}</p></div>`
    : `<div class="card cm-res">
        <div class="cm-wb"><div class="big">${hm(r.w)}<i>w</i></div><div class="big sub">${hm(r.b)}<i>b</i></div></div>
        <div class="cm-lines">
          ${line("家を出る", hm(r.leave))}
          ${line("葛西", hm(r.dep) + " 発", "東西線 中野方面")}
          ${line("飯田橋", hm(r.iida) + " 着")}
          ${line("大学に着く", hm(r.arrive) + " まで", `開始の${P.early}分前`)}
        </div></div>
      <button class="cm-apply" data-act="cmapply">${md(v.date)}の起床にする</button>`;
  const sets = CM_FIELDS.map(([k, l, u]) => `<label class="cm-set"><span>${l}</span>
      <input type="number" inputmode="numeric" min="0" max="300" value="${P[k]}" data-cmset="${k}"><span>${u}</span></label>`).join("");
  return `<div class="card"><p class="label"><span>授業の開始時刻</span><span class="d">${md(v.date)}</span></p>
      <input class="cm-time" type="time" step="300" value="${v.start}" data-cm="start">
      <div class="seg two" style="margin-top:12px">${seg(false, "平日ダイヤ")}${seg(true, "土休日ダイヤ")}</div></div>
    ${res}
    <details class="card cm-details"><summary>計算の設定</summary>${sets}
      <p class="cm-note">時刻表：${self.TOZAI ? self.TOZAI.updated : "—"} 時点の東京メトロ東西線（葛西→飯田橋）</p></details>`;
}
function openCommute(date, from) {
  S.view = { type: "commute", date, start: S.lastStart || ls.get("yorugohan-laststart") || "09:00", hol: isHolidayDia(date), from: from || null };
  render();
}

/* ---------- サーバー ---------- */
async function apiGet() {
  const r = await fetch(`${C.gasUrl}?a=state&k=${encodeURIComponent(AUTH.key)}`, { cache: "no-store" });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "読み込めませんでした");
  return j;
}
async function apiPost(body) {
  const r = await fetch(C.gasUrl, { method: "POST", body: JSON.stringify(Object.assign({}, body, { k: AUTH.key })) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "送れませんでした");
  return j;
}
let loading = false;
async function refresh(keepDraft) {
  if (loading) return; loading = true;
  try {
    const j = await apiGet();
    setServer({ days: j.days || {}, defaults: j.defaults || {}, momReady: j.momReady, schema: j.schema || 1 }, keepDraft);
    S.loaded = true; S.error = "";
  } catch (e) {
    S.error = e.message || "読み込めませんでした";
  }
  loading = false; render();
}
async function sendAll() {
  const ch = changes();
  if ((!ch.dates.length && !ch.defaults) || S.sending) return;
  const payload = { a: "send", v: 2, changes: {} };
  ch.dates.forEach((d) => (payload.changes[d] = S.draft.days[d] || {}));
  if (ch.defaults) payload.defaults = S.draft.defaults || {};
  S.sending = true; render();
  try {
    const res = await apiPost(payload);
    ls.set(DRAFT_KEY, null); S.draft = null;
    setServer({ days: res.days, defaults: res.defaults || {}, momReady: res.momReady, schema: 2 }, false);
    if (res.pushed) toast("お母さんに通知しました");
    else if (!res.momReady) toast("保存しました（お母さんのスマホで通知がまだオンになっていません）");
    else toast("保存しましたが、通知に失敗しました：" + res.error);
  } catch (e) {
    toast("送れませんでした：" + (e.message || "通信を確認してください"));
  }
  S.sending = false; render();
}

/* ---------- 通知（お母さん側） ---------- */
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushDone = () => { try { return localStorage.getItem("yorugohan-push") === "1"; } catch (e) { return false; } };
function swRegister() { return "serviceWorker" in navigator ? navigator.serviceWorker.register("./firebase-messaging-sw.js") : Promise.resolve(null); }
async function enablePush() {
  S.push = "working"; render();
  try {
    if (!("serviceWorker" in navigator) || !("Notification" in window)) throw new Error("このスマホのブラウザでは通知が使えません");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("通知が許可されませんでした。設定アプリ →「夜ご飯」→ 通知 から許可できます");
    const reg = await swRegister();
    await navigator.serviceWorker.ready;
    const B = "https://www.gstatic.com/firebasejs/10.12.2/";
    const [{ initializeApp }, M] = await Promise.all([import(B + "firebase-app.js"), import(B + "firebase-messaging.js")]);
    const token = await M.getToken(M.getMessaging(initializeApp(C.firebase)), { vapidKey: C.vapidKey, serviceWorkerRegistration: reg });
    if (!token) throw new Error("通知の登録に失敗しました");
    await apiPost({ a: "register", token });
    try { localStorage.setItem("yorugohan-push", "1"); } catch (e) {}
    toast("通知をオンにしました");
  } catch (e) {
    toast(e.message || "通知をオンにできませんでした");
  }
  S.push = "idle"; render();
}
function pushNotice() {
  if (pushDone() && "Notification" in window && Notification.permission === "granted") return "";
  if (isIOS && !standalone) return `<div class="card notice"><b>通知を受け取るには</b><span>共有ボタン →「ホーム画面に追加」→ ホーム画面の「夜ご飯」から開き直してください</span></div>`;
  return `<div class="card notice"><span>予定が変わったときに通知が届くようにします</span>
    <button data-act="push" ${S.push === "working" ? "disabled" : ""}>${S.push === "working" ? "設定中…" : "通知をオンにする"}</button></div>`;
}

/* ---------- 表示 ---------- */
let tt;
function toast(m) { const el = document.getElementById("toast"); el.textContent = m; el.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("show"), 3200); }

function dinnerBig(k) {
  if (!k || k === "tbd") return `<div class="big none">未定</div>`;
  const i = DINNER[k];
  return `<div class="big ${i.sub ? "mid" : ""}">${i.label}${i.sfx ? `<span class="sfx">${i.sfx}</span>` : ""}</div>${i.sub ? `<div class="s">${i.sub}</div>` : ""}`;
}
function wakeBig(w) {
  if (!w || w.mode === "tbd") return `<div class="big none">未定</div>`;
  if (w.mode === "free") return `<div class="big mid">無制限</div>`;
  return `<div class="big">${hm(toMin(w.t))}<i>w</i></div><div class="big sub">${bOf(w.t)}<i>b</i></div>`;
}
function todayCard() {
  const t = todayIso(), n = addDays(t, 1);
  return `<section class="card today">
    <img class="plush" src="img/plush.webp" alt="" width="62" height="78" decoding="async">
    <div class="half"><span class="k">今日の夜</span>${dinnerBig(eff(t).dinner)}</div>
    <div class="half"><span class="k">明日の朝 <b>${md(n)}</b></span>${wakeBig(eff(n).wake)}</div></section>`;
}
function dinnerPicker(t) {
  const cur = getT(t).dinner;
  const btn = (k, cls = "") => {
    const i = DINNER[k];
    return `<button class="opt ${cls} ${cur === k ? "on" : ""}" data-dinner="${k}" data-t="${t}"><b>${i.label}${i.sfx ? `<span class="sfx">${i.sfx}</span>` : ""}</b>${i.sub ? `<small>${i.sub}</small>` : ""}</button>`;
  };
  return `<div class="dinner">${btn("19")}${btn("20")}${btn("21")}${btn("out", "wide")}${btn("tbd", "wide tbd")}</div>`;
}
function wakePicker(t) {
  const w = getT(t).wake;
  const seg = (m, l) => `<button class="${w.mode === m ? "on" : ""}" data-wmode="${m}" data-t="${t}">${l}</button>`;
  let body = "";
  if (w.mode === "time") {
    const m = toMin(w.t), h = Math.floor(m / 60), mi5 = (m % 60) - ((m % 60) % 5);
    const col = (kind, n, step, sel) => {
      let rows = `<div class="padrow"></div><div class="padrow"></div>`;
      for (let v = 0; v < n; v += step) rows += `<div class="${v === sel ? "sel" : ""}">${kind === "h" ? v : pad(v)}</div>`;
      return rows + `<div class="padrow"></div><div class="padrow"></div>`;
    };
    body = `<div class="wheelwrap"><div class="wheels">
        <div class="wheel" data-wheel="h" data-t="${t}" data-sel="${h}" aria-label="時">${col("h", 24, 1, h)}</div>
        <span class="colon">:</span>
        <div class="wheel" data-wheel="m" data-t="${t}" data-sel="${mi5 / 5}" aria-label="分">${col("m", 60, 5, mi5)}</div>
        <span class="wlabel">w</span>
      </div><div class="b">${bOf(w.t)}b</div></div>`;
  }
  return `<div class="seg">${seg("time", "時間")}${seg("free", "無制限")}${seg("tbd", "未定")}</div>${body}`;
}
function wakeCell(w, isBase) {
  const tag = isBase && ROLE === "me" ? `<span class="tag">基本</span>` : "";
  if (w.mode === "time") return `<span class="c ${isBase ? "base" : ""}">${hm(toMin(w.t))}w${tag}<span class="w2">${bOf(w.t)}b</span></span>`;
  if (w.mode === "free") return `<span class="c ${isBase ? "base" : ""}">無制限${tag}</span>`;
  return `<span class="c m">未定</span>`;
}
function dinnerCell(k, isBase) {
  const tag = isBase && ROLE === "me" ? `<span class="tag">基本</span>` : "";
  if (!k || k === "tbd") return `<span class="c m">未定</span>`;
  const i = DINNER[k];
  return `<span class="c ${isBase ? "base" : ""}">${i.label}${i.sfx || ""}${i.sub ? `<small>${i.sub}</small>` : ""}${tag}</span>`;
}
function weekList() {
  const me = ROLE === "me", t = todayIso();
  const rows = [1, 2, 3, 4, 5, 6].map((i) => {
    const d = addDays(t, i), e = eff(d), tag = me ? "button" : "div";
    return `<${tag} class="row ${me ? "" : "static"}" ${me ? `data-edit="${d}"` : ""}>
      <span class="d">${md(d)}</span>${wakeCell(e.wake, e.wakeBase)}${dinnerCell(e.dinner, e.dinnerBase)}
      ${me ? `<span class="chev">›</span>` : ""}</${tag}>`;
  }).join("");
  return `<section class="card week ${me ? "" : "static"}">
    <div class="head"><span>先の予定</span><span>朝</span><span>夜</span>${me ? "<span></span>" : ""}</div>${rows}
    ${me ? `<button class="linkbtn" data-act="base">基本の予定を設定</button>` : ""}</section>`;
}
function sendBar() {
  const ch = changes(), n = ch.dates.length + (ch.defaults ? 1 : 0);
  const blocked = S.server && S.server.schema !== 2;
  const label = S.sending ? "送信中…" : blocked ? "Apps Scriptの更新が必要です" : n ? `お母さんに送信（${n}件）` : "送信済み";
  return `<div class="sendbar"><button data-act="send" ${n && !S.sending && !blocked ? "" : "disabled"}>${label}</button></div>`;
}
function renderMe() {
  const t = todayIso(), n = addDays(t, 1);
  return `<header class="top">${ymd(t)}</header>
    ${S.server && !S.server.momReady ? `<div class="card notice"><span>お母さんのスマホで、まだ通知がオンになっていません</span></div>` : ""}
    ${todayCard()}
    <section class="card"><p class="label"><span>夜ご飯</span><span class="d">今日 ${md(t)}</span></p>${dinnerPicker("d:" + t)}</section>
    <section class="card"><p class="label"><span>起床</span><span class="d">明日 ${md(n)}</span></p>${wakePicker("d:" + n)}
      <button class="linkbtn cm-open" data-act="commute" data-date="${n}">大学の開始時刻から計算</button></section>
    ${weekList()}${sendBar()}`;
}
function renderMom() {
  return `<header class="top">${ymd(todayIso())}</header>${pushNotice()}${todayCard()}${weekList()}`;
}
function renderSheet() {
  const v = S.view;
  if (!v) return "";
  let head = "", body = "";
  if (v.type === "day") {
    const x = S.draft.days[v.date];
    head = `<h2>${ymd(v.date)}</h2>`;
    body = `<div class="card"><p class="label"><span>朝（起床）</span></p>${wakePicker("d:" + v.date)}
        <button class="linkbtn cm-open" data-act="commute" data-date="${v.date}" data-from="day">大学の開始時刻から計算</button></div>
      <div class="card"><p class="label"><span>夜ご飯</span></p>${dinnerPicker("d:" + v.date)}</div>
      ${x ? `<button class="ghost" data-act="reset" data-date="${v.date}">この日を基本の予定に戻す</button>` : ""}`;
  } else if (v.type === "commute") {
    head = v.from === "day" ? `<button class="back" data-act="cmback">‹ ${md(v.date)}</button>` : `<h2>大学に行く日</h2>`;
    body = commuteSheet(v);
  } else if (v.type === "base") {
    head = `<h2>基本の予定</h2>`;
    const rows = WD_ORDER.map((wd) => {
      const b = getT("w:" + wd);
      return `<button class="row" data-wd="${wd}"><span class="d">${WD[wd]}曜日</span>${wakeCell(b.wake, false)}${dinnerCell(b.dinner, false)}<span class="chev">›</span></button>`;
    }).join("");
    body = `<section class="card week"><div class="head"><span>曜日</span><span>朝</span><span>夜</span><span></span></div>${rows}</section>`;
  } else {
    head = `<button class="back" data-act="base">‹ 基本の予定</button>`;
    body = `<p class="label" style="margin:0"><span>${WD[v.wd]}曜日の基本</span></p>
      <div class="card"><p class="label"><span>朝（起床）</span></p>${wakePicker("w:" + v.wd)}</div>
      <div class="card"><p class="label"><span>夜ご飯</span></p>${dinnerPicker("w:" + v.wd)}</div>`;
  }
  return `<div class="shade" data-act="close"></div>
  <section class="sheet" role="dialog"><div class="sheet-in">
    <div class="grab"></div>
    <div class="sheet-head">${head}<button class="done" data-act="close">完了</button></div>
    ${body}</div></section>`;
}
function render() {
  const app = document.getElementById("app");
  document.body.classList.toggle("has-send", ROLE === "me" && S.loaded);
  if (!ROLE) { app.innerHTML = `<p class="center">URLが正しくありません。<br>送られてきたURLから開き直してください。</p>`; return; }
  if (!S.loaded) { app.innerHTML = `<p class="center">${S.error ? `読み込めませんでした<br>${esc(S.error)}` : "読み込み中…"}</p>`; return; }
  const oldSheet = app.querySelector(".sheet"), sheetTop = oldSheet ? oldSheet.scrollTop : 0;
  app.innerHTML = (ROLE === "me" ? renderMe() : renderMom()) + renderSheet();
  const sh = app.querySelector(".sheet"); if (sh) sh.scrollTop = sheetTop;
  const wheels = app.querySelectorAll("[data-wheel]");
  if (wheels.length) requestAnimationFrame(() => wheels.forEach((el) => { el.scrollTop = Number(el.dataset.sel) * 40; bindWheel(el); }));
}

/* ホイール：指で回したときだけ値を変える（表示のたびに勝手に0:00になるのを防ぐ） */
function bindWheel(el) {
  let timer, user = false;
  const mark = () => { user = true; };
  el.addEventListener("touchstart", mark, { passive: true });
  el.addEventListener("pointerdown", mark);
  el.addEventListener("wheel", mark, { passive: true });
  el.addEventListener("scroll", () => {
    const i = Math.round(el.scrollTop / 40);
    el.querySelectorAll("div:not(.padrow)").forEach((r, k) => r.classList.toggle("sel", k === i));
    if (!user) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const t = el.dataset.t, w = getT(t).wake;
      if (w.mode !== "time") return;
      const m = toMin(w.t);
      let h = Math.floor(m / 60), mi = m % 60;
      const idx = Math.round(el.scrollTop / 40);
      if (el.dataset.wheel === "h") h = Math.min(Math.max(idx, 0), 23); else mi = Math.min(Math.max(idx, 0), 11) * 5;
      if (h * 60 + mi !== m) setWake(t, h * 60 + mi);
    }, 160);
  }, { passive: true });
}
function setWake(t, m) {
  m = Math.min(Math.max(m, 0), 23 * 60 + 55);
  S.lastWake = hhmm(m);
  setT(t, "wake", { mode: "time", t: S.lastWake });
}

/* ---------- 操作 ---------- */
document.addEventListener("click", (e) => {
  const r = e.target.closest(".wheel > div:not(.padrow)");
  if (r && ROLE === "me") {
    const wh = r.parentElement, i = Array.from(wh.querySelectorAll("div:not(.padrow)")).indexOf(r);
    wh.dispatchEvent(new Event("pointerdown"));
    wh.scrollTo({ top: i * 40, behavior: "smooth" });
    return;
  }
  const b = e.target.closest("[data-dinner],[data-wmode],[data-edit],[data-act],[data-wd],[data-cmday]");
  if (!b) return;
  if (b.dataset.act === "push") { enablePush(); return; }
  if (ROLE !== "me") return;
  if (b.dataset.dinner) { setT(b.dataset.t, "dinner", b.dataset.dinner); return; }
  if (b.dataset.wmode) {
    const t = b.dataset.t, w = getT(t).wake;
    setT(t, "wake", b.dataset.wmode === "time" ? { mode: "time", t: w.t || S.lastWake } : { mode: b.dataset.wmode });
    return;
  }
  if (b.dataset.edit) { S.view = { type: "day", date: b.dataset.edit }; render(); return; }
  if (b.dataset.wd) { S.view = { type: "wd", wd: Number(b.dataset.wd) }; render(); return; }
  if (b.dataset.cmday) { S.view.hol = b.dataset.cmday === "1"; render(); return; }
  switch (b.dataset.act) {
    case "close": S.view = null; render(); break;
    case "base": S.view = { type: "base" }; render(); break;
    case "send": sendAll(); break;
    case "reset": delete S.draft.days[b.dataset.date]; saveDraft(); render(); break;
    case "commute": openCommute(b.dataset.date, b.dataset.from); break;
    case "cmback": S.view = { type: "day", date: S.view.date }; render(); break;
    case "cmapply": {
      const v = S.view, r = commute(toMin(v.start), v.hol);
      if (r.error) break;
      S.lastWake = hhmm(r.w);
      S.view = v.from === "day" ? { type: "day", date: v.date } : null;
      setT("d:" + v.date, "wake", { mode: "time", t: S.lastWake });
      toast(`${md(v.date)}を ${hm(r.w)}w／${hm(r.b)}b にしました`);
      break;
    }
  }
});
/* 大学の開始時刻・計算の設定 */
document.addEventListener("change", (e) => {
  const el = e.target;
  if (ROLE !== "me" || !S.view || S.view.type !== "commute") return;
  if (el.dataset.cm === "start" && /^\d{2}:\d{2}$/.test(el.value)) {
    S.view.start = el.value; S.lastStart = el.value; ls.set("yorugohan-laststart", el.value); render();
  } else if (el.dataset.cmset) {
    const n = Math.round(Number(el.value));
    const P = Object.assign({}, ls.get(COMMUTE_KEY) || {});
    if (el.value === "" || !isFinite(n) || n < 0) delete P[el.dataset.cmset]; else P[el.dataset.cmset] = Math.min(n, 300);
    ls.set(COMMUTE_KEY, P);
    const open = !!document.querySelector(".cm-details[open]");
    render();
    if (open) { const d = document.querySelector(".cm-details"); if (d) d.open = true; }
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.view) { S.view = null; render(); } });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ROLE && !S.sending) { render(); refresh(true); }
});

/* ---------- 起動：前回の内容をすぐ表示して、裏で最新を取りに行く ---------- */
if (ROLE) {
  const cached = ls.get(CACHE_KEY);
  if (cached && cached.days) { setServer(cached, false); S.loaded = true; }
  render();
  refresh(true);
  if ("requestIdleCallback" in window) requestIdleCallback(() => swRegister().catch(() => {}));
  else setTimeout(() => swRegister().catch(() => {}), 1500);
} else {
  render();
}
})();
