// アプリを閉じていても通知を受け取るためのファイル
importScripts("./config.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp(self.APP_CONFIG.firebase);
firebase.messaging(); // 通知の表示とタップ時の移動はSDKが自動で行う

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
