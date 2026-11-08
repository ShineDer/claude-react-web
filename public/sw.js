/* global self, fetch, caches, console, Response, URL */
// Service Worker for claude-react-web.
//
// Two responsibilities on one registration (notifications need a SW, so the
// installability shell rides along):
//
// 1. Notifications (always on): receive SHOW_NOTIFICATION messages from the
//    main thread, display OS notifications with Allow/Deny actions, call the
//    decide API straight from the SW on an action click, and relay the action
//    back to the main thread.
// 2. Offline shell (opt-in): after the user turns it on from the app, cache the
//    built assets so a cold start paints without the network. OFF by default —
//    a cached shell would otherwise keep serving the old UI after an upgrade.
//
// Cache strategy: network-first for navigations and `index.html` (a reachable
// server always wins, so a redeploy is picked up on the next load), cache-first
// for everything else (Vite fingerprints these filenames, so a changed asset is
// a changed URL and can never go stale under a cache entry).

const SHELL_CACHE = 'crw-shell-v1'
const SHELL_ENABLED_KEY = 'crw-shell-enabled'

/** Has the user opted into the offline shell? */
async function shellEnabled() {
  const cache = await caches.open(SHELL_CACHE)
  return !!(await cache.match(SHELL_ENABLED_KEY))
}

// ── Inbound: main thread → SW ────────────────────────────────────────

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data) return

  if (data.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(
      self.registration.showNotification(data.title, {
        body: data.body || '',
        tag: data.tag,
        icon: data.icon || '/icon-192.png',
        requireInteraction: data.requireInteraction ?? false,
        silent: data.silent ?? false,
        actions: data.actions || [],
        // Persist metadata so onnotificationclick can read it.
        data: data.data || {},
      }),
    )
    return
  }

  // Opt in: precache the shell, then mark it enabled.
  if (data.type === 'ENABLE_SHELL') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(SHELL_CACHE)
        await cache.addAll(['/', '/index.html', '/manifest.webmanifest'])
        await cache.put(SHELL_ENABLED_KEY, new Response('1'))
        event.source?.postMessage({ type: 'SHELL_ENABLED', ok: true })
      })().catch((err) => {
        console.warn('[sw] shell precache failed:', err)
        event.source?.postMessage({ type: 'SHELL_ENABLED', ok: false })
      }),
    )
    return
  }

  // Opt out: drop everything.
  if (data.type === 'DISABLE_SHELL') {
    event.waitUntil(
      caches.delete(SHELL_CACHE).then(() => event.source?.postMessage({ type: 'SHELL_DISABLED', ok: true })),
    )
  }
})

// ── Fetch: the offline shell ──────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event
  // Only same-origin GETs; the API is live JSON and a cached response would
  // mislead (a stale session list is worse than a spinner).
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  const isNavigation = request.mode === 'navigate'
  const isShellDoc = isNavigation || url.pathname === '/' || url.pathname === '/index.html'

  event.respondWith(
    (async () => {
      if (!(await shellEnabled())) return fetch(request)

      const cache = await caches.open(SHELL_CACHE)

      if (isShellDoc) {
        try {
          const fresh = await fetch(request)
          if (fresh.ok) await cache.put('/index.html', fresh.clone())
          return fresh
        } catch {
          // Offline: fall back to the last good shell, else let it fail.
          return (await cache.match('/index.html')) ?? Response.error()
        }
      }

      const hit = await cache.match(request)
      if (hit) return hit
      const fresh = await fetch(request)
      // Cache successful, basic (same-origin) responses only — opaque or
      // error responses must not poison a fingerprint-keyed entry.
      if (fresh.ok && fresh.type === 'basic') await cache.put(request, fresh.clone())
      return fresh
    })(),
  )
})

// ── Activate: drop caches from older SW builds ────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))),
  )
})

// ── Notification click ───────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const { sessionId, permissionId, updatedInput } = event.notification.data || {}
  const action = event.action // 'allow' | 'deny' | '' (body click)

  // Allow / Deny: call the decide API directly from the SW.
  // The main thread doesn't need to be involved for the API call itself —
  // the server broadcasts permission-resolved over WS which updates the
  // React UI automatically once the window regains focus.
  if (permissionId && (action === 'allow' || action === 'deny')) {
    event.waitUntil(
      fetch(`/api/sessions/${sessionId}/permissions/${permissionId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          behavior: action,
          // The SDK requires updatedInput on allow paths — echo the
          // original tool input that was captured when the notification
          // was created.
          updatedInput: updatedInput,
          persistForSession: false,
        }),
      }).catch((err) => {
        // Non-fatal: the user can still open the page and decide manually.
        console.warn('[sw] decide API call failed:', err)
      }),
    )
  }

  // Notify the main thread so it can focus the window and sync UI state.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Prefer a visible + focused client, then any visible, then any client.
      const client =
        clients.find(c => c.visibilityState === 'visible' && c.focused) ??
        clients.find(c => c.visibilityState === 'visible') ??
        clients[0]
      if (client) {
        client.postMessage({
          type: 'NOTIFICATION_ACTION',
          sessionId,
          action, // 'allow' | 'deny' | ''
        })
        return client.focus()
      }
      // No existing window — open a new one.
      if (self.clients.openWindow) {
        return self.clients.openWindow('/')
      }
    }),
  )
})
