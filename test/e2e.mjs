/*
 * End-to-end test. Loads the unpacked extension into Chromium, serves stand-ins
 * for the Strava route builder on the real strava.com origin, and checks that a
 * right-click produces the same coordinate the map itself would report.
 *
 *   npm install && npm test
 */
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, '..');

const MAPLIBRE_VERSION = '4.7.1';
const MAPLIBRE_FILE = join(here, `maplibre-gl-${MAPLIBRE_VERSION}.js`);

if (!existsSync(MAPLIBRE_FILE)) {
  const url = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js`;
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not download MapLibre: ${response.status}`);
  writeFileSync(MAPLIBRE_FILE, await response.text());
}

// Wrap the MapLibre UMD bundle so it takes the CommonJS branch and never
// touches window.maplibregl -- exactly how webpack ships it on Strava. Without
// this the extension could cheat by hooking the global constructor.
const bundled = `window.__loadMaplibre = function () {
  var module = { exports: {} }; var exports = module.exports;
  (function (module, exports) {\n${readFileSync(MAPLIBRE_FILE, 'utf8')}\n})(module, exports);
  return module.exports;
};`;

/*
 * `strip` removes every maplibregl-* class from the map's subtree and keeps
 * removing them. That is the shape of the bug this test exists for: a host app
 * whose DOM does not carry the class names the extension used to look for. The
 * map is otherwise completely normal, so anything that finds it has to do so by
 * finding the *instance*, not by matching a selector.
 *
 * `shadow` mounts the map inside an open shadow root, which hides it from
 * document.elementsFromPoint and from Element.closest.
 */
const glPage = ({ strip = false, shadow = false } = {}) => `<!doctype html><meta charset=utf-8><title>Route builder</title>
<style>
  body { margin:0; font-family:sans-serif; }
  header { height: 64px; background:#fc5200; }
  #shell { padding: 12px 24px; }
  #map { width: 800px; height: 500px; }
</style>
<header></header>
<div id="shell"><div id="map"></div></div>
<script>${bundled}<\/script>
<script>
(() => {
  const STRIP = ${strip};
  const SHADOW = ${shadow};
  const maplibregl = window.__loadMaplibre();
  delete window.__loadMaplibre;

  let target = document.getElementById('map');
  if (SHADOW) {
    target.remove();
    const holder = document.createElement('div');
    document.getElementById('shell').appendChild(holder);
    const root = holder.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '#map { width: 800px; height: 500px; }';
    target = document.createElement('div');
    target.id = 'map';
    root.append(style, target);
  }

  const map = new maplibregl.Map({
    container: target,
    style: { version: 8, sources: {}, layers: [] },
    center: [-0.1278, 51.5074],
    zoom: 14,
    bearing: 30,
    attributionControl: false
  });

  if (STRIP) {
    const clean = (el) => {
      if (typeof el.className !== 'string') return;
      const kept = el.className.split(/\\s+/).filter((c) => c && !/^(maplibregl|mapboxgl|leaflet)/.test(c)).join(' ');
      if (kept !== el.className) el.className = kept;
    };
    const scrub = () => { clean(target); target.querySelectorAll('*').forEach(clean); };
    scrub();
    new MutationObserver(scrub).observe(target, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  }

  // Strava listens for the map's own contextmenu, which makes MapLibre call
  // preventDefault() and kill the native menu.
  map.on('contextmenu', () => {});

  // Last listener in the bubble phase: whatever it sees is what Chrome sees
  // when it decides whether to draw the native menu.
  window.addEventListener('contextmenu', (e) => { window.__prevented = e.defaultPrevented; });

  // Park the instance where only a React fiber walk can find it.
  const ref = { current: map };
  const hook2 = { memoizedState: ref, baseState: null, queue: null, next: null };
  const hook1 = { memoizedState: [1, 2, 3], baseState: null, queue: null, next: hook2 };
  const parent = { tag: 0, stateNode: null, memoizedProps: { className: 'wrap' }, memoizedState: hook1, return: null, child: null, sibling: null, alternate: null };
  const child = { tag: 5, stateNode: target, memoizedProps: {}, memoizedState: null, return: parent, child: null, sibling: null, alternate: null };
  parent.child = child;
  target['__reactFiber$t3st'] = child;
  target['__reactProps$t3st'] = {};

  window.__truth = (x, y) => {
    const r = map.getCanvasContainer().getBoundingClientRect();
    const ll = map.unproject([x - r.left, y - r.top]);
    return { lat: ll.lat, lng: ll.lng, bearing: map.getBearing() };
  };
  window.__bearing = () => map.getBearing();
  window.__ready = true;
})();
<\/script>`;

