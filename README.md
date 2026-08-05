# Street View for Strava Route Builder

A Chromium extension that adds **Open Street View here** to the right-click menu
on Strava maps. Right-click a road while planning a route and Google Street View
opens at that exact point, so you can see the surface, the junction or the climb
before committing to it.

Also adds optional **Open Google Maps here** and **Copy coordinates** items.

![icon](icons/icon128.png)

## Install

Not on the Web Store — load it unpacked:

1. Clone this repository.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the repository folder.

Requires Chromium 111 or newer (for `MAIN`-world content scripts).

## Where it works

The menu appears on any Strava page that renders a map:

| Page | URL |
| --- | --- |
| Route builder | `/maps/create`, `/routes/new` |
| Saved routes | `/routes/…` |
| Activities | `/activities/…` |
| Segments | `/segments/…` |

## How it works

The interesting part is getting a latitude and longitude out of a right-click,
which is harder than it sounds.

**Finding the map.** Strava's route builder is a Next.js app that bundles
MapLibre GL / Mapbox GL through webpack, so there is no `window.mapboxgl` to
grab and no coordinate anywhere in the DOM. `src/page-bridge.js` runs in the
page's own JavaScript world and searches outwards from the map container for the
live map object: React hangs a fiber tree off every element it renders, and the
map instance is invariably parked in a ref, a piece of state or a context value
somewhere in that tree. A breadth-first walk with a node and time budget finds
it, duck-typed on `unproject`/`containerPointToLatLng`, and the result is cached
per container. Global `maplibregl`/`mapboxgl`/`L` namespaces are hooked too, for
pages that load a plain script build.

**Reading the position.** Once the instance is in hand, the click is converted
with the map's own projection — `unproject()` for GL maps,
`containerPointToLatLng()` for Leaflet — so rotation, pitch and globe projection
are all handled correctly rather than approximated.

**The fallback.** For raster maps that draw tiles as `<img>` elements, `src/content.js`
inverts Web Mercator directly from a tile's URL coordinates and its measured
on-screen rectangle, needing nothing from the page's JavaScript at all.

**Keeping the menu alive.** MapLibre and Mapbox call `preventDefault()` on
`contextmenu` whenever the page listens for their own contextmenu event — which
Strava does — and that suppresses the browser menu, extension items included.
The bridge registers a capture-phase listener at `document_start`, so it runs
first, and neutralises `preventDefault` for that one event when the click is
over a map. This is the *Force the browser menu over maps* setting; turning it
off restores Strava's behaviour exactly, at the cost of the menu items.

**Handing over the coordinate.** `chrome.contextMenus.onClicked` reports which
item was clicked but not where the click happened, so the coordinate is captured
when the menu opens and parked in `chrome.storage.session`, which survives the
service worker being evicted between the two clicks.

## Settings

Open the extension's options (`chrome://extensions` → **Details** → **Extension
options**):

| Setting | Default | Effect |
| --- | --- | --- |
| Show *Open Google Maps here* | on | Adds a second item that opens the regular map |
| Show *Copy coordinates* | on | Adds an item that copies `lat, lng` |
| Match the map's rotation | on | Passes the map bearing as the Street View `heading` |
| Open in a background tab | off | Keeps focus on the route builder |
| Force the browser menu over maps | on | See above — without it the items usually never appear |

## Development

```sh
npm install
npm test      # loads the extension in Chromium and checks real coordinates
npm run icons # regenerate icons/*.png from tools/make-icons.mjs
```

The test serves a stand-in route builder on the real `https://www.strava.com`
origin, with MapLibre deliberately wrapped so it never touches
`window.maplibregl` and the map instance reachable only through a React fiber —
the same shape Strava ships. It then asserts that a right-click reports the same
coordinate `map.unproject()` does, on a rotated map in an offset container, that
the native menu survives MapLibre's `preventDefault()`, and that the tile
fallback inverts Web Mercator correctly.

No build step: the source is what gets loaded.

## Permissions

| Permission | Why |
| --- | --- |
| `contextMenus` | Adds the right-click items |
| `storage` | Settings, plus the pending coordinate in session storage |
| `https://www.strava.com/*` | The content scripts that read the map |

Nothing is sent anywhere. Opening Street View is an ordinary new tab with the
coordinate in the URL.

## Limitations

- Strava is free to change its map stack; if the instance can never be found,
  the menu item reports that instead of guessing at a position.
- Street View only exists where Google has driven. Google falls back to the map
  view when there is no nearby panorama.
