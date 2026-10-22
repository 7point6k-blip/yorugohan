// アプリ本体を端末に保存して一瞬で開くため ＋ 閉じていても通知を受け取るためのファイル
const CACHE = "yorugohan-v12";
const SHELL = ["./", "index.html", "app.js", "config.js", "timetable.js", "manifest.json", "img/plush.webp", "icons/icon-192.png", "icons/apple-touch-icon.png"];

importScripts("./config.js");
try {
  importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
  firebase.initializeApp(self.APP_CONFIG.firebase);
  firebase.messaging(); // 通知の表示とタップ時の移動はSDKが自動で行う
} catch (e) {}

/* ホーム画面のアイコンに赤いバッジ（届いた通知の数）を付ける。アプリを開くと0に戻る */
const META = "ygmeta";
async function getBadge() { try { const r = await (await caches.open(META)).match("badge"); return r ? Number(await r.text()) || 0 : 0; } catch (e) { return 0; } }
async function setBadge(n) {
  try { await (await caches.open(META)).put("badge", new Response(String(n))); } catch (e) {}
  try {
    if (n > 0 && self.navigator.setAppBadge) await self.navigator.setAppBadge(n);
    else if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge();
  } catch (e) {}
}
self.addEventListener("push", (e) => { e.waitUntil(getBadge().then((n) => setBadge(n + 1))); });
self.addEventListener("message", (e) => { if (e.data === "clear-badge") e.waitUntil(getBadge().then((n) => (n > 0 ? setBadge(0) : null))); });

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("yorugohan-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// 同じサイトのファイルは「端末の保存分をすぐ返し、裏で最新に入れ替える」
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const key = req.mode === "navigate" ? "index.html" : req;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(key, { ignoreSearch: true });
    const net = fetch(req, { cache: "no-cache" }).then((res) => {
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => hit);
    if (hit) { e.waitUntil(net.then(() => {}, () => {})); return hit; }
    return net;
  }));
});
