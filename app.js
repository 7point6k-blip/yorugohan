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
  tab: "plan",
  calc: null,       // 大学タブの計算（到着時刻・時限・電車のずらし）
  pick: null,       // 大学タブで起床を入れる日      // 自分側のタブ： "plan"（いつもの予定）/ "uni"（大学）
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
function eff(date, D) {
  D = D || data();
  const x = D.days[date] || {}, base = (D.defaults || {})[wdOf(date)] || {};
  return {
    dinner: x.dinner || base.dinner || "tbd",
    wake: x.wake || base.wake || { mode: "tbd" },
    dinnerBase: !x.dinner && !!base.dinner && base.dinner !== "tbd",
    wakeBase: !x.wake && !!base.wake && base.wake.mode !== "tbd",
  };
}
/* 送信済み（お母さんに見えている内容）と比べて、まだ送っていない変更があるか */
function diff(date) {
  if (ROLE !== "me" || !S.draft || !S.server) return { dinner: false, wake: false };
  const a = eff(date, S.server), b = eff(date, S.draft);
  return { dinner: !same(a.dinner, b.dinner), wake: !same(a.wake, b.wake), was: a };
}
function baseDiff(wd) {
  if (ROLE !== "me" || !S.draft || !S.server) return false;
  return !same((S.draft.defaults || {})[wd], (S.server.defaults || {})[wd]);
}
const wakeText = (w) => (!w ? "未定" : w.mode === "time" ? `${hm(toMin(w.t))}w` : w.mode === "free" ? "無制限" : "未定");
const dinnerText = (k) => (!k || k === "tbd" ? "未定" : DINNER[k].label + (DINNER[k].sfx || "") + (DINNER[k].sub ? `（${DINNER[k].sub}）` : ""));
const wasTag = (txt) => `<span class="was">送信済み ${txt}</span>`;
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

/* ---------- 大学タブ：到着時刻から起床を計算 ----------
   東葛西1丁目 →(徒歩)→ 葛西 →(東西線)→ 飯田橋 →(徒歩)→ 法政 市ヶ谷 で固定。
   大学の予定・時限の設定は自分のスマホだけに保存し、起床だけをいつもの予定に書き込む */
