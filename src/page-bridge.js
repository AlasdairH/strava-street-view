/*
 * Runs in the page's own JavaScript world (MAIN) at document_start.
 *
 * Its job is to turn a right-click into a latitude/longitude. That requires the
 * live map object, which only exists in the page world -- an isolated content
 * script can see the DOM but not the variables holding the map.
 *
 * Strava bundles MapLibre GL / Mapbox GL through webpack, so there is no
 * `window.mapboxgl` to grab. We therefore locate the instance by searching
 * outwards from the map container element: React keeps a fiber tree hanging off
 * every element it renders, and the map object is almost always parked in a ref,
 * some state, or a context value somewhere in that tree.
 *
 * Results are handed to the content script via window.postMessage.
 */
(() => {
  'use strict';

  const PAGE_SOURCE = 'strava-street-view:page';
  const CONTENT_SOURCE = 'strava-street-view:content';

  const config = { forceContextMenu: true };

  // Containers created by MapLibre/Mapbox GL and Leaflet respectively. The
  // canvas-container variants are listed because the right-click target inside a
  // GL map is the <canvas>, whose closest map-ish ancestor is that wrapper.
  const MAP_SELECTOR = [
    '.maplibregl-map',
    '.mapboxgl-map',
    '.leaflet-container',
    '.maplibregl-canvas-container',
    '.mapboxgl-canvas-container'
  ].join(',');

  const targetOrigin = location.origin && location.origin.startsWith('http') ? location.origin : '*';

  // Instances captured from global namespaces, for the rare page that loads a
  // plain <script> build instead of bundling. Cheap to keep, useful when it hits.
  const globalInstances = new Set();
  // container element -> map instance, so the expensive search runs once per map.
  const resolved = new WeakMap();

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

      if (isMap(node) && accept(node)) return node;
      if (isUninteresting(node)) continue;
      expand(node, queue);
    }
    return null;
  }

  // React's per-element expandos are suffixed with a random id, so match by prefix.
  function reactRootsFor(el) {
    const roots = [];
    for (const key of Object.getOwnPropertyNames(el)) {
      if (key.startsWith('__react') || key.startsWith('_react') || key.startsWith('__vue')) {
        try {
          const v = el[key];
          if (v && typeof v === 'object') roots.push(v);
        } catch { /* ignore */ }
      }
    }
    return roots;
  }

  function findMapFor(container) {
    const cached = resolved.get(container);
    if (cached && containerOf(cached)) return cached;

    // The map's own container may be an ancestor of the element we matched
    // (e.g. we matched `.maplibregl-canvas-container`), so accept either
    // direction of containment.
    const accept = (m) => {
      const c = containerOf(m);
      return !!c && (c === container || c.contains(container) || container.contains(c));
    };

    for (const m of globalInstances) {
      if (accept(m)) {
        resolved.set(container, m);
        return m;
      }
    }

    // Framework state is attached to the elements React rendered, which is
    // typically an ancestor of the divs the map library created for itself.
    const roots = [];
    let el = container;
    for (let depth = 0; el && depth < 20; depth++, el = el.parentElement) {
      roots.push(...reactRootsFor(el));
    }
    roots.push(window);

    const found = searchForMap(roots, accept);
    if (found) resolved.set(container, found);
    return found;
  }

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
   * Right-click handling
   * ------------------------------------------------------------------ */

  function mapContainerAt(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return null;
    const direct = target.closest(MAP_SELECTOR);
    if (direct) return direct;

    // Overlays (markers, popups, custom controls) can sit outside the map
    // element in the DOM while visually covering it.
    if (typeof document.elementsFromPoint === 'function') {
      for (const el of document.elementsFromPoint(event.clientX, event.clientY)) {
        const hit = el.closest && el.closest(MAP_SELECTOR);
        if (hit) return hit;
      }
    }
    return null;
  }

  function onContextMenu(event) {
    const container = mapContainerAt(event);
    if (!container) return;

    // MapLibre/Mapbox suppress the native menu whenever the page listens for
    // their own `contextmenu` event -- which Strava does. Neutering
    // preventDefault for this one event is what makes the extension's menu
    // item reachable at all.
    if (config.forceContextMenu) {
      try {
        Object.defineProperty(event, 'preventDefault', {
          configurable: true,
          writable: true,
          value: () => {}
        });
      } catch { /* ignore */ }
    }

    let payload = { ok: false, reason: 'no-map' };
    try {
      const map = findMapFor(container);
      if (map) {
        const coords = coordsFrom(map, event.clientX, event.clientY);
        payload = coords ? { ok: true, ...coords } : { ok: false, reason: 'unproject-failed' };
      }
    } catch (err) {
      payload = { ok: false, reason: 'error: ' + (err && err.message ? err.message : String(err)) };
    }

    window.postMessage(
      { source: PAGE_SOURCE, kind: 'coords', ts: performance.now(), x: event.clientX, y: event.clientY, ...payload },
      targetOrigin
    );
  }

  window.addEventListener('contextmenu', onContextMenu, true);

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
        if (isMap(instance)) globalInstances.add(instance);
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
    if (typeof data.forceContextMenu === 'boolean') config.forceContextMenu = data.forceContextMenu;
  });
})();
