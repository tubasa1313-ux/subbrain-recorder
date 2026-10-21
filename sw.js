// 画面のファイルの保存と、朝のタスク通知の表示を受け持ちます。記録の送信（Apps Script への POST）には関わりません。
const CACHE = 'subbrain-recorder-v5';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// 新しい版を優先し、電波がないときだけ保存した画面を出す
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        // ?view=tasks などの付いたURLを別々に保存しない
        const url = new URL(request.url);
        const copy = response.clone();
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(url.origin + url.pathname, copy));
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});

// ---------- 朝のタスク通知 ----------
// 通知そのものには中身がないので、届いたらタスク一覧を取りに行ってから表示する。

function idbGet(key) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('subbrain', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => resolve(undefined);
      req.onsuccess = () => {
        const get = req.result.transaction('kv', 'readonly').objectStore('kv').get(key);
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => resolve(undefined);
      };
    } catch (error) {
      resolve(undefined);
    }
  });
}

function formatTasks(d) {
  const counts = [];
  if (d.overdue.length) counts.push('期限切れ' + d.overdue.length);
  counts.push('今日' + d.today.length);
  if (d.soon.length) counts.push('7日以内' + d.soon.length);
  const lines = []
    .concat(d.overdue.map((t) => '⚠ ' + t.text))
    .concat(d.today.map((t) => '・' + t.text))
    .concat(d.soon.map((t) => '・' + t.text + '（' + t.due.slice(5).replace('-', '/') + '）'));
  let body = lines.slice(0, 5).join('\n');
  if (lines.length > 5) body += '\nほか' + (lines.length - 5) + '件';
  if (!body) body = '期限のあるタスクはありません。' + (d.nodate.length ? '期限なし' + d.nodate.length + '件' : '');
  return { title: '今日のタスク（' + counts.join('・') + '）', body: body };
}

async function showMorningNotification() {
  let title = '今日のタスク';
  let body = 'アプリを開いてタスクを確認してください。';
  try {
    const url = await idbGet('gasUrl');
    const secret = await idbGet('appSecret');
    if (url && secret) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      const res = await fetch(url, { method: 'POST', body: JSON.stringify({ app: true, secret, action: 'tasks' }), signal: controller.signal });
      clearTimeout(timer);
      const data = await res.json();
      if (data.ok) {
        ({ title, body } = formatTasks(data));
        const urgent = data.overdue.length + data.today.length;
        if (self.navigator && 'setAppBadge' in self.navigator) await (urgent ? self.navigator.setAppBadge(urgent) : self.navigator.clearAppBadge()).catch(() => {});
      }
    }
  } catch (error) {
    // 取れなかったときは汎用の文面で知らせる
  }
  await self.registration.showNotification(title, {
    body,
    tag: 'morning-tasks',
    icon: 'icon-192.png',
    data: { url: './?view=tasks' },
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(showMorningNotification());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ view: 'tasks' });
        return;
      }
    }
    await self.clients.openWindow((event.notification.data && event.notification.data.url) || './?view=tasks');
  })());
});
