/*
 * Runs in the extension's isolated world on every strava.com page.
 *
 * Bridges three parties:
 *   page-bridge.js  -> coordinates for the click, when it could reach the map object
 *   this file       -> a DOM-only fallback for raster (Leaflet) maps
 *   background.js   -> stores the result so the context menu click can use it
 *
 * The right-click and the menu click are separate events, so the coordinate has
 * to be captured up front and parked in the service worker.
 */
(() => {
  'use strict';

  const PAGE_SOURCE = 'strava-street-view:page';
  const CONTENT_SOURCE = 'strava-street-view:content';
  const COORDS_ATTR = 'data-ssv-coords';
  const READY_ATTR = 'data-ssv-bridge';

  const targetOrigin = location.origin && location.origin.startsWith('http') ? location.origin : '*';

  let latestFromPage = null;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE_SOURCE || data.kind !== 'coords') return;
    latestFromPage = data;
  });

  /* ------------------------------------------------------------------ *
   * Making sure the page bridge is actually running
   * ------------------------------------------------------------------ */

  // A MAIN-world content script is registered in the manifest, but that
  // registration is the one part of this extension we cannot verify from here
  // -- a strict page CSP or an injection failure leaves it silently absent, and
  // every symptom then looks like "the map was not recognised". So: check for
  // its marker, and inject the same file from the extension's own origin if the
  // marker never appears.
  let injected = false;

  function bridgeReady() {
    try {
      return document.documentElement.hasAttribute(READY_ATTR);
    } catch {
      return false;
    }
  }

  function injectBridge() {
    if (injected || bridgeReady()) return;
    injected = true;
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('src/page-bridge.js');
      script.async = false;
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch { /* extension context invalidated */ }
  }

  // Give the manifest registration a moment first; it runs at document_start,
  // so anything later than this is not coming.
  setTimeout(injectBridge, 500);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectBridge, { once: true });
  }

  /* ------------------------------------------------------------------ *
   * Fallback: read the projection straight off the tile images
   * ------------------------------------------------------------------ */

  // Slippy-map tiles carry their own coordinates in the URL, and their on-screen
  // rectangle is measurable, which is enough to invert Web Mercator without any
  // help from the page's JavaScript. Only works for DOM tile maps (Leaflet);
  // GL maps draw into a single canvas and leave nothing to measure.
  const TILE_URL = /(?:^|\/)(\d{1,2})\/(\d{1,7})\/(\d{1,7})(?:@[\d.]+x)?(?:\.\w{2,5})?(?:[?#]|$)/;

  function parseTile(url) {
    const match = TILE_URL.exec(url);
    if (!match) return null;
    const z = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const span = 2 ** z;
    if (z > 24 || x >= span || y >= span) return null;
    return { z, x, y, span };
  }

  function coordsFromTiles(clientX, clientY) {
    const stack = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(clientX, clientY)
      : [document.elementFromPoint(clientX, clientY)];

    let container = null;
    for (const el of stack) {
      const hit = el && el.closest && el.closest('.leaflet-container');
      if (hit) {
        container = hit;
        break;
      }
    }
    if (!container) return null;

    const tiles = container.querySelectorAll('img.leaflet-tile[src]');
    let best = null;

    for (const tile of tiles) {
      const parsed = parseTile(tile.currentSrc || tile.src);
      if (!parsed) continue;
      const rect = tile.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) continue;

      // A tile under the cursor is immune to mismatched zoom levels layered
      // during a zoom animation, so prefer one; otherwise any tile works
      // because Leaflet transforms the whole grid as a unit.
      const covers =
        clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
      if (covers) {
        best = { parsed, rect };
        break;
      }
      if (!best) best = { parsed, rect };
    }
    if (!best) return null;

    const { parsed, rect } = best;
    const worldX = parsed.x + (clientX - rect.left) / rect.width;
    const worldY = parsed.y + (clientY - rect.top) / rect.height;

    const lng = (worldX / parsed.span) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * worldY) / parsed.span;
    const lat = (180 / Math.PI) * (Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90) return null;
    return { ok: true, lat, lng, bearing: 0, zoom: parsed.z, engine: 'tiles' };
  }

  /* ------------------------------------------------------------------ *
   * Right-click capture
   * ------------------------------------------------------------------ */

  function send(message) {
    try {
      // Rejects when the extension was reloaded and this script is orphaned.
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch { /* context invalidated */ }
  }

  function report(result) {
    if (result && result.ok) {
      send({
        type: 'ssv:coords',
        ok: true,
        lat: result.lat,
        lng: result.lng,
        bearing: result.bearing,
        zoom: result.zoom,
        engine: result.engine
      });
    } else {
      send({
        type: 'ssv:coords',
        ok: false,
        reason: (result && result.reason) || (bridgeReady() ? 'not-a-map' : 'no-bridge')
      });
    }
  }

  // The page bridge publishes through the shared DOM as well as postMessage,
  // because the two worlds' tasks are not ordered against each other and a
  // postMessage can land after this handler's timer has already fired.
  function readFromPage(since) {
    let fromAttribute = null;
    try {
      const raw = document.documentElement.getAttribute(COORDS_ATTR);
      if (raw) fromAttribute = JSON.parse(raw);
    } catch { /* ignore */ }

    let best = null;
    for (const record of [fromAttribute, latestFromPage]) {
      if (!record || typeof record.ts !== 'number' || record.ts < since) continue;
      if (!best || record.ts > best.ts) best = record;
    }
    return best;
  }

  const POLL_WINDOW_MS = 400;
  const POLL_INTERVAL_MS = 12;
  // The bridge publishes synchronously inside the same contextmenu dispatch, so
  // its timestamp can sit fractionally either side of ours depending on which
  // world's listener ran first.
  const CLOCK_SLACK_MS = 50;

  window.addEventListener(
    'contextmenu',
    (event) => {
      const at = performance.now();
      const x = event.clientX;
      const y = event.clientY;
      const deadline = at + POLL_WINDOW_MS;
      let reported = false;

      // Anything we have is sent immediately and overwritten if something
      // better arrives, so a fast menu click still finds a coordinate waiting.
      const publish = (result) => {
        reported = true;
        report(result);
      };

      const poll = () => {
        const fromPage = readFromPage(at - CLOCK_SLACK_MS);
        if (fromPage && fromPage.ok) {
          publish(fromPage);
          return;
        }

        let tiles = null;
        try {
          tiles = coordsFromTiles(x, y);
        } catch { /* ignore */ }
        if (tiles) {
          publish(tiles);
          return;
        }

        if (!reported) publish(fromPage);

        if (performance.now() < deadline) setTimeout(poll, POLL_INTERVAL_MS);
      };

      poll();
    },
    true
  );

  /* ------------------------------------------------------------------ *
   * Toast
   * ------------------------------------------------------------------ */

  let toastHost = null;

  function showToast(text) {
    if (!toastHost || !toastHost.isConnected) {
      toastHost = document.createElement('div');
      toastHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;inset:auto 0 24px 0;';
      const shadow = toastHost.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        .toast {
          margin: 0 auto;
          max-width: 30rem;
          padding: 0.75rem 1.125rem;
          border-radius: 0.5rem;
          background: #26282b;
          color: #fff;
          font: 500 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          text-align: center;
          box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
          border-left: 4px solid #fc5200;
        }`;
      const box = document.createElement('div');
      box.className = 'toast';
      shadow.append(style, box);
      toastHost.__box = box;
      (document.body || document.documentElement).appendChild(toastHost);
    }

    toastHost.__box.textContent = text;
    clearTimeout(toastHost.__timer);
    toastHost.__timer = setTimeout(() => toastHost.remove(), 4000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API needs a focused document and can be blocked by policy.
      try {
        const scratch = document.createElement('textarea');
        scratch.value = text;
        scratch.setAttribute('readonly', '');
        scratch.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
        document.body.appendChild(scratch);
        scratch.select();
        const ok = document.execCommand('copy');
        scratch.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;

    if (message.type === 'ssv:toast') {
      showToast(message.text);
      return undefined;
    }

    if (message.type === 'ssv:copy') {
      copyText(message.text).then((ok) => {
        showToast(ok ? `Copied ${message.text}` : 'Could not access the clipboard');
        sendResponse({ ok });
      });
      return true; // response is async
    }

    return undefined;
  });

  /* ------------------------------------------------------------------ *
   * Config relay to the page world
   * ------------------------------------------------------------------ */

  // Settings the page world acts on. The rest never leave the service worker.
  const PAGE_SETTINGS = { forceContextMenu: true, blockRightDragRotate: true };

  let lastConfig = null;

  function pushConfig(values) {
    lastConfig = { ...(lastConfig || {}), ...values };
    window.postMessage({ source: CONTENT_SOURCE, kind: 'config', values: lastConfig }, targetOrigin);
  }

  chrome.storage.sync.get(PAGE_SETTINGS, (values) => {
    if (chrome.runtime.lastError) return;
    pushConfig(values);
    // A bridge injected after this point missed the message, so repeat it once
    // the late-injection path has had its chance to run.
    setTimeout(() => pushConfig(values), 1200);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const values = {};
    for (const key of Object.keys(PAGE_SETTINGS)) {
      if (changes[key]) values[key] = changes[key].newValue;
    }
    if (Object.keys(values).length > 0) pushConfig(values);
  });
})();