// A hand-built tile grid: no Leaflet, just the DOM shape the fallback reads.
const TILE_PAGE = `<!doctype html><meta charset=utf-8><title>Tile map</title>
<style>body{margin:0}#m{position:absolute;left:40px;top:60px;width:512px;height:512px;overflow:hidden}
img{position:absolute;left:0;top:0;width:512px;height:512px}</style>
<div id="m" class="leaflet-container">
  <img class="leaflet-tile" src="https://tiles.example.com/0/0/0.png">
</div>`;

const userDataDir = mkdtempSync(join(tmpdir(), 'ssv-'));

// Extensions need a full Chromium, not the headless shell. CHROMIUM_PATH lets a
// machine that already has one (a CI image, a sandbox) point at it instead of
// downloading a second copy.
const launchOptions = process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH }
  : { channel: 'chromium' };

const context = await chromium.launchPersistentContext(userDataDir, {
  ...launchOptions,
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader'
  ]
});

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// Wait for the extension's service worker so we can read what it stored.
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
check('service worker started', !!worker, worker.url());

await context.route('https://www.strava.com/**', (route) => {
  const url = route.request().url();
  let body;
  if (url.includes('tiles-test')) body = TILE_PAGE;
  else if (url.includes('strip-test')) body = glPage({ strip: true });
  else if (url.includes('shadow-test')) body = glPage({ shadow: true });
  else body = glPage();
  return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
});

const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });

async function rightClickAndRead(x, y) {
  await worker.evaluate(() => chrome.storage.session.clear());
  await page.mouse.move(x, y);
  await page.mouse.click(x, y, { button: 'right' });
  // Longer than the content script's polling window, so the final answer -- not
  // a provisional one -- is what gets checked.
  await page.waitForTimeout(700);
  const all = await worker.evaluate(() => chrome.storage.session.get(null));
  return Object.values(all)[0] || null;
}

async function openMap(path) {
  await page.goto(`https://www.strava.com/maps/${path}`);
  await page.waitForFunction('window.__ready === true', null, { timeout: 20000 });
  await page.waitForTimeout(300);
}

/* ---------------- Test 1: bundled MapLibre, instance hidden in a fiber ------- */

await openMap('create');

check('page bridge attached', await page.evaluate(() => document.documentElement.hasAttribute('data-ssv-bridge')));

const CLICKS = [[300, 300], [700, 500], [120, 180]];
for (const [x, y] of CLICKS) {
  const truth = await page.evaluate(([px, py]) => window.__truth(px, py), [x, y]);
  const got = await rightClickAndRead(x, y);
  const ok =
    got && got.ok &&
    Math.abs(got.lat - truth.lat) < 1e-9 &&
    Math.abs(got.lng - truth.lng) < 1e-9;
  check(
    `GL map @ (${x},${y})`,
    ok,
    got && got.ok
      ? `got ${got.lat.toFixed(6)},${got.lng.toFixed(6)} expected ${truth.lat.toFixed(6)},${truth.lng.toFixed(6)} engine=${got.engine}`
      : `no coords: ${JSON.stringify(got)}`
  );
}