const PERIOD_KEY = "yorugohan-periods2", LAST_T_KEY = "yorugohan-laststart";
const CM = { early: 10, campus: 20, home: 15, wake: 120 }; // 到着の10分前に大学、飯田橋→大学20分、家→葛西15分、起床は葛西発の2時間前
/* 時限など（開始時刻、起床を決めておく場合はその時刻。null は時刻表から計算） */
const PERIOD_DEF = [
  { k: "1", name: "1限", s: "08:50", w: "06:00" },
  { k: "2", name: "2限", s: "10:40", w: "07:50" },
  { k: "3", name: "3限", s: "13:10", w: null },
  { k: "4", name: "4限", s: "15:00", w: null },
  { k: "c", name: "委員会", s: "17:00", w: "14:00" },
];
function periods() {
  const sv = ls.get(PERIOD_KEY) || {};
  return PERIOD_DEF.map((d) => ({ k: d.k, name: d.name, s: (sv[d.k] && sv[d.k].s) || d.s, w: sv[d.k] && "w" in sv[d.k] ? sv[d.k].w : d.w }));
}
const periodOf = (k) => periods().find((p) => p.k === String(k)) || null;
function savePeriod(k, patch) { const sv = ls.get(PERIOD_KEY) || {}; sv[k] = Object.assign({}, sv[k] || {}, patch); ls.set(PERIOD_KEY, sv); }
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
/* その日の大学の予定 u = {t:"HH:MM", p:時限キー（時限を選んだ時だけ）, shift:ぴったりの電車から何本ずらすか} */
function plan(date, u) {
  const T = self.TOZAI;
  if (!T) return { error: "時刻表を読み込めませんでした。アプリを開き直してください" };
  const per = u.p ? periodOf(u.p) : null;
  const at = toMin(per ? per.s : u.t), arrive = at - CM.early, need = arrive - CM.campus;
  const list = isHolidayDia(date) ? T.holiday : T.weekday;
  let base = -1;
  list.forEach((x, k) => { if (x[1] <= need) base = k; });
  if (base < 0) return { error: "間に合う電車がありません" };
  const idx = Math.min(Math.max(base + (u.shift || 0), 0), list.length - 1), tr = list[idx];
  const fixed = !!(per && per.w && !u.shift);
  const w = fixed ? toMin(per.w) : Math.max(floor10(tr[0] - CM.wake), 0);
  return { at, idx, last: list.length - 1, dep: tr[0], iida: tr[1], leave: tr[0] - CM.home, late: tr[1] > need, w, b: w + 20, per };
}
/* 大学タブは「何時着なら何時起き？」を確かめるための計算。下で選んだ日にだけ起床を入れる */
const calc = () => S.calc || (S.calc = { t: ls.get(LAST_T_KEY) || "13:00", p: null, shift: 0, set: false });
/* 平日ダイヤで見せる（土休日に入れる時はその日のダイヤで計算し直す） */
const calcDate = () => { let d = addDays(todayIso(), 1); while (isHolidayDia(d)) d = addDays(d, 1); return d; };
function applyCalc() {
  const c = calc(), days = [...(S.pick || [])].sort();
  if (!days.length) return;
  const out = [];
  for (const d of days) {
    const r = plan(d, c);
    if (r.error) continue;
    S.draft.days[d] = S.draft.days[d] || {};
    S.draft.days[d].wake = { mode: "time", t: hhmm(r.w) };
    out.push(`${md(d).replace(/（.）/, "")} ${hm(r.w)}w`);
  }
  S.pick = new Set(); saveDraft(); render();
  toast(out.length ? `${out.join("、")} にしました（まだ送っていません）` : "入れられませんでした");
}
function renderUni() {
  const t = todayIso(), c = calc(), cd = calcDate();
  const pb = periods().map((p) => `<button class="opt ${c.set && c.p === p.k ? "on" : ""}" data-up="${p.k}"><b>${p.name}</b><small>${hm(toMin(p.s))}</small></button>`).join("");
  let res = `<p class="cm-note" style="margin:0 4px">到着時刻を回すか、上から選ぶと起床が出ます</p>`;
  if (c.set) {
    const r = plan(cd, c);
    if (r.error) res = `<div class="card"><p class="cm-err">${r.error}</p></div>`;
    else {
      const pick = S.pick || new Set();
      const chips = [1, 2, 3, 4, 5, 6, 7].map((i) => {
        const d = addDays(t, i), cur = eff(d).wake;
        return `<button class="chip ${pick.has(d) ? "on" : ""}" data-pick="${d}"><b>${i === 1 ? "明日" : WD[wdOf(d)]}</b><span class="num">${md(d).replace(/（.）/, "")}</span><small class="num">今 ${wakeText(cur)}</small></button>`;
      }).join("");
      res = `<section class="card cm-res">
        <div class="cm-wb"><div class="big">${hm(r.w)}<i>w</i></div><div class="big sub">${hm(r.b)}<i>b</i></div></div>
        <div class="trnav">
          <button data-act="trprev" ${r.idx <= 0 ? "disabled" : ""} aria-label="1本前">‹</button>
          <div class="trinfo">
            <div class="trbig"><div><small>家を出る</small><b class="num">${hm(r.leave)}</b></div>
              <div><small>法政に着く</small><b class="num ${r.late ? "late" : ""}">${hm(r.iida + CM.campus)}</b></div></div>
            <span class="num">葛西 ${hm(r.dep)}発 → 飯田橋 ${hm(r.iida)}着${r.late ? `<em>遅刻</em>` : ""}</span></div>
          <button data-act="trnext" ${r.idx >= r.last ? "disabled" : ""} aria-label="1本後">›</button>
        </div></section>
      <section class="card"><p class="label"><span>この起床を予定に入れる</span><span>入れたい日を選ぶ</span></p>
        <div class="chips">${chips}</div>
        <button class="cm-apply" data-act="apply" ${pick.size ? "" : "disabled"}>${pick.size ? `選んだ${pick.size}日を ${hm(r.w)}w にする` : "日を選ぶと入れられます"}</button></section>`;
    }
  }
  return `<section class="card">
      <div class="pgrid">${pb}</div>
      <p class="label" style="margin:16px 0 0"><span>到着時刻</span><span>平日ダイヤ</span></p>
      ${timeWheels("u:calc", toMin(c.t), "着")}</section>
    ${res}
    <button class="linkbtn" data-act="periods">時限の時刻を変える</button>`;
}
function periodsSheet() {
  const rows = periods().map((p) => `<button class="row" data-per="${p.k}"><span class="d">${p.name}</span>
      <span class="c">${hm(toMin(p.s))}<small>開始</small></span><span class="c ${p.w ? "" : "m"}">${p.w ? hm(toMin(p.w)) + "w" : "時刻表から"}</span><span class="chev">›</span></button>`).join("");
  return `<section class="card week"><div class="head"><span></span><span>開始</span><span>起床</span><span></span></div>${rows}</section>`;
}
function periodSheet(k) {
  const p = periodOf(k);
  const seg = (on, v, l) => `<button class="${on ? "on" : ""}" data-pwmode="${v}">${l}</button>`;
  return `<div class="card"><p class="label"><span>${p.name}の開始時刻</span></p>${timeWheels("ps:" + k, toMin(p.s), "")}</div>
    <div class="card"><p class="label"><span>起床</span></p>
      <div class="seg two">${seg(!p.w, "auto", "時刻表から")}${seg(!!p.w, "fix", "時刻を決める")}</div>
      ${p.w ? `${timeWheels("pw:" + k, toMin(p.w), "w")}<div class="wheelwrap" style="margin-top:0"><div class="b">${bOf(p.w)}b</div></div>` : ""}</div>`;
}
/* ホイールの値の読み書き（t: "d:日付"/"w:曜日" は起床、"u:日付" は到着時刻、"ps:時限"/"pw:時限" は時限の設定） */
function wheelGet(t) {
  const [k, v] = t.split(":");
  if (k === "u") return toMin(calc().t);
  if (k === "ps") return toMin(periodOf(v).s);
  if (k === "pw") { const p = periodOf(v); return p.w ? toMin(p.w) : null; }
  const w = getT(t).wake;
  return w.mode === "time" ? toMin(w.t) : null;
}
function wheelSet(t, m) {
  m = Math.min(Math.max(m, 0), 23 * 60 + 55);
  const [k, v] = t.split(":");
  if (k === "u") { ls.set(LAST_T_KEY, hhmm(m)); S.calc = { t: hhmm(m), p: null, shift: 0, set: true }; render(); }
  else if (k === "ps") { savePeriod(v, { s: hhmm(m) }); if (S.calc && S.calc.p === v) S.calc.t = hhmm(m); render(); }
  else if (k === "pw") { savePeriod(v, { w: hhmm(m) }); render(); }
  else setWake(t, m);
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
  const t = todayIso(), n = addDays(t, 1), dt = diff(t), dn = diff(n);
  return `<section class="card today">
    <img class="plush" src="img/plush.webp" alt="" width="62" height="78" decoding="async">
    <div class="half ${dt.dinner ? "chg" : ""}"><span class="k">今日の夜</span>${dinnerBig(eff(t).dinner)}${dt.dinner ? wasTag(dinnerText(dt.was.dinner)) : ""}</div>
    <div class="half ${dn.wake ? "chg" : ""}"><span class="k">明日の朝 <b>${md(n)}</b></span>${wakeBig(eff(n).wake)}${dn.wake ? wasTag(wakeText(dn.was.wake)) : ""}</div></section>`;
}
function dinnerPicker(t) {
  const cur = getT(t).dinner;
  const btn = (k, cls = "") => {
    const i = DINNER[k];
    return `<button class="opt ${cls} ${cur === k ? "on" : ""}" data-dinner="${k}" data-t="${t}"><b>${i.label}${i.sfx ? `<span class="sfx">${i.sfx}</span>` : ""}</b>${i.sub ? `<small>${i.sub}</small>` : ""}</button>`;
  };
  return `<div class="dinner">${btn("19")}${btn("20")}${btn("21")}${btn("out", "wide")}${btn("tbd", "wide tbd")}</div>`;
}
function timeWheels(t, m, label) {
  const h = Math.floor(m / 60), mi5 = (m % 60) - ((m % 60) % 5);
  const col = (kind, n, step, sel) => {
    let rows = `<div class="padrow"></div><div class="padrow"></div>`;
    for (let v = 0; v < n; v += step) rows += `<div class="${v === sel ? "sel" : ""}">${kind === "h" ? v : pad(v)}</div>`;
    return rows + `<div class="padrow"></div><div class="padrow"></div>`;
  };
  return `<div class="wheelwrap"><div class="wheels">
      <div class="wheel" data-wheel="h" data-t="${t}" data-sel="${h}" aria-label="時">${col("h", 24, 1, h)}</div>
      <span class="colon">:</span>
      <div class="wheel" data-wheel="m" data-t="${t}" data-sel="${mi5 / 5}" aria-label="分">${col("m", 60, 5, mi5)}</div>
      <span class="wlabel">${label}</span>
    </div></div>`;
}
function wakePicker(t) {
  const w = getT(t).wake;
  const seg = (m, l) => `<button class="${w.mode === m ? "on" : ""}" data-wmode="${m}" data-t="${t}">${l}</button>`;
  let body = "";
  if (w.mode === "time") body = timeWheels(t, toMin(w.t), "w").replace(/<\/div>$/, `<div class="b">${bOf(w.t)}b</div></div>`);
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
    const d = addDays(t, i), e = eff(d), tag = me ? "button" : "div", df = diff(d);
    const was = (on, txt) => (on ? wasTag(txt) : "");
    return `<${tag} class="row ${me ? "" : "static"} ${df.wake || df.dinner ? "chg" : ""}" ${me ? `data-edit="${d}"` : ""}>
      <span class="d">${md(d)}${df.wake || df.dinner ? `<span class="newtag">未送信</span>` : ""}</span>
      <span class="cell ${df.wake ? "on" : ""}">${wakeCell(e.wake, e.wakeBase)}${df.wake ? was(true, wakeText(df.was.wake)) : ""}</span>
      <span class="cell ${df.dinner ? "on" : ""}">${dinnerCell(e.dinner, e.dinnerBase)}${df.dinner ? was(true, dinnerText(df.was.dinner)) : ""}</span>
      ${me ? `<span class="chev">›</span>` : ""}</${tag}>`;
  }).join("");
  return `<section class="card week ${me ? "" : "static"}">
    <div class="head"><span>先の予定</span><span>朝</span><span>夜</span>${me ? "<span></span>" : ""}</div>${rows}
    ${me ? `<button class="linkbtn" data-act="base">基本の予定を設定${changes().defaults ? `<span class="newtag">未送信</span>` : ""}</button>` : ""}</section>`;
}
function sendBar() {
  const ch = changes(), n = ch.dates.length + (ch.defaults ? 1 : 0);
  const blocked = S.server && S.server.schema !== 2;
  const label = S.sending ? "送信中…" : blocked ? "Apps Scriptの更新が必要です" : n ? `お母さんに送信（${n}件）` : "すべて送信済み";
  const items = ch.dates.map((d) => { const f = diff(d); return `${md(d).replace(/（.）/, "")}${f.wake && f.dinner ? "朝・夜" : f.wake ? "朝" : f.dinner ? "夜" : ""}`; });
  if (ch.defaults) items.push("基本の予定");
  const note = n && !S.sending ? `<div class="sendnote"><span>未送信：${items.join("、")}</span><button data-act="discard">取り消す</button></div>` : "";
  return `<div class="sendbar">${note}<button data-act="send" ${n && !S.sending && !blocked ? "" : "disabled"}>${label}</button></div>`;
}
function renderMe() {
  const t = todayIso(), n = addDays(t, 1);
  const tabs = `<nav class="seg two tabs"><button class="${S.tab === "plan" ? "on" : ""}" data-tab="plan">予定</button><button class="${S.tab === "uni" ? "on" : ""}" data-tab="uni">大学</button></nav>`;
  if (S.tab === "uni") return `<header class="top">${ymd(t)}</header>${tabs}${renderUni()}${sendBar()}`;
  return `<header class="top">${ymd(t)}</header>${tabs}
    ${S.server && !S.server.momReady ? `<div class="card notice"><span>お母さんのスマホで、まだ通知がオンになっていません</span></div>` : ""}
    ${todayCard()}
    <section class="card ${diff(t).dinner ? "chg" : ""}"><p class="label"><span>夜ご飯</span><span class="d">今日 ${md(t)}</span></p>${dinnerPicker("d:" + t)}</section>
    <section class="card ${diff(n).wake ? "chg" : ""}"><p class="label"><span>起床</span><span class="d">明日 ${md(n)}</span></p>${wakePicker("d:" + n)}</section>
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
    const x = S.draft.days[v.date], df = diff(v.date);
    head = `<h2>${ymd(v.date)}</h2>`;
    body = `<div class="card ${df.wake ? "chg" : ""}"><p class="label"><span>朝（起床）</span>${df.wake ? wasTag(wakeText(df.was.wake)) : ""}</p>${wakePicker("d:" + v.date)}</div>
      <div class="card ${df.dinner ? "chg" : ""}"><p class="label"><span>夜ご飯</span>${df.dinner ? wasTag(dinnerText(df.was.dinner)) : ""}</p>${dinnerPicker("d:" + v.date)}</div>
      ${x ? `<button class="ghost" data-act="reset" data-date="${v.date}">この日を基本の予定に戻す</button>` : ""}`;
  } else if (v.type === "periods") {
    head = `<h2>時限の時刻</h2>`;
    body = periodsSheet();
  } else if (v.type === "period") {
    head = `<button class="back" data-act="periods">‹ 時限の時刻</button>`;
    body = periodSheet(v.k);
  } else if (v.type === "base") {
    head = `<h2>基本の予定</h2>`;
    const rows = WD_ORDER.map((wd) => {
      const b = getT("w:" + wd);
      return `<button class="row ${baseDiff(wd) ? "chg" : ""}" data-wd="${wd}"><span class="d">${WD[wd]}曜日</span>${wakeCell(b.wake, false)}${dinnerCell(b.dinner, false)}<span class="chev">›</span></button>`;
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
      const t = el.dataset.t, m = wheelGet(t);
      if (m === null) return;
      let h = Math.floor(m / 60), mi = m % 60;
      const idx = Math.round(el.scrollTop / 40);
      if (el.dataset.wheel === "h") h = Math.min(Math.max(idx, 0), 23); else mi = Math.min(Math.max(idx, 0), 11) * 5;
      if (h * 60 + mi !== m) wheelSet(t, h * 60 + mi);
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
  const b = e.target.closest("[data-dinner],[data-wmode],[data-edit],[data-act],[data-wd],[data-tab],[data-up],[data-per],[data-pwmode],[data-pick]");
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
  if (b.dataset.tab) { S.tab = b.dataset.tab; S.view = null; render(); scrollTo(0, 0); return; }
  if (b.dataset.pick) {
    const pk = (S.pick = S.pick || new Set()), d = b.dataset.pick;
    if (pk.has(d)) pk.delete(d); else pk.add(d);
    render(); return;
  }
  if (b.dataset.per) { S.view = { type: "period", k: b.dataset.per }; render(); return; }
  if (b.dataset.up) {
    const k = b.dataset.up;
    S.calc = { t: periodOf(k).s, p: k, shift: 0, set: true }; render();
    return;
  }
  if (b.dataset.pwmode) {
    const k = S.view.k, p = periodOf(k);
    let w = null;
    if (b.dataset.pwmode === "fix") {
      w = p.w;
      if (!w) { let d = addDays(todayIso(), 1); while (isHolidayDia(d)) d = addDays(d, 1); savePeriod(k, { w: null }); const r = plan(d, { p: k }); w = r.error ? "07:00" : hhmm(r.w); }
    }
    savePeriod(k, { w });
    render();
    return;
  }
  switch (b.dataset.act) {
    case "close": S.view = null; render(); break;
    case "base": S.view = { type: "base" }; render(); break;
    case "send": sendAll(); break;
    case "reset": delete S.draft.days[b.dataset.date]; saveDraft(); render(); break;
    case "discard": {
      if (!confirm("まだ送っていない変更を取り消して、送信済みの内容に戻しますか？")) break;
      S.draft = clone(S.server); saveDraft(); render(); toast("送信済みの内容に戻しました");
      break;
    }
    case "periods": S.view = { type: "periods" }; render(); break;
    case "apply": applyCalc(); break;
    case "trprev": case "trnext": {
      const c = calc(); c.shift = (c.shift || 0) + (b.dataset.act === "trnext" ? 1 : -1); render();
      break;
    }
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
