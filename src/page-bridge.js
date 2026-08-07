/*
 * Runs in the page's own JavaScript world (MAIN) at document_start.
 *
 * Its job is to turn a right-click into a latitude/longitude. That requires the
 * live map object, which only exists in the page world -- an isolated content
 * script can see the DOM but not the variables holding the map.
 *
 * Strava bundles MapLibre GL / Mapbox GL through webpack, so there is no
 * `window.mapboxgl` to grab. We therefore locate the instance by searching
 * outwards from the element under the cursor: React keeps a fiber tree hanging
 * off every element it renders, and the map object is almost always parked in a
 * ref, some state, or a context value somewhere in that tree.
 *
 * Nothing here keys off the class names MapLibre puts on its container. Those
 * are the first thing a host app's CSS-in-JS pipeline renames, and a single
 * missed class used to take out both the coordinate capture and the
 * rotate suppression. The only test applied to a candidate is geometric: does
 * the map's own container contain the point that was clicked?
 *
 * Results are published to the content script two ways -- a data attribute on
 * <html> (synchronous, immune to task-ordering races) and window.postMessage.
 */
(() => {
  'use strict';

  // The content script re-injects this file if the MAIN-world registration in
  // the manifest never ran, so it can legitimately be evaluated twice.
  if (window.__ssvBridge) return;
  window.__ssvBridge = { version: 2 };

  const PAGE_SOURCE = 'strava-street-view:page';
  const CONTENT_SOURCE = 'strava-street-view:content';
  const COORDS_ATTR = 'data-ssv-coords';
  const READY_ATTR = 'data-ssv-bridge';

  const config = { forceContextMenu: true, blockRightDragRotate: true };

  const targetOrigin = location.origin && location.origin.startsWith('http') ? location.origin : '*';

  // Containers created by the common map libraries. Only used as a hint for
  // where to start looking and as a last-resort answer to "is the pointer over
  // a map?" when no instance could be found -- never as a requirement.
  const MAP_SELECTOR = [
    '.maplibregl-map',
    '.mapboxgl-map',
    '.leaflet-container',
    '.maplibregl-canvas-container',
    '.mapboxgl-canvas-container',
    '.ol-viewport',
    '.gm-style'
  ].join(',');

  // Instances captured from global namespaces, for the rare page that loads a
  // plain <script> build instead of bundling. Cheap to keep, useful when it hits.
  const globalInstances = new Set();
  // Every map instance we have ever identified, whatever route we found it by.
  const registry = new Set();

  const diag = { lastEvent: null, warmUps: 0, searches: 0 };

  /* ------------------------------------------------------------------ *
   * Recognising a map object
   * ------------------------------------------------------------------ */

  // Leaflet is checked first: its maps also expose `unproject`, but that method
  // takes a *layer* point rather than a container point, so the GL branch would
  // silently produce coordinates that are off by the current pan offset.
  function isLeafletMap(o) {
    return typeof o.containerPointToLatLng === 'function' && typeof o.getContainer === 'function';
  }

  function isGlMap(o) {
    return (
      typeof o.unproject === 'function' &&
      typeof o.getZoom === 'function' &&
      (typeof o.getCanvasContainer === 'function' || typeof o.getContainer === 'function')
    );
  }

  function isMap(o) {
    if (!o || typeof o !== 'object') return false;
    try {
      return isLeafletMap(o) || isGlMap(o);
    } catch {
      return false;
    }
  }

  function containerOf(map) {
    try {
      const el = typeof map.getContainer === 'function' ? map.getContainer() : null;
      return el && el.nodeType === 1 ? el : null;
    } catch {
      return null;
    }
  }

  function remember(map) {
    try {
      if (isMap(map)) registry.add(map);
    } catch { /* ignore */ }
    return map;
  }

  /* ------------------------------------------------------------------ *
   * Geometry
   * ------------------------------------------------------------------ */

  function rectOf(el) {
    if (!el || !el.isConnected) return null;
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      return null;
    }
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function contains(rect, x, y) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  // A map whose container covers the point. When maps are nested (an inset
  // overview map, say) the smallest container wins, which is the one the user
  // is actually looking at.
  function registeredMapAt(x, y) {
    let best = null;
    let bestArea = Infinity;

    for (const map of Array.from(registry)) {
      const el = containerOf(map);
      if (!el || !el.isConnected) {
        registry.delete(map);
        continue;
      }
      const rect = rectOf(el);
      if (!rect || !contains(rect, x, y)) continue;
      const area = rect.width * rect.height;
      if (area < bestArea) {
        best = map;
        bestArea = area;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * Elements under the pointer
   * ------------------------------------------------------------------ */

  // elementsFromPoint stops at a shadow host, so descend through any open
  // shadow root that is also under the point. Strava is not known to use shadow
  // DOM for its maps, but a design-system wrapper that starts to would
  // otherwise make the map invisible to us.
  function pierce(x, y) {
    const out = [];
    if (typeof document.elementsFromPoint !== 'function') return out;

    const queue = [document];
    let guard = 0;
    while (queue.length > 0 && guard++ < 16) {
      const root = queue.shift();
      let hits;
      try {
        hits = root.elementsFromPoint(x, y);
      } catch {
        continue;
      }
      for (const el of hits) {
        out.push(el);
        if (el.shadowRoot && typeof el.shadowRoot.elementsFromPoint === 'function') queue.push(el.shadowRoot);
      }
    }
    return out;
  }

  function elementsForEvent(event) {
    const out = [];
    const seen = new Set();
    const push = (node) => {
      if (!node || node.nodeType !== 1 || seen.has(node)) return;
      seen.add(node);
      out.push(node);
    };

    // composedPath() reaches inside shadow trees the event actually travelled
    // through, which elementsFromPoint cannot do for closed roots.
    if (typeof event.composedPath === 'function') {
      try {
        for (const node of event.composedPath()) push(node);
      } catch { /* ignore */ }
    }
    push(event.target);
    for (const el of pierce(event.clientX, event.clientY)) push(el);

    return out;
  }

  // Shadow-aware "walk towards the document root".
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
    return root && root.host ? root.host : null;
  }

  // The strict question: is this element part of something a map library drew?
  // Used to decide whether to suppress a right-press when no instance could be
  // resolved, so it must not fire on ordinary page furniture.
  function isMapSurface(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'CANVAS') return true;
    try {
      return typeof el.matches === 'function' && el.matches(MAP_SELECTOR);
    } catch {
      return false;
    }
  }

  // The loose question: is it worth spending a fiber search here? False
  // positives only cost CPU -- the candidate still has to pass the geometric
  // test before it is accepted.
  function mayBeMap(el) {
    if (isMapSurface(el)) return true;
    if (el.tagName === 'SVG' || el.tagName === 'IMG') return true;
    let attrs = '';
    try {
      attrs = `${el.getAttribute('class') || ''} ${el.id || ''} ${el.getAttribute('data-testid') || ''}`;
    } catch {
      return false;
    }
    return /map/i.test(attrs);
  }

  /* ------------------------------------------------------------------ *
   * Finding the instance
   * ------------------------------------------------------------------ */

  const FIBER_LINKS = ['stateNode', 'memoizedProps', 'memoizedState', 'child', 'sibling', 'return', 'alternate'];
  const SEARCH_NODE_BUDGET = 25000;
  const SEARCH_TIME_BUDGET_MS = 150;

  function isFiber(o) {
    return typeof o.tag === 'number' && 'stateNode' in o && 'memoizedProps' in o;
  }

  // Values that are large, cyclic, or simply never hold a map. Walking into them
  // burns the node budget before the interesting branches are reached.
  function isUninteresting(v) {
    return (
      v instanceof Node ||
      v instanceof Window ||
      v instanceof Error ||
      v instanceof Promise ||
      v instanceof Date ||
      v instanceof RegExp ||
      ArrayBuffer.isView(v) ||
      v instanceof ArrayBuffer
    );
  }

  function expand(obj, queue) {
    if (isFiber(obj)) {
      for (const key of FIBER_LINKS) {
        try {
          const v = obj[key];
          if (v && typeof v === 'object') queue.push(v);
        } catch { /* getters can throw */ }
      }
      return;
    }

    let keys;
    try {
      keys = Object.keys(obj);
    } catch {
      return;
    }
    // Objects with hundreds of keys are dictionaries/caches, not component state.
    const limit = Math.min(keys.length, 150);
    for (let i = 0; i < limit; i++) {
      try {
        const v = obj[keys[i]];
        if (v && typeof v === 'object' && !isUninteresting(v)) queue.push(v);
      } catch { /* getters can throw */ }
    }
  }

  // Breadth-first so that shallow, likely candidates (a ref right next to the
  // container) win over anything buried deep in the app's state tree.
  function searchForMap(roots, accept) {
    diag.searches++;
    const seen = new WeakSet();
    const queue = roots.filter((r) => r && typeof r === 'object');
    const deadline = performance.now() + SEARCH_TIME_BUDGET_MS;
    let visited = 0;

    while (queue.length > 0 && visited < SEARCH_NODE_BUDGET) {
      const node = queue.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);

      // Checking the clock on every node would dominate the loop's cost.
      if ((++visited & 511) === 0 && performance.now() > deadline) break;

      if (isMap(node)) {
        remember(node);
        if (accept(node)) return node;
        continue;
      }
      if (isUninteresting(node)) continue;
      expand(node, queue);
    }
    return null;
  }

  // React's per-element expandos are suffixed with a random id, so match by prefix.
  function frameworkRootsFor(el) {
    const roots = [];
    let names;
    try {
      names = Object.getOwnPropertyNames(el);
    } catch {
      return roots;
    }
    for (const key of names) {
      if (key.startsWith('__react') || key.startsWith('_react') || key.startsWith('__vue') || key === '__vue__') {
        try {
          const v = el[key];
          if (v && typeof v === 'object') roots.push(v);
        } catch { /* ignore */ }
      }
    }
    return roots;
  }

  // Framework state is attached to the elements React rendered, which is
  // typically an ancestor of the divs the map library created for itself.
  function rootsFrom(elements, seenEl) {
    const roots = [];
    for (const start of elements) {
      let el = start;
      for (let depth = 0; el && depth < 25; depth++, el = parentOf(el)) {
        if (seenEl.has(el)) break;
        seenEl.add(el);
        roots.push(...frameworkRootsFor(el));
      }
    }
    return roots;
  }

  function discoverMapAt(event) {
    const x = event.clientX;
    const y = event.clientY;
    const elements = elementsForEvent(event);

    // Gate the expensive walk. Without this every right-click on a comment or a
    // menu would pay for a fiber search.
    if (!elements.some(mayBeMap)) return null;

    const accept = (map) => {
      const el = containerOf(map);
      if (!el) return false;
      const rect = rectOf(el);
      return !!rect && contains(rect, x, y);
    };

    for (const map of globalInstances) {
      if (accept(map)) return remember(map);
    }

    const roots = rootsFrom(elements, new Set());
    roots.push(window);

    const found = searchForMap(roots, accept);
    return found ? remember(found) : null;
  }

  function mapForEvent(event) {
    return registeredMapAt(event.clientX, event.clientY) || discoverMapAt(event);
  }

  /* ------------------------------------------------------------------ *
   * Warm-up
   * ------------------------------------------------------------------ */

  // Resolving the instance the first time costs up to 150ms of tree walking,
  // and it has to finish inside the contextmenu handler for the coordinate to
  // be ready. Doing it ahead of time means the right-click itself is a rect
  // comparison against the registry.
  const warmed = new WeakSet();

  function warmUp() {
    diag.warmUps++;
    let elements;
    try {
      elements = document.querySelectorAll(`canvas,${MAP_SELECTOR}`);
    } catch {
      return;
    }

    for (const el of elements) {
      if (warmed.has(el)) continue;
      warmed.add(el);
      if (registeredMapAt(...centreOf(el))) continue;

      const accept = (map) => {
        const c = containerOf(map);
        return !!c && (c === el || c.contains(el) || el.contains(c));
      };

      for (const map of globalInstances) {
        if (accept(map)) {
          remember(map);
          break;
        }
      }
      if (registeredMapAt(...centreOf(el))) continue;

      const roots = rootsFrom([el], new Set());
      roots.push(window);
      searchForMap(roots, accept);
    }
  }

  function centreOf(el) {
    const rect = rectOf(el);
    return rect ? [rect.left + rect.width / 2, rect.top + rect.height / 2] : [-1, -1];
  }

  function scheduleWarmUps() {
    for (const delay of [0, 800, 2500, 6000]) {
      setTimeout(() => {
        try {
          warmUp();
        } catch { /* ignore */ }
      }, delay);
    }
  }

  if (document.readyState === 'complete') scheduleWarmUps();
  else window.addEventListener('load', scheduleWarmUps, { once: true });
  // Strava renders the route builder client-side, so the map can appear long
  // after load; a pointer entering a canvas is the cue that one exists now.
  window.addEventListener(
    'pointerover',
    (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1 || warmed.has(el) || !isMapSurface(el)) return;
      try {
        warmUp();
      } catch { /* ignore */ }
    },
    true
  );

  /* ------------------------------------------------------------------ *
   * Screen point -> lat/lng
   * ------------------------------------------------------------------ */

  function normaliseLng(lng) {
    return (((lng + 180) % 360) + 360) % 360 - 180;
  }

  function coordsFrom(map, clientX, clientY) {
    let latLng;
    let engine;
    let bearing = 0;

    if (isLeafletMap(map)) {
      engine = 'leaflet';
      const rect = map.getContainer().getBoundingClientRect();
      latLng = map.containerPointToLatLng([clientX - rect.left, clientY - rect.top]);
    } else {
      engine = 'gl';
      // GL maps project relative to the canvas container, which can be inset
      // from the outer container on some layouts.
      const el = typeof map.getCanvasContainer === 'function' ? map.getCanvasContainer() : map.getContainer();
      const rect = el.getBoundingClientRect();
      latLng = map.unproject([clientX - rect.left, clientY - rect.top]);
      if (typeof map.getBearing === 'function') bearing = map.getBearing();
    }

    const lat = Number(latLng.lat);
    const lng = normaliseLng(Number(latLng.lng));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90) return null;

    let zoom = null;
    try {
      zoom = typeof map.getZoom === 'function' ? map.getZoom() : null;
    } catch { /* ignore */ }

    return {
      lat,
      lng,
      bearing: Number.isFinite(bearing) ? bearing : 0,
      zoom,
      engine
    };
  }

  /* ------------------------------------------------------------------ *
   * Publishing to the content script
   * ------------------------------------------------------------------ */

  function publish(payload) {
    const record = { source: PAGE_SOURCE, kind: 'coords', ts: performance.now(), ...payload };
    diag.lastEvent = record;

    // The attribute is the primary channel: the content script reads it from the
    // shared DOM, so it cannot lose a race against postMessage's task queue.
    try {
      document.documentElement.setAttribute(COORDS_ATTR, JSON.stringify(record));
    } catch { /* ignore */ }
    try {
      window.postMessage(record, targetOrigin);
    } catch { /* ignore */ }
  }

  function markReady() {
    try {
      document.documentElement.setAttribute(READY_ATTR, '2');
    } catch { /* documentElement not there yet */ }
  }

  /* ------------------------------------------------------------------ *
   * Right-click handling
   * ------------------------------------------------------------------ */

  // Makes any later preventDefault() call on this one event a no-op. The
  // listeners still run; they just cannot cancel the browser's default action.
  function neuterPreventDefault(event) {
    try {
      Object.defineProperty(event, 'preventDefault', {
        configurable: true,
        writable: true,
        value: () => {}
      });
    } catch { /* ignore */ }
  }

  // Turning the handler off at the source beats fighting the event: MapLibre
  // cannot start a gesture it is not listening for. Held only for the duration
  // of the press so Ctrl + left-drag rotation is unaffected.
  let rotateHold = null;

  function holdRotate(map) {
    if (rotateHold || !map) return;
    try {
      const handler = map.dragRotate;
      if (!handler || typeof handler.disable !== 'function' || typeof handler.enable !== 'function') return;
      if (typeof handler.isEnabled === 'function' && !handler.isEnabled()) return;
      handler.disable();
      // A mouseup that never arrives (menu opened, window lost focus) must not
      // leave rotation permanently off.
      rotateHold = { map, timer: setTimeout(releaseRotate, 5000) };
    } catch { /* ignore */ }
  }

  function releaseRotate() {
    const held = rotateHold;
    if (!held) return;
    rotateHold = null;
    clearTimeout(held.timer);
    try {
      held.map.dragRotate.enable();
    } catch { /* ignore */ }
  }

  // Right-button mousedown is how MapLibre starts its drag-to-rotate gesture,
  // and it is also what the browser turns into a context menu. Two problems
  // follow, and both are fixed by keeping the press away from the map:
  //
  //  - the gesture wins on the slightest hand movement, so the map spins
  //    instead of opening a menu;
  //  - on Windows the menu is generated on mouse *up*, and a right-button drag
  //    cancels it outright, so there is no contextmenu event left to rescue.
  //
  // Rotating with Ctrl + left-drag is untouched -- MapLibre binds that too.
  function onMouseDown(event) {
    if (event.button !== 2 || !config.blockRightDragRotate) return;

    const map = mapForEvent(event);
    if (map) holdRotate(map);
    // With no instance to disable, fall back to stopping the event -- but only
    // over something a map library plainly drew, so an ordinary right-click
    // elsewhere on the page still reaches Strava's own handlers.
    else if (!elementsForEvent(event).some(isMapSurface)) return;

    neuterPreventDefault(event);
    event.stopPropagation();
  }

  // A cancelled right-button mouseup suppresses the menu on Windows just as a
  // cancelled mousedown does, so this one is defended too -- but only the
  // cancelling is blocked, never the delivery.
  function onMouseUp(event) {
    if (event.button !== 2) {
      releaseRotate();
      return;
    }
    if (config.forceContextMenu && (registeredMapAt(event.clientX, event.clientY) || elementsForEvent(event).some(isMapSurface))) {
      neuterPreventDefault(event);
    }
    releaseRotate();
  }

  function onContextMenu(event) {
    let payload;
    let overMap = false;

    try {
      const map = mapForEvent(event);
      if (map) {
        overMap = true;
        const coords = coordsFrom(map, event.clientX, event.clientY);
        payload = coords ? { ok: true, ...coords } : { ok: false, reason: 'unproject-failed' };
      } else if (elementsForEvent(event).some(isMapSurface)) {
        overMap = true;
        payload = { ok: false, reason: 'no-map-object' };
      } else {
        payload = { ok: false, reason: 'not-a-map' };
      }
    } catch (err) {
      payload = { ok: false, reason: 'error: ' + (err && err.message ? err.message : String(err)) };
    }

    // Every MapLibre/Mapbox drag handler installs its own
    // `contextmenu -> preventDefault()`, and MapEventHandler adds another
    // whenever the page listens for the map's contextmenu event -- which
    // Strava does. Neutering preventDefault is what makes the extension's menu
    // item reachable at all.
    if (overMap && config.forceContextMenu) neuterPreventDefault(event);

    publish({ x: event.clientX, y: event.clientY, ...payload });
    releaseRotate();
  }

  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('blur', releaseRotate);

  /* ------------------------------------------------------------------ *
   * Global map constructors (non-bundled builds)
   * ------------------------------------------------------------------ */

  function wrapConstructor(ns, key) {
    const Original = ns[key];
    if (typeof Original !== 'function' || Original.__ssvWrapped) return;

    function Wrapped(...args) {
      const instance = new.target
        ? Reflect.construct(Original, args, new.target)
        : Original.apply(this, args);
      try {
        if (isMap(instance)) {
          globalInstances.add(instance);
          registry.add(instance);
        }
      } catch { /* ignore */ }
      return instance;
    }

    Wrapped.prototype = Original.prototype;
    Wrapped.__ssvWrapped = true;
    try {
      Object.setPrototypeOf(Wrapped, Original);
      ns[key] = Wrapped;
    } catch { /* frozen namespace */ }
  }

  function hookNamespace(ns) {
    if (!ns || typeof ns !== 'object') return;
    wrapConstructor(ns, 'Map');
    // Leaflet's documented entry point is the lowercase factory, and it closes
    // over the class rather than reading L.Map, so both need wrapping.
    if (typeof ns.map === 'function') wrapConstructor(ns, 'map');
  }

  for (const name of ['maplibregl', 'mapboxgl', 'L']) {
    if (window[name]) {
      hookNamespace(window[name]);
      continue;
    }
    let stored;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: () => stored,
        set(value) {
          stored = value;
          hookNamespace(value);
        }
      });
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * Config from the content script
   * ------------------------------------------------------------------ */

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CONTENT_SOURCE || data.kind !== 'config') return;
    if (!data.values || typeof data.values !== 'object') return;
    for (const key of Object.keys(config)) {
      if (typeof data.values[key] === 'boolean') config[key] = data.values[key];
    }
  });

  /* ------------------------------------------------------------------ *
   * Diagnostics
   * ------------------------------------------------------------------ */

  // Run __ssvDiag() in the page console to see what the bridge can and cannot
  // find. If the function is missing entirely, this script never ran.
  window.__ssvDiag = function ssvDiag() {
    const containers = [];
    try {
      for (const el of document.querySelectorAll(MAP_SELECTOR)) containers.push(el.getAttribute('class') || '(no class)');
    } catch { /* ignore */ }

    const maps = [];
    for (const map of registry) {
      const el = containerOf(map);
      const rect = el && rectOf(el);
      maps.push({
        engine: isLeafletMap(map) ? 'leaflet' : 'gl',
        connected: !!(el && el.isConnected),
        classes: el ? el.getAttribute('class') || '(no class)' : null,
        rect: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) } : null
      });
    }

    const report = {
      bridge: window.__ssvBridge,
      url: location.href,
      config,
      maps,
      globalInstances: globalInstances.size,
      knownContainers: containers,
      canvases: document.querySelectorAll('canvas').length,
      searches: diag.searches,
      warmUps: diag.warmUps,
      lastEvent: diag.lastEvent
    };
    console.log('[strava-street-view]', report);
    return report;
  };

  markReady();
  if (!document.documentElement) document.addEventListener('readystatechange', markReady, { once: true });
})();