const bearingRecord = await rightClickAndRead(400, 300);
check('bearing captured', bearingRecord && Math.abs(bearingRecord.bearing - 30) < 1e-6, `bearing=${bearingRecord && bearingRecord.bearing}`);

// Right-clicking off the map must not report a position.
const offMap = await rightClickAndRead(400, 20);
check('off-map click reports no coords', offMap && offMap.ok === false, JSON.stringify(offMap));

/* ---------------- Test 1b: the native menu survives MapLibre ---------------- */

check('native menu not suppressed', (await page.evaluate(() => window.__prevented)) === false,
  `defaultPrevented=${await page.evaluate(() => window.__prevented)}`);

// With the setting off, MapLibre's preventDefault() must take effect again.
await worker.evaluate(() => chrome.storage.sync.set({ forceContextMenu: false }));
await page.waitForTimeout(300);
await page.mouse.click(400, 300, { button: 'right' });
await page.waitForTimeout(300);
check('setting off restores page behaviour', (await page.evaluate(() => window.__prevented)) === true,
  `defaultPrevented=${await page.evaluate(() => window.__prevented)}`);
await worker.evaluate(() => chrome.storage.sync.set({ forceContextMenu: true }));

/* ---------------- Test 1c: a shaky right-click must not rotate -------------- */

// The reported bug: pressing the right button and moving even slightly starts
// MapLibre's drag-to-rotate, which eats the click. On Windows the browser then
// cancels the context menu outright, so there is no event left to rescue.
async function rightPressDrag(x, y, dx, dy) {
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up({ button: 'right' });
}

async function rotationAfterRightDrag(x, y) {
  const before = await page.evaluate(() => window.__bearing());
  await rightPressDrag(x, y, 60, 0);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__bearing());
  return { before, after, moved: Math.abs(after - before) };
}

const spin = await rotationAfterRightDrag(400, 300);
check('right-drag no longer rotates the map', spin.moved < 1e-6, `bearing ${spin.before} -> ${spin.after}`);

// The coordinate must still be reported for a click that wobbled.
const wobbled = await (async () => {
  await worker.evaluate(() => chrome.storage.session.clear());
  await rightPressDrag(350, 320, 3, 2);
  await page.waitForTimeout(700);
  const all = await worker.evaluate(() => chrome.storage.session.get(null));
  return Object.values(all)[0] || null;
})();
check('wobbled right-click still reports coords', wobbled && wobbled.ok === true, JSON.stringify(wobbled));

// Negative control: with the setting off the map must rotate again, proving the
// check above is testing the fix rather than a map that never rotates.
await worker.evaluate(() => chrome.storage.sync.set({ blockRightDragRotate: false }));
await page.waitForTimeout(300);
const control = await rotationAfterRightDrag(400, 300);
check('setting off restores right-drag rotation', control.moved > 1, `bearing ${control.before} -> ${control.after}`);
await worker.evaluate(() => chrome.storage.sync.set({ blockRightDragRotate: true }));
await page.waitForTimeout(300);

// Ctrl+left-drag is MapLibre's other rotate binding and must still work. The
// rotate handler is switched off for the duration of a right-press, so this
// also proves it gets switched back on.
const ctrlBefore = await page.evaluate(() => window.__bearing());
await page.keyboard.down('Control');
await page.mouse.move(400, 300);
await page.mouse.down();
await page.mouse.move(470, 300, { steps: 4 });
await page.mouse.up();
await page.keyboard.up('Control');
await page.waitForTimeout(300);
const ctrlAfter = await page.evaluate(() => window.__bearing());
check('ctrl+left-drag still rotates', Math.abs(ctrlAfter - ctrlBefore) > 1, `bearing ${ctrlBefore} -> ${ctrlAfter}`);

/* ---------------- Test 2: a map with no library class names ----------------- */

