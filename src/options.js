'use strict';

const DEFAULTS = {
  forceContextMenu: true,
  blockRightDragRotate: true,
  showGoogleMapsItem: true,
  showCopyItem: true,
  useHeading: true,
  openInBackground: false
};

const form = document.getElementById('settings');
const status = document.getElementById('status');

let statusTimer;

function flash(text) {
  status.textContent = text;
  status.classList.add('visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove('visible'), 1500);
}

chrome.storage.sync.get(DEFAULTS, (values) => {
  for (const [name, value] of Object.entries(values)) {
    const input = form.elements.namedItem(name);
    if (input) input.checked = !!value;
  }
});

form.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !(input.name in DEFAULTS)) return;
  chrome.storage.sync.set({ [input.name]: input.checked }, () => flash('Saved'));
});
