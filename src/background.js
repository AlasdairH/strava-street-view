/*
 * Service worker: owns the context menu and turns a stored coordinate into a
 * Google Street View link.
 *
 * chrome.contextMenus.onClicked tells us which item was clicked but not where
 * the right-click happened, so the content script reports the coordinate the
 * moment the menu opens and we look it up on click.
 */

const ITEM = {
  streetView: 'ssv:street-view',
  googleMaps: 'ssv:google-maps',
  copy: 'ssv:copy'
};

const DEFAULTS = {
  forceContextMenu: true,
  blockRightDragRotate: true,
  showGoogleMapsItem: true,
  showCopyItem: true,
  useHeading: true,
  openInBackground: false
};

// Every Strava surface that renders a map. The route builder lives at
// /maps/create (and /routes/new, which redirects there).
const DOCUMENT_PATTERNS = [
  'https://www.strava.com/maps/*',
  'https://www.strava.com/routes/*',
  'https://www.strava.com/activities/*',
  'https://www.strava.com/segments/*',
  'https://www.strava.com/athlete/routes*'
];

// A right-click and the menu click that follows are usually a second apart.
// Anything older is stale -- most likely a menu left open across a pan.
const COORD_TTL_MS = 5 * 60 * 1000;

/* -------------------------------------------------------------------- *
 * Coordinate store
 * -------------------------------------------------------------------- */

// Mirrors chrome.storage.session so the common path needs no async hop, while
// still surviving a service worker restart between the two clicks.
const memory = new Map();

const keyFor = (tabId) => `coords:${tabId}`;

async function rememberCoords(tabId, record) {
  memory.set(tabId, record);
  try {
    await chrome.storage.session.set({ [keyFor(tabId)]: record });
  } catch { /* session storage is best effort */ }
}

async function recallCoords(tabId) {
  const cached = memory.get(tabId);
  if (cached) return cached;
  try {
    const stored = await chrome.storage.session.get(keyFor(tabId));
    return stored[keyFor(tabId)] || null;
  } catch {
    return null;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  memory.delete(tabId);
  chrome.storage.session.remove(keyFor(tabId)).catch(() => {});
});

/* -------------------------------------------------------------------- *
 * Menu
 * -------------------------------------------------------------------- */

const getSettings = () => chrome.storage.sync.get(DEFAULTS);

async function buildMenu() {
  const settings = await getSettings();
  await chrome.contextMenus.removeAll();

  const common = { contexts: ['all'], documentUrlPatterns: DOCUMENT_PATTERNS };

  chrome.contextMenus.create({ ...common, id: ITEM.streetView, title: 'Open Street View here' });

  if (settings.showGoogleMapsItem) {
    chrome.contextMenus.create({ ...common, id: ITEM.googleMaps, title: 'Open Google Maps here' });
  }
  if (settings.showCopyItem) {
    chrome.contextMenus.create({ ...common, id: ITEM.copy, title: 'Copy coordinates' });
  }
}

chrome.runtime.onInstalled.addListener(buildMenu);
chrome.runtime.onStartup.addListener(buildMenu);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.showGoogleMapsItem || changes.showCopyItem) buildMenu();
});

/* -------------------------------------------------------------------- *
 * Messages from content scripts
 * -------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== 'ssv:coords') return;
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined) return;

  rememberCoords(tabId, {
    ok: !!message.ok,
    lat: message.lat,
    lng: message.lng,
    bearing: message.bearing,
    zoom: message.zoom,
    engine: message.engine,
    reason: message.reason,
    at: Date.now()
  });
});

/* -------------------------------------------------------------------- *
 * Links
 * -------------------------------------------------------------------- */

const format = (n) => Number(n).toFixed(6).replace(/\.?0+$/, '');

function streetViewUrl(coords, useHeading) {
  const params = [
    'api=1',
    'map_action=pano',
    `viewpoint=${format(coords.lat)},${format(coords.lng)}`
  ];
  // Aim the camera the same way the map is facing, so a rotated route builder
  // and the Street View that opens from it agree on which way is "forward".
  if (useHeading && Number.isFinite(coords.bearing) && Math.round(coords.bearing) !== 0) {
    params.push(`heading=${(((Math.round(coords.bearing) % 360) + 360) % 360)}`);
  }
  return `https://www.google.com/maps/@?${params.join('&')}`;
}

function googleMapsUrl(coords) {
  return `https://www.google.com/maps/search/?api=1&query=${format(coords.lat)},${format(coords.lng)}`;
}

function notify(tabId, text) {
  chrome.tabs.sendMessage(tabId, { type: 'ssv:toast', text }).catch(() => {});
}

/* -------------------------------------------------------------------- *
 * Menu clicks
 * -------------------------------------------------------------------- */

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id === undefined) return;
  if (!Object.values(ITEM).includes(info.menuItemId)) return;

  const coords = await recallCoords(tab.id);

  if (!coords || !coords.ok) {
    notify(
      tab.id,
      coords && coords.reason === 'not-a-map'
        ? 'Right-click directly on the map to use this.'
        : 'Could not read the map position — try again, or reload the page.'
    );
    return;
  }

  if (Date.now() - coords.at > COORD_TTL_MS) {
    notify(tab.id, 'That map position is stale — right-click the map again.');
    return;
  }

  if (info.menuItemId === ITEM.copy) {
    chrome.tabs
      .sendMessage(tab.id, { type: 'ssv:copy', text: `${format(coords.lat)}, ${format(coords.lng)}` })
      .catch(() => {});
    return;
  }

  const settings = await getSettings();
  const url =
    info.menuItemId === ITEM.googleMaps ? googleMapsUrl(coords) : streetViewUrl(coords, settings.useHeading);

  chrome.tabs.create({
    url,
    index: tab.index + 1,
    active: !settings.openInBackground,
    openerTabId: tab.id
  });
});