// The regression this whole rewrite is for. Nothing in the DOM says "map".
await openMap('strip-test');

check('no library classes left in the DOM',
  (await page.evaluate(() => document.querySelectorAll('[class*="maplibregl"],[class*="mapboxgl"]').length)) === 0);

for (const [x, y] of [[300, 300], [650, 450]]) {
  const truth = await page.evaluate(([px, py]) => window.__truth(px, py), [x, y]);
  const got = await rightClickAndRead(x, y);
  const ok = got && got.ok && Math.abs(got.lat - truth.lat) < 1e-9 && Math.abs(got.lng - truth.lng) < 1e-9;
  check(`unclassed map @ (${x},${y})`, ok,
    got && got.ok ? `got ${got.lat.toFixed(6)},${got.lng.toFixed(6)} engine=${got.engine}` : `no coords: ${JSON.stringify(got)}`);
}

const strippedSpin = await rotationAfterRightDrag(400, 300);
check('unclassed map does not rotate on right-drag', strippedSpin.moved < 1e-6,
  `bearing ${strippedSpin.before} -> ${strippedSpin.after}`);

check('unclassed map still leaves the native menu alone',
  (await page.evaluate(() => window.__prevented)) === false);

const strippedOffMap = await rightClickAndRead(400, 20);
check('unclassed page: off-map click reports no coords', strippedOffMap && strippedOffMap.ok === false,
  JSON.stringify(strippedOffMap));

/* ---------------- Test 3: a map inside a shadow root ------------------------ */

await openMap('shadow-test');

for (const [x, y] of [[300, 300], [650, 450]]) {
  const truth = await page.evaluate(([px, py]) => window.__truth(px, py), [x, y]);
  const got = await rightClickAndRead(x, y);
  const ok = got && got.ok && Math.abs(got.lat - truth.lat) < 1e-9 && Math.abs(got.lng - truth.lng) < 1e-9;
  check(`shadow-DOM map @ (${x},${y})`, ok,
    got && got.ok ? `got ${got.lat.toFixed(6)},${got.lng.toFixed(6)} engine=${got.engine}` : `no coords: ${JSON.stringify(got)}`);
}

const shadowSpin = await rotationAfterRightDrag(400, 300);
check('shadow-DOM map does not rotate on right-drag', shadowSpin.moved < 1e-6,
  `bearing ${shadowSpin.before} -> ${shadowSpin.after}`);

/* ---------------- Test 4: DOM tile fallback --------------------------------- */

await page.goto('https://www.strava.com/maps/tiles-test');
await page.waitForTimeout(300);

// z=0 tile spans the world: 25% across is lng -90, 25% down is lat 66.51326.
const tile = await rightClickAndRead(40 + 128, 60 + 128);
const tileOk = tile && tile.ok && Math.abs(tile.lng + 90) < 1e-6 && Math.abs(tile.lat - 66.51326044) < 1e-6;
check('tile fallback', tileOk, tile && tile.ok ? `${tile.lat.toFixed(8)},${tile.lng.toFixed(8)} engine=${tile.engine}` : JSON.stringify(tile));

const centre = await rightClickAndRead(40 + 256, 60 + 256);
check('tile fallback centre = 0,0', centre && centre.ok && Math.abs(centre.lat) < 1e-9 && Math.abs(centre.lng) < 1e-9,
  centre && centre.ok ? `${centre.lat},${centre.lng}` : JSON.stringify(centre));

/* ---------------- Test 5: diagnostics --------------------------------------- */

await openMap('create');
const report = await page.evaluate(() => (typeof window.__ssvDiag === 'function' ? window.__ssvDiag() : null));
check('__ssvDiag reports a live map', !!report && report.maps.length > 0 && report.maps[0].connected,
  report ? `maps=${report.maps.length} canvases=${report.canvases}` : 'no __ssvDiag');

await context.close();
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall passed');
process.exit(failures.length ? 1 : 0);
