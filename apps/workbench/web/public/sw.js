/*
 * Lets the installed workbench open its own window when the service is slow or away for a moment.
 *
 * It keeps the page itself and its built files, nothing else. Whatever comes from the API or MCP, which is the
 * person's material and understanding, goes straight to the service and is never stored here. A page always
 * tries the service first, so a new build shows up on the next open.
 */

const SHELL = 'episteme-shell-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(['./', './manifest.json', './icon.svg']))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

/** Only the page and its built files: never the API, MCP or anything that is not a plain read. */
function isShell(request) {
  if (request.method !== 'GET') return false
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return false
  // The workbench is one page; its places live in the hash.
  if (request.mode === 'navigate')
    return new URL('./', self.location.href).pathname === url.pathname
  return /\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname) || /\.(?:svg|png)$/.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (!isShell(request)) return
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          // A page is kept under one key, whatever hash or query it was opened with.
          const key = request.mode === 'navigate' ? './' : request
          void caches.open(SHELL).then((cache) => cache.put(key, copy))
        }
        return response
      })
      .catch(async () => {
        const kept = await caches.match(request.mode === 'navigate' ? './' : request)
        return kept ?? Response.error()
      }),
  )
})
