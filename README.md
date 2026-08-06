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
page's own JavaScript world and searches outwards from the element under the
cursor for the live map object: React hangs a fiber tree off every element it
renders, and the map instance is invariably parked in a ref, a piece of state or
a context value somewhere in that tree. A breadth-first walk with a node and
time budget finds it, duck-typed on `unproject`/`containerPointToLatLng`. Global
`maplibregl`/`mapboxgl`/`L` namespaces are hooked too, for pages that load a
plain script build.

Nothing keys off the class names MapLibre puts on its container. Those are the
first thing a host app's CSS pipeline renames, and a single missed class used to
take out the coordinate capture and the rotate suppression together, because
both started from the same "is this a map?" test. The only question asked of a
candidate now is geometric: does the map's own container contain the point that
was clicked? Instances are found once and kept in a registry, warmed up on load
and whenever the pointer first enters a canvas, so the right-click itself is
usually just a rectangle comparison. The same indifference to markup gets it
through a shadow root: the element stack comes from `composedPath()` plus a
shadow-piercing `elementsFromPoint`, not from `Element.closest`.

**Reading the position.** Once the instance is in hand, the click is converted
with the map's own projection — `unproject()` for GL maps,
`containerPointToLatLng()` for Leaflet — so rotation, pitch and globe projection
are all handled correctly rather than approximated.

**The fallback.** For raster maps that draw tiles as `<img>` elements, `src/content.js`
inverts Web Mercator directly from a tile's URL coordinates and its measured
on-screen rectangle, needing nothing from the page's JavaScript at all.

**Keeping the menu alive.** Two separate things on Strava's map eat a
right-click, and both have to be handled.

The first is `preventDefault()` on `contextmenu`: every MapLibre drag handler
installs one, and `MapEventHandler` adds another whenever the page listens for
the map's own contextmenu event — which Strava does. The bridge registers a
capture-phase listener at `document_start`, so it runs before any of them, and
neutralises `preventDefault` for that one event when the click is over a map.
That is the *Force the browser menu over maps* setting.

The second is the gesture. MapLibre binds drag-to-rotate to right-button
mousedown with a 1px tolerance, so the map spins on the slightest hand movement
instead of opening a menu — and on Windows, where the browser generates the
menu on mouse *up*, a right-button drag cancels it outright, leaving no
`contextmenu` event to rescue. The bridge stops right-button mousedown from
reaching the map, and — belt and braces — calls `map.dragRotate.disable()` for
the duration of the press, because a handler that is switched off cannot start a
gesture no matter how the event is routed. That is the *Stop right-drag from
rotating the map* setting. Ctrl + left-drag, MapLibre's other rotate binding, is
untouched: the hold is released on mouseup, on the context menu opening, on
window blur, and by a timeout if none of those arrive.

**Making sure any of this ran.** The MAIN-world content script is registered in
the manifest, and that registration is the one part of the extension it cannot
verify from inside — a strict page CSP or a failed injection leaves it silently
absent, and every downstream symptom then looks like "the map was not
recognised". So the bridge marks `<html data-ssv-bridge>` when it starts, and
`src/content.js` injects the same file from the extension's own origin if the
marker never appears.

**Handing over the coordinate.** `chrome.contextMenus.onClicked` reports which
item was clicked but not where the click happened, so the coordinate is captured
when the menu opens and parked in `chrome.storage.session`, which survives the
service worker being evicted between the two clicks.

Getting it from the page world to the content script takes some care, because
the two worlds' tasks are not ordered against each other: a `postMessage` sent
during the `contextmenu` dispatch can land *after* a `setTimeout(0)` queued by
the other world's listener for the same event. The bridge therefore also writes
the result to a data attribute on `<html>`, which both worlds share
synchronously, and the content script polls briefly for whichever arrives —
reporting what it has straight away and overwriting it if something better turns
up. There is a comfortable margin either way: the menu item cannot be clicked
for several hundred milliseconds.

## Settings

Open the extension's options (`chrome://extensions` → **Details** → **Extension
options**):

| Setting | Default | Effect |
| --- | --- | --- |
| Show *Open Google Maps here* | on | Adds a second item that opens the regular map |
| Show *Copy coordinates* | on | Adds an item that copies `lat, lng` |
| Match the map's rotation | on | Passes the map bearing as the Street View `heading` |
| Open in a background tab | off | Keeps focus on the route builder |
| Stop right-drag from rotating the map | on | Otherwise the rotate gesture swallows the right-click. Ctrl + left-drag still rotates |
| Force the browser menu over maps | on | See above — without it the items usually never appear |

## Development

```sh
npm install
npm test      # loads the extension in Chromium and checks real coordinates
npm run icons # regenerate icons/*.png from tools/make-icons.mjs
```

`npm test` needs a full Chromium — the headless shell cannot load extensions.
Set `CHROMIUM_PATH` to reuse one that is already installed.

The test serves stand-in route builders on the real `https://www.strava.com`
origin, with MapLibre deliberately wrapped so it never touches
`window.maplibregl` and the map instance reachable only through a React fiber —
the same shape Strava ships. It asserts that a right-click reports the same
coordinate `map.unproject()` does, on a rotated map in an offset container, that
the native menu survives MapLibre's `preventDefault()`, that a right-click which
wobbles a few pixels neither rotates the map nor loses its coordinate, that
Ctrl + left-drag still rotates, and that the tile fallback inverts Web Mercator
correctly. Both suppression settings have negative controls, so turning them off
provably restores Strava's original behaviour.

Two variants of the page exist to stop the extension leaning on markup it does
not control. One strips every `maplibregl-*` class out of the map's subtree and
keeps stripping them, so nothing in the DOM says "map"; the other mounts the map
inside a shadow root. Both are otherwise ordinary working maps, and both must
still produce exact coordinates and still refuse to rotate on a right-drag.

No build step: the source is what gets loaded.

## Troubleshooting

Run `__ssvDiag()` in the page console (the page's own console, not the
extension's) on a Strava map. It prints what the bridge can see: the maps it has
found, their containers and screen rectangles, how many canvases are on the
page, and the last right-click it handled.

| Symptom | Meaning |
| --- | --- |
| `__ssvDiag is not defined` | The page bridge never ran. Reload; if it persists the extension is not loaded for this page |
| `maps: []` with `canvases: 1` | There is a map but its instance could not be reached — the interesting failure, and worth an issue |
| `lastEvent.reason: "not-a-map"` | The click was not over any map's container |

## Permissions

| Permission | Why |
| --- | --- |
| `contextMenus` | Adds the right-click items |
| `storage` | Settings, plus the pending coordinate in session storage |
| `https://www.strava.com/*` | The content scripts that read the map |

Nothing is sent anywhere. Opening Street View is an ordinary new tab with the
coordinate in the URL.

## Limitations

- Rotating the map by right-dragging is disabled by default, because that
  gesture and a right-click are the same input. Use Ctrl + left-drag, or turn
  the setting off if you would rather keep the gesture than the menu.
- Strava is free to change its map stack; if the instance can never be found,
  the menu item reports that instead of guessing at a position.
- Street View only exists where Google has driven. Google falls back to the map
  view when there is no nearby panorama.
