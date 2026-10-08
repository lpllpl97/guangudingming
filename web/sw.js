/* Service Worker —— 让静态站点可以离线使用、并能"添加到主屏幕"。
 *
 * 【策略】针对两类资源用不同规则，各自解决一个真实问题：
 *   · 页面与代码（html/js/css）：**网络优先**。否则你更新了代码，用户看到的还是旧的
 *     （静态站点最常见的"改了没生效"）。
 *   · 知识库数据与图片（kbdata/kb.js 873 KB、img/*）：**缓存优先**。它很大且极少变，
 *     每次都重新下载既慢又费流量；而它一变就说明知识库更新了，此时由 CACHE 版本号兜底。
 *
 * 【不做的事】不缓存 /api/naming/* —— 静态托管上这些请求由页面内的 JS 引擎直接应答，
 * 根本不出网；而本机起了服务时，接口结果本就不该被缓存。
 */
'use strict';

// 改动页面外壳（html/css/js/图标）后请把版本号 +1，用户的旧缓存才会被替换
// v2：图标改为朱砂印章 + 繁体「觀」（与页头印章同源）
var CACHE = 'gdm-v2';
var SHELL = [
  './',
  './index.html',
  './css/style.css',
  './manifest.webmanifest',
  './img/icon.svg',
  './img/icon-192.png',
  './img/icon-512.png'
];
// 缓存优先的资源：体积大 / 几乎不变
var DATA_PREFIX = 'kbdata/';
var IMG_PREFIX = 'img/';

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 逐个加入：任一失败不至于让整个安装失败（例如某个图标还没生成）
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') { return; }
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) { return; }
  if (url.pathname.indexOf('/api/') >= 0) { return; }        // 接口不缓存

  var p = url.pathname;
  var isData = p.indexOf(DATA_PREFIX) >= 0 || p.indexOf(IMG_PREFIX) >= 0;

  if (isData) {
    // 缓存优先
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) { return hit; }
        return fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        });
      })
    );
    return;
  }

  // 网络优先（页面与代码）
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    })
  );
});
