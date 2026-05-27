/* coi-serviceworker v0.1.7
 * Adds Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers
 * via a service worker to enable SharedArrayBuffer on GitHub Pages.
 * https://github.com/gzuidhof/coi-serviceworker
 */

if (typeof window === 'undefined') {
  // ── Service Worker context ──────────────────────────────────────────────
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', function (event) {
    // クロスオリジンリクエストはブラウザに任せる（GTM等の外部リソース）
    // COOP/COEPはメインドキュメント（同一オリジン）にのみ付ければ十分
    if (new URL(event.request.url).origin !== self.location.origin) {
      return;
    }

    if (event.request.cache === 'only-if-cached' &&
        event.request.mode !== 'same-origin') {
      return;
    }

    event.respondWith(
      fetch(event.request)
        .then(function (response) {
          if (response.status === 0) return response;

          const newHeaders = new Headers(response.headers);
          newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
          newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch(e => { console.error('[coi-sw]', e); return Response.error(); })
    );
  });
} else {
  // ── Page context: register the service worker ───────────────────────────
  (function () {
    if (self.crossOriginIsolated) return; // already isolated, nothing to do

    if (!('serviceWorker' in navigator)) {
      console.warn('[coi-sw] Service workers not supported — SharedArrayBuffer may not work');
      return;
    }

    const swSrc = document.currentScript && document.currentScript.src
      ? document.currentScript.src
      : '/coi-serviceworker.js';

    navigator.serviceWorker.register(swSrc)
      .then(function (reg) {
        function reloadOnce() {
          if (sessionStorage.getItem('coiReloadedBySelf')) return;
          sessionStorage.setItem('coiReloadedBySelf', '1');
          location.reload();
        }

        if (reg.installing) {
          reg.installing.addEventListener('statechange', function (e) {
            if (e.target.state === 'activated') reloadOnce();
          });
        } else if (reg.waiting) {
          reg.waiting.postMessage('skipWaiting');
          reloadOnce();
        } else if (reg.active) {
          // SW already active — first load after registration
          if (!sessionStorage.getItem('coiReloadedBySelf')) {
            sessionStorage.setItem('coiReloadedBySelf', '1');
            location.reload();
          }
        }

        navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
      })
      .catch(e => console.error('[coi-sw] registration failed:', e));
  })();
}
