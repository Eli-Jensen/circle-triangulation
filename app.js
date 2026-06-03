const API_BASE = 'http://localhost:8081';

const map = L.map('map').setView([39.8283, -98.5795], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

// Try to center map on user's current location
if ('geolocation' in navigator) {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.setView([pos.coords.latitude, pos.coords.longitude], 10);
    },
    () => { /* denied or error — keep default view */ },
    { enableHighAccuracy: false, timeout: 5000 }
  );
}

const circles = [];
let previewCircle = null;
let previewMarker = null;
let intersectionMarkers = [];
let intersectionShapes = [];
let deleteTarget = null;

// --- Undo/Redo system ---
const undoStack = [];
const redoStack = [];
const MAX_UNDO = 50;

function pushUndo(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  // New action invalidates redo history
  redoStack.length = 0;
}

function deleteCircleById(id) {
  const idx = circles.findIndex(c => c.id === id);
  if (idx === -1) return;
  if (selectedCircleId === id) {
    // Clean up drag marker without full deselect (circle is being removed)
    if (circles[idx]._dragMarker) {
      map.removeLayer(circles[idx]._dragMarker);
      circles[idx]._dragMarker = null;
    }
    selectedCircleId = null;
  }
  pushUndo({ type: 'delete', id: circles[idx].id, index: idx, data: { ...circles[idx].data } });
  removeDensityOverlay(circles[idx]);
  map.removeLayer(circles[idx].circle);
  map.removeLayer(circles[idx].marker);
  circles.splice(idx, 1);
  renderCircleList();
  updateIntersectionButton();
  clearIntersections();
  clearPopulationMarkers();
  setStatus('Circle deleted. Press Cmd+Z to undo.', 'info');
}

function removeCircle(action) {
  const idx = circles.findIndex(c => c.id === action.id);
  if (idx === -1) return;
  removeDensityOverlay(circles[idx]);
  map.removeLayer(circles[idx].circle);
  map.removeLayer(circles[idx].marker);
  circles.splice(idx, 1);
  renderCircleList();
  updateIntersectionButton();
  clearIntersections();
}

function restoreCircle(action) {
  const circle = L.circle([action.data.lat, action.data.lng], {
    radius: action.data.radiusMeters,
    color: action.data.color,
    fillColor: action.data.color,
    fillOpacity: 0.08,
    weight: 2,
  }).addTo(map);

  const marker = L.circleMarker([action.data.lat, action.data.lng], {
    radius: 5,
    color: action.data.color,
    fillColor: action.data.color,
    fillOpacity: 1,
  }).addTo(map);

  const insertIdx = Math.min(action.index, circles.length);
  const restoredEntry = { id: action.id, circle, marker, data: { ...action.data } };
  marker.on('click', () => selectCircle(action.id));
  circles.splice(insertIdx, 0, restoredEntry);
  renderCircleList();
  updateIntersectionButton();
  clearIntersections();
}

function moveCircle(entry, lat, lng) {
  entry.circle.setLatLng([lat, lng]);
  entry.marker.setLatLng([lat, lng]);
  entry.data.lat = lat;
  entry.data.lng = lng;
  clearIntersections();
}

function resizeCircle(entry, radiusMeters) {
  entry.data.radiusMeters = radiusMeters;
  entry.circle.setRadius(radiusMeters);
  entry.data.radiusDisplay = parseFloat(toDisplayUnit(radiusMeters, entry.data.unit).toFixed(2));
  clearIntersections();
  clearPopulationMarkers();
}

function performUndo() {
  if (undoStack.length === 0) {
    setStatus('Nothing to undo.', 'info');
    return;
  }
  const action = undoStack.pop();
  redoStack.push(action);

  switch (action.type) {
    case 'add':
      if (selectedCircleId === action.id) deselectCircle();
      removeCircle(action);
      setStatus('Undo: circle removed.', 'info');
      break;
    case 'delete':
      restoreCircle(action);
      setStatus('Undo: circle restored.', 'info');
      break;
    case 'move': {
      const entry = circles.find(c => c.id === action.id);
      if (!entry) { setStatus('Nothing to undo.', 'info'); return; }
      moveCircle(entry, action.oldLat, action.oldLng);
      if (entry._dragMarker) entry._dragMarker.setLatLng([action.oldLat, action.oldLng]);
      renderCircleList();
      setStatus('Undo: circle moved back.', 'info');
      break;
    }
    case 'resize': {
      const entry = circles.find(c => c.id === action.id);
      if (!entry) { setStatus('Nothing to undo.', 'info'); return; }
      resizeCircle(entry, action.oldRadius);
      renderCircleList();
      setStatus('Undo: radius restored.', 'info');
      break;
    }
  }
}

function performRedo() {
  if (redoStack.length === 0) {
    setStatus('Nothing to redo.', 'info');
    return;
  }
  const action = redoStack.pop();
  undoStack.push(action);

  switch (action.type) {
    case 'add':
      restoreCircle(action);
      setStatus('Redo: circle re-added.', 'info');
      break;
    case 'delete':
      if (selectedCircleId === action.id) deselectCircle();
      removeCircle(action);
      setStatus('Redo: circle re-deleted.', 'info');
      break;
    case 'move': {
      const entry = circles.find(c => c.id === action.id);
      if (!entry) { setStatus('Nothing to redo.', 'info'); return; }
      moveCircle(entry, action.newLat, action.newLng);
      if (entry._dragMarker) entry._dragMarker.setLatLng([action.newLat, action.newLng]);
      renderCircleList();
      setStatus('Redo: circle moved forward.', 'info');
      break;
    }
    case 'resize': {
      const entry = circles.find(c => c.id === action.id);
      if (!entry) { setStatus('Nothing to redo.', 'info'); return; }
      resizeCircle(entry, action.newRadius);
      renderCircleList();
      setStatus('Redo: radius changed.', 'info');
      break;
    }
  }
}

// --- Circle selection ---
let selectedCircleId = null;

function selectCircle(id) {
  // Deselect previous
  if (selectedCircleId !== null) deselectCircle();

  const entry = circles.find(c => c.id === id);
  if (!entry) return;

  selectedCircleId = id;

  // Highlight circle on map
  entry.circle.setStyle({ weight: 4, dashArray: '8 4' });

  // Swap L.circleMarker → draggable L.marker
  map.removeLayer(entry.marker);
  const dragMarker = L.marker([entry.data.lat, entry.data.lng], {
    draggable: true,
    icon: L.divIcon({
      className: 'preview-center-icon',
      html: `<div style="
        width: 14px; height: 14px;
        background: ${entry.data.color};
        border: 3px solid #fff;
        border-radius: 50%;
        box-shadow: 0 0 6px rgba(0,0,0,0.4);
      "></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    }),
  }).addTo(map);

  dragMarker.on('dragstart', () => {
    pushUndo({ type: 'move', id: entry.id, oldLat: entry.data.lat, oldLng: entry.data.lng, newLat: entry.data.lat, newLng: entry.data.lng });
  });

  dragMarker.on('drag', (e) => {
    const pos = e.target.getLatLng();
    entry.circle.setLatLng(pos);
    entry.data.lat = pos.lat;
    entry.data.lng = pos.lng;
  });

  dragMarker.on('dragend', async (e) => {
    const pos = e.target.getLatLng();
    entry.data.lat = pos.lat;
    entry.data.lng = pos.lng;
    // Update undo entry with final position
    const lastUndo = undoStack[undoStack.length - 1];
    if (lastUndo && lastUndo.type === 'move' && lastUndo.id === entry.id) {
      lastUndo.newLat = pos.lat;
      lastUndo.newLng = pos.lng;
    }
    clearIntersections();
    clearPopulationMarkers();
    // Reverse geocode new position
    try {
      const name = await reverseGeocode(pos.lat, pos.lng);
      const short = name.split(',').slice(0, 2).join(',').trim();
      entry.data.displayName = name;
      entry.data.address = short;
      renderCircleList();
      setStatus(`Moved to: ${short}`, 'info');
    } catch {
      entry.data.address = `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`;
      renderCircleList();
    }
  });

  entry._dragMarker = dragMarker;
  renderCircleList();
}

function deselectCircle() {
  if (selectedCircleId === null) return;

  const entry = circles.find(c => c.id === selectedCircleId);
  if (entry) {
    // Restore circle style
    entry.circle.setStyle({ weight: 2, dashArray: null });

    // Swap draggable marker back to L.circleMarker
    if (entry._dragMarker) {
      map.removeLayer(entry._dragMarker);
      entry._dragMarker = null;
    }
    const marker = L.circleMarker([entry.data.lat, entry.data.lng], {
      radius: 5,
      color: entry.data.color,
      fillColor: entry.data.color,
      fillOpacity: 1,
    }).addTo(map);
    marker.on('click', () => selectCircle(entry.id));
    entry.marker = marker;
  }

  selectedCircleId = null;
  renderCircleList();
}

function updateCircleRadius(entry, newRadiusMeters) {
  const oldRadius = entry.data.radiusMeters;
  if (Math.abs(oldRadius - newRadiusMeters) < 0.1) return;

  pushUndo({ type: 'resize', id: entry.id, oldRadius: oldRadius, newRadius: newRadiusMeters });
  entry.data.radiusMeters = newRadiusMeters;
  entry.circle.setRadius(newRadiusMeters);

  const unit = entry.data.unit;
  entry.data.radiusDisplay = parseFloat(toDisplayUnit(newRadiusMeters, unit).toFixed(2));

  clearIntersections();
  clearPopulationMarkers();
}

// --- Color palette for auto-cycling circle colors ---
const CIRCLE_COLORS = [
  '#3388ff', // blue
  '#1a5fb4', // dark blue
  '#62a0ea', // sky blue
  '#1c71d8', // strong blue
  '#99c1f1', // light blue
  '#26a4e0', // cyan-blue
  '#1b6ec2', // royal blue
  '#4dabf7', // medium blue
  '#0b5394', // navy blue
  '#74b9ff', // soft blue
  '#2471a3', // steel blue
  '#5dade2', // ocean blue
];
let nextColorIndex = 0;

function getNextColor() {
  const color = CIRCLE_COLORS[nextColorIndex % CIRCLE_COLORS.length];
  nextColorIndex++;
  return color;
}

let selectedLocation = null;
// Pick-on-map state
let pickMode = false;
let pickMarker = null;

// --- Recent locations ---
const MAX_RECENT = 10;
const RECENT_KEY = 'circle-triangulation-recent-locations';

function loadRecentLocations() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch { return []; }
}

function saveRecentLocations(locations) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(locations));
}

function addRecentLocation(loc) {
  // loc: { lat, lng, displayName, shortName }
  const locations = loadRecentLocations();
  // Remove duplicate if same coords (within ~10m)
  const filtered = locations.filter(l =>
    Math.abs(l.lat - loc.lat) > 0.0001 || Math.abs(l.lng - loc.lng) > 0.0001
  );
  filtered.unshift(loc);
  if (filtered.length > MAX_RECENT) filtered.length = MAX_RECENT;
  saveRecentLocations(filtered);
  renderRecentLocations();
}

function removeRecentLocation(index) {
  const locations = loadRecentLocations();
  locations.splice(index, 1);
  saveRecentLocations(locations);
  renderRecentLocations();
}

function renderRecentLocations() {
  const locations = loadRecentLocations();
  const container = document.getElementById('recent-locations');
  const list = document.getElementById('recent-list');

  if (locations.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = '';
  list.innerHTML = '';

  locations.forEach((loc, i) => {
    const item = document.createElement('div');
    item.className = 'recent-item';

    const text = document.createElement('span');
    text.className = 'recent-text';
    text.textContent = loc.shortName || loc.displayName;
    text.title = loc.displayName;

    const del = document.createElement('button');
    del.className = 'recent-delete';
    del.innerHTML = '&times;';
    del.title = 'Remove from history';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRecentLocation(i);
    });

    item.addEventListener('click', () => {
      addressInput.value = loc.shortName || loc.displayName;
      selectedLocation = { lat: loc.lat, lng: loc.lng, displayName: loc.displayName };
      setStatus(`Selected: ${loc.shortName || loc.displayName}`, 'info');
    });

    item.appendChild(text);
    item.appendChild(del);
    list.appendChild(item);
  });
}

const addressInput = document.getElementById('address');
const radiusInput = document.getElementById('radius');
const unitSelect = document.getElementById('unit');
const colorInput = document.getElementById('circle-color');
const previewBtn = document.getElementById('preview-btn');
const acceptBtn = document.getElementById('accept-btn');
const cancelBtn = document.getElementById('cancel-btn');
const statusEl = document.getElementById('status');
const circleListEl = document.getElementById('circle-list');
const showIntersectionsBtn = document.getElementById('show-intersections-btn');
const clearIntersectionsBtn = document.getElementById('clear-intersections-btn');
const intersectionInfoEl = document.getElementById('intersection-info');
const deleteModal = document.getElementById('delete-modal');
const deleteModalText = document.getElementById('delete-modal-text');
const deleteConfirm = document.getElementById('delete-confirm');
const deleteCancel = document.getElementById('delete-cancel');
const myLocationBtn = document.getElementById('my-location-btn');
const pickMapBtn = document.getElementById('pick-map-btn');
const analyzePopBtn = document.getElementById('analyze-pop-btn');
const clearPopBtn = document.getElementById('clear-pop-btn');
const populationInfoEl = document.getElementById('population-info');
let populationMarkers = [];

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

function clearStatus() {
  statusEl.textContent = '';
  statusEl.className = 'status';
}

function toMeters(value, unit) {
  switch (unit) {
    case 'mi': return value * 1609.344;
    case 'km': return value * 1000;
    case 'ft': return value * 0.3048;
    case 'm':  return value;
    default:   return value * 1000;
  }
}

function toDisplayUnit(meters, unit) {
  switch (unit) {
    case 'mi': return meters / 1609.344;
    case 'km': return meters / 1000;
    case 'ft': return meters / 0.3048;
    case 'm':  return meters;
    default:   return meters / 1000;
  }
}

async function geocode(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'CircleTriangulationApp/1.0' }
  });
  const data = await res.json();
  if (!data.length) throw new Error('Address not found');
  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
    displayName: data[0].display_name,
  };
}

async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'CircleTriangulationApp/1.0' }
  });
  const data = await res.json();
  return data.display_name || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function setSelectedLocation(lat, lng, displayName) {
  selectedLocation = { lat, lng, displayName };
}

function clearSelectedLocation() {
  selectedLocation = null;
}

// Clear selectedLocation when user manually edits the address field
addressInput.addEventListener('input', () => {
  clearSelectedLocation();
  removePickMarker();
});

// --- Use My Location ---
myLocationBtn.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    setStatus('Geolocation not supported.', 'error');
    return;
  }
  myLocationBtn.classList.add('loading');
  setStatus('Getting your location...', 'info');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      try {
        const displayName = await reverseGeocode(lat, lng);
        addressInput.value = displayName.split(',').slice(0, 3).join(',').trim();
        setSelectedLocation(lat, lng, displayName);
        setStatus('Location set.', 'info');
        map.setView([lat, lng], 12);
      } catch {
        addressInput.value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        setSelectedLocation(lat, lng, `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
        setStatus('Location set (reverse geocode failed).', 'info');
      }
      myLocationBtn.classList.remove('loading');
    },
    () => {
      setStatus('Location access denied.', 'error');
      myLocationBtn.classList.remove('loading');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// --- Pick on Map ---
function removePickMarker() {
  if (pickMarker) {
    map.removeLayer(pickMarker);
    pickMarker = null;
  }
}

function buildCoordPopup(lat, lng) {
  return `
    <div class="coord-popup-form">
      <label>Latitude</label>
      <input type="number" step="any" id="popup-lat" value="${lat.toFixed(6)}" />
      <label>Longitude</label>
      <input type="number" step="any" id="popup-lng" value="${lng.toFixed(6)}" />
      <button onclick="updatePickMarkerFromPopup()">Update</button>
    </div>
  `;
}

// Globally accessible so the popup button can call it
window.updatePickMarkerFromPopup = function () {
  const latInput = document.getElementById('popup-lat');
  const lngInput = document.getElementById('popup-lng');
  if (!latInput || !lngInput) return;
  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lngInput.value);
  if (isNaN(lat) || isNaN(lng)) return;
  if (pickMarker) {
    pickMarker.setLatLng([lat, lng]);
    pickMarker.closePopup();
    pickMarker.setPopupContent(buildCoordPopup(lat, lng));
  }
  setSelectedLocation(lat, lng, `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
  reverseGeocode(lat, lng).then(name => {
    const short = name.split(',').slice(0, 3).join(',').trim();
    addressInput.value = short;
    setSelectedLocation(lat, lng, name);
  }).catch(() => {
    addressInput.value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  });
};

function placePickMarker(lat, lng) {
  removePickMarker();
  pickMarker = L.marker([lat, lng], { draggable: true }).addTo(map);
  pickMarker.bindPopup(buildCoordPopup(lat, lng));

  pickMarker.on('dragend', async () => {
    const pos = pickMarker.getLatLng();
    pickMarker.setPopupContent(buildCoordPopup(pos.lat, pos.lng));
    setSelectedLocation(pos.lat, pos.lng, `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`);
    try {
      const name = await reverseGeocode(pos.lat, pos.lng);
      const short = name.split(',').slice(0, 3).join(',').trim();
      addressInput.value = short;
      setSelectedLocation(pos.lat, pos.lng, name);
    } catch {
      addressInput.value = `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`;
    }
  });
}

function enablePickMode() {
  pickMode = true;
  pickMapBtn.classList.add('active');
  pickMapBtn.textContent = '\u{1F5FA} Cancel Pick';
  document.getElementById('map').classList.add('pick-mode');
  setStatus('Click on the map to place circle center.', 'info');
}

function disablePickMode() {
  pickMode = false;
  pickMapBtn.classList.remove('active');
  pickMapBtn.textContent = '\u{1F5FA} Pick on Map';
  document.getElementById('map').classList.remove('pick-mode');
}

pickMapBtn.addEventListener('click', () => {
  if (pickMode) {
    disablePickMode();
    removePickMarker();
    clearSelectedLocation();
    clearStatus();
  } else {
    enablePickMode();
  }
});

map.on('click', async (e) => {
  // Meeting point pick mode takes priority
  if (meetPickMode) {
    const { lat, lng } = e.latlng;
    disableMeetPickMode();
    let name = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    addMeetPoint(lat, lng, name);
    try {
      // Update the name with a reverse geocode
      const fullName = await reverseGeocode(lat, lng);
      const pt = meetPoints[meetPoints.length - 1];
      if (pt) {
        pt.data.displayName = fullName;
        pt.data.address = fullName.split(',').slice(0, 3).join(',').trim();
        pt.marker.setPopupContent(
          `<strong>${pt.data.address}</strong><br><small>${lat.toFixed(5)}, ${lng.toFixed(5)}</small>`
        );
        renderMeetList();
      }
    } catch { /* keep coordinate fallback */ }
    return;
  }

  // Deselect circle when clicking on empty map
  if (selectedCircleId !== null && !pickMode) {
    deselectCircle();
    return;
  }
  if (!pickMode) return;
  const { lat, lng } = e.latlng;
  placePickMarker(lat, lng);
  setSelectedLocation(lat, lng, `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
  addressInput.value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  disablePickMode();
  setStatus('Point placed. Drag to adjust, or click marker to edit coords.', 'info');

  try {
    const name = await reverseGeocode(lat, lng);
    const short = name.split(',').slice(0, 3).join(',').trim();
    addressInput.value = short;
    setSelectedLocation(lat, lng, name);
  } catch { /* keep coordinate fallback */ }
});

function removePreview() {
  if (previewCircle) {
    map.removeLayer(previewCircle);
    previewCircle = null;
  }
  if (previewMarker) {
    map.removeLayer(previewMarker);
    previewMarker = null;
  }
  acceptBtn.disabled = true;
  cancelBtn.style.display = 'none';
}

previewBtn.addEventListener('click', async () => {
  const address = addressInput.value.trim();
  const radiusVal = parseFloat(radiusInput.value);
  const unit = unitSelect.value;

  if (!address && !selectedLocation) { setStatus('Enter an address or pick a point.', 'error'); return; }
  if (isNaN(radiusVal) || radiusVal <= 0) { setStatus('Enter a valid radius.', 'error'); return; }

  removePreview();

  let geo;
  try {
    if (selectedLocation) {
      geo = selectedLocation;
      setStatus('Using selected location...', 'info');
    } else {
      setStatus('Geocoding address...', 'info');
      geo = await geocode(address);
    }
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }

  const meters = toMeters(radiusVal, unit);
  const color = getNextColor();
  colorInput.value = color;

  // Hide pick marker while preview is showing
  removePickMarker();
  disablePickMode();

  previewCircle = L.circle([geo.lat, geo.lng], {
    radius: meters,
    color: color,
    fillColor: color,
    fillOpacity: 0.12,
    weight: 2,
    dashArray: '8 4',
  }).addTo(map);

  previewMarker = L.marker([geo.lat, geo.lng], {
    draggable: true,
    icon: L.divIcon({
      className: 'preview-center-icon',
      html: `<div style="
        width: 12px; height: 12px;
        background: ${color};
        border: 2px solid #fff;
        border-radius: 50%;
        box-shadow: 0 1px 4px rgba(0,0,0,0.3);
      "></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    }),
  }).addTo(map);

  previewCircle._previewData = {
    lat: geo.lat,
    lng: geo.lng,
    radiusMeters: meters,
    radiusDisplay: radiusVal,
    unit: unit,
    color: color,
    displayName: geo.displayName,
    address: address || geo.displayName.split(',').slice(0, 3).join(',').trim(),
  };

  // Drag the preview center to reposition the circle
  previewMarker.on('drag', (e) => {
    const newLatLng = e.target.getLatLng();
    previewCircle.setLatLng(newLatLng);
    previewCircle._previewData.lat = newLatLng.lat;
    previewCircle._previewData.lng = newLatLng.lng;
  });

  previewMarker.on('dragend', async (e) => {
    const pos = e.target.getLatLng();
    try {
      const name = await reverseGeocode(pos.lat, pos.lng);
      const short = name.split(',').slice(0, 3).join(',').trim();
      previewCircle._previewData.displayName = name;
      previewCircle._previewData.address = short;
      setStatus(`Preview moved to: ${short}`, 'info');
    } catch {
      const fallback = `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`;
      previewCircle._previewData.address = fallback;
      setStatus(`Preview moved to: ${fallback}`, 'info');
    }
  });

  map.fitBounds(previewCircle.getBounds().pad(0.2));
  setStatus(`Preview: ${geo.displayName.split(',').slice(0, 2).join(',')} — drag center to reposition`, 'info');
  acceptBtn.disabled = false;
  cancelBtn.style.display = '';
});

cancelBtn.addEventListener('click', () => {
  removePreview();
  removePickMarker();
  clearSelectedLocation();
  disablePickMode();
  clearStatus();
});

acceptBtn.addEventListener('click', () => {
  if (!previewCircle) return;
  const data = previewCircle._previewData;

  // Prevent duplicate circles (same center + radius)
  const isDuplicate = circles.some(c =>
    Math.abs(c.data.lat - data.lat) < 0.0001 &&
    Math.abs(c.data.lng - data.lng) < 0.0001 &&
    Math.abs(c.data.radiusMeters - data.radiusMeters) < 1
  );
  if (isDuplicate) {
    setStatus('A circle with this location and radius already exists.', 'error');
    return;
  }

  map.removeLayer(previewCircle);
  if (previewMarker) map.removeLayer(previewMarker);

  const circle = L.circle([data.lat, data.lng], {
    radius: data.radiusMeters,
    color: data.color,
    fillColor: data.color,
    fillOpacity: 0.08,
    weight: 2,
  }).addTo(map);

  const marker = L.circleMarker([data.lat, data.lng], {
    radius: 5,
    color: data.color,
    fillColor: data.color,
    fillOpacity: 1,
  }).addTo(map);

  const id = Date.now();
  marker.on('click', () => selectCircle(id));
  circles.push({ id, circle, marker, data });
  pushUndo({ type: 'add', id, index: circles.length - 1, data: { ...data } });

  // Save to recent locations
  const shortName = data.displayName.split(',').slice(0, 2).join(',').trim();
  addRecentLocation({
    lat: data.lat,
    lng: data.lng,
    displayName: data.displayName,
    shortName: shortName,
  });

  previewCircle = null;
  previewMarker = null;
  acceptBtn.disabled = true;
  cancelBtn.style.display = 'none';

  // Clean up pick/location state for next circle
  removePickMarker();
  clearSelectedLocation();
  disablePickMode();
  addressInput.value = '';

  renderCircleList();
  updateIntersectionButton();
  clearIntersections();
  clearPopulationMarkers();
  setStatus('Circle added!', 'info');
});

// --- Population density overlay ---

async function fetchAndDrawDensity(entry) {
  try {
    const res = await fetch(`${API_BASE}/density/sample-circle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: entry.data.lat,
        lng: entry.data.lng,
        radius_meters: entry.data.radiusMeters,
        num_samples: 360,
      }),
    });

    if (!res.ok) {
      setStatus('Circle added. (Population API unavailable)', 'info');
      return;
    }

    const result = await res.json();
    drawDensityOverlay(entry, result.samples, result.max_density);
    setStatus(`Circle added! ${Math.round(result.populated_ratio * 100)}% of edge is populated.`, 'info');
  } catch {
    // Backend not running — silently degrade
    setStatus('Circle added. (Start backend for population density)', 'info');
  }
}

function drawDensityOverlay(entry, samples, maxDensity) {
  // Remove any previous density overlay for this circle
  removeDensityOverlay(entry);

  if (!samples || samples.length < 2) return;

  const baseColor = entry.data.color;
  const overlayLayers = [];

  // Hide the original thin circle line — the overlay replaces it
  entry.circle.setStyle({ opacity: 0, fillOpacity: 0.04 });

  // Draw per-segment polylines: each segment connects two adjacent sample points
  // Uninhabited = thin, circle-colored; populated = thick, warm-colored
  for (let i = 0; i < samples.length; i++) {
    const s1 = samples[i];
    const s2 = samples[(i + 1) % samples.length];
    const avgDensity = (s1.density + s2.density) / 2;

    let weight, color, opacity;
    if (avgDensity > 0 && maxDensity > 0) {
      const norm = Math.min(avgDensity / maxDensity, 1);
      weight = 5 + norm * 9;           // 5–14px
      color = densityColor(norm);       // orange-red → magenta
      opacity = 0.85 + norm * 0.15;    // 0.85–1.0
    } else {
      weight = 2;
      color = baseColor;
      opacity = 0.4;
    }

    const line = L.polyline([[s1.lat, s1.lng], [s2.lat, s2.lng]], {
      color: color,
      weight: weight,
      opacity: opacity,
      lineCap: 'butt',
      lineJoin: 'round',
    }).addTo(map);

    if (avgDensity > 0) {
      line.bindPopup(`Density: ${avgDensity.toFixed(1)} people/pixel<br>Lat: ${s1.lat.toFixed(6)}<br>Lng: ${s1.lng.toFixed(6)}`);
    }

    overlayLayers.push(line);
  }

  // Store overlay layers on the entry so we can remove them later
  entry.densityOverlay = overlayLayers;
}

function removeDensityOverlay(entry) {
  if (entry.densityOverlay) {
    entry.densityOverlay.forEach(layer => map.removeLayer(layer));
    entry.densityOverlay = null;
    // Restore original circle line
    entry.circle.setStyle({ opacity: 1, fillOpacity: 0.08 });
  }
}

function changeCircleColor(entry, newColor) {
  entry.data.color = newColor;
  entry.circle.setStyle({ color: newColor, fillColor: newColor });
  entry.marker.setStyle({ color: newColor, fillColor: newColor });
  // Re-draw density overlay with new base color for unpopulated segments
  if (entry.densityOverlay) {
    entry.densityOverlay.forEach(layer => {
      // Only update the thin unpopulated segments (weight=2) to new color
      if (layer.options.weight === 2) {
        layer.setStyle({ color: newColor });
      }
    });
  }
}

function renderCircleList() {
  if (circles.length === 0) {
    circleListEl.innerHTML = '<p class="empty-msg">No circles yet.</p>';
    return;
  }
  circleListEl.innerHTML = '';
  circles.forEach(c => {
    const isSelected = c.id === selectedCircleId;
    const item = document.createElement('div');
    item.className = 'circle-item' + (isSelected ? ' selected' : '');

    const label = c.data.address.length > 25
      ? c.data.address.substring(0, 25) + '...'
      : c.data.address;

    // Color swatch + hidden picker
    const swatch = document.createElement('span');
    swatch.className = 'circle-swatch';
    swatch.style.background = c.data.color;
    swatch.title = 'Change color';

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'circle-color-picker';
    picker.value = c.data.color;
    picker.addEventListener('input', (e) => {
      const newColor = e.target.value;
      changeCircleColor(c, newColor);
      swatch.style.background = newColor;
      // Update drag marker if selected
      if (c._dragMarker) {
        c._dragMarker.setIcon(L.divIcon({
          className: 'preview-center-icon',
          html: `<div style="width:14px;height:14px;background:${newColor};border:3px solid #fff;border-radius:50%;box-shadow:0 0 6px rgba(0,0,0,0.4);"></div>`,
          iconSize: [14, 14], iconAnchor: [7, 7],
        }));
      }
    });
    picker.addEventListener('change', () => picker.blur());

    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      picker.click();
    });

    // Info row (clickable to select)
    const topRow = document.createElement('div');
    topRow.className = 'circle-top-row';

    const info = document.createElement('div');
    info.className = 'circle-info';
    info.innerHTML = `
      <div class="circle-label" title="${c.data.displayName}">${label}</div>
      <div class="circle-detail">${c.data.radiusDisplay} ${c.data.unit}</div>
    `;

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.innerHTML = '&times;';
    delBtn.title = 'Delete circle';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedCircleId === c.id) deselectCircle();
      deleteCircleById(c.id);
    });

    topRow.appendChild(swatch);
    topRow.appendChild(picker);
    topRow.appendChild(info);
    topRow.appendChild(delBtn);
    topRow.addEventListener('click', () => {
      if (isSelected) {
        deselectCircle();
      } else {
        selectCircle(c.id);
      }
    });

    item.appendChild(topRow);

    // Expanded editor when selected
    if (isSelected) {
      const editor = document.createElement('div');
      editor.className = 'circle-editor';

      // Radius + unit row
      const radiusRow = document.createElement('div');
      radiusRow.className = 'editor-row';

      const radiusLabel = document.createElement('label');
      radiusLabel.textContent = 'Radius';
      radiusLabel.className = 'editor-label';

      const radiusInput = document.createElement('input');
      radiusInput.type = 'number';
      radiusInput.className = 'editor-input';
      radiusInput.value = c.data.radiusDisplay;
      radiusInput.step = 'any';
      radiusInput.min = '0';

      const unitSel = document.createElement('select');
      unitSel.className = 'editor-select';
      ['mi', 'ft', 'km', 'm'].forEach(u => {
        const opt = document.createElement('option');
        opt.value = u;
        opt.textContent = u;
        if (u === c.data.unit) opt.selected = true;
        unitSel.appendChild(opt);
      });

      const applyRadius = () => {
        const val = parseFloat(radiusInput.value);
        if (isNaN(val) || val <= 0) return;
        const newUnit = unitSel.value;
        c.data.unit = newUnit;
        const newMeters = toMeters(val, newUnit);
        updateCircleRadius(c, newMeters);
      };

      radiusInput.addEventListener('change', applyRadius);
      unitSel.addEventListener('change', () => {
        // Convert displayed value to new unit
        const newUnit = unitSel.value;
        c.data.unit = newUnit;
        c.data.radiusDisplay = parseFloat(toDisplayUnit(c.data.radiusMeters, newUnit).toFixed(2));
        radiusInput.value = c.data.radiusDisplay;
      });

      // Stop click propagation so editing doesn't toggle selection
      radiusInput.addEventListener('click', e => e.stopPropagation());
      unitSel.addEventListener('click', e => e.stopPropagation());

      radiusRow.appendChild(radiusLabel);
      radiusRow.appendChild(radiusInput);
      radiusRow.appendChild(unitSel);

      // Coordinates display
      const coordInfo = document.createElement('div');
      coordInfo.className = 'editor-hint';
      coordInfo.textContent = `${c.data.lat.toFixed(5)}, ${c.data.lng.toFixed(5)} — drag marker to move`;

      editor.appendChild(radiusRow);
      editor.appendChild(coordInfo);
      item.appendChild(editor);
    }

    circleListEl.appendChild(item);
  });
}

// Modal handlers kept for backward compatibility but modal is no longer shown
deleteCancel.addEventListener('click', () => {
  deleteTarget = null;
  deleteModal.style.display = 'none';
});

function updateIntersectionButton() {
  showIntersectionsBtn.disabled = circles.length < 2;
  analyzePopBtn.disabled = circles.length < 1;
}

function clearIntersections() {
  intersectionMarkers.forEach(m => map.removeLayer(m));
  intersectionShapes.forEach(s => map.removeLayer(s));
  intersectionMarkers = [];
  intersectionShapes = [];
  intersectionInfoEl.innerHTML = '';
  clearIntersectionsBtn.style.display = 'none';
}

function circleIntersectionPoints(c1lat, c1lng, c1r, c2lat, c2lng, c2r) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const R = 6371000;

  const lat1 = c1lat * toRad, lng1 = c1lng * toRad;
  const lat2 = c2lat * toRad, lng2 = c2lng * toRad;

  const d = 2 * R * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2
  ));

  const r1 = c1r, r2 = c2r;

  if (d > r1 + r2) return [];
  if (d < Math.abs(r1 - r2)) return [];
  if (d === 0 && r1 === r2) return [];

  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));

  const bearing12 = Math.atan2(
    Math.sin(lng2 - lng1) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1)
  );

  const angDist = a / R;
  const midLat = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) +
    Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearing12)
  );
  const midLng = lng1 + Math.atan2(
    Math.sin(bearing12) * Math.sin(angDist) * Math.cos(lat1),
    Math.cos(angDist) - Math.sin(lat1) * Math.sin(midLat)
  );

  if (h < 0.01) {
    return [{ lat: midLat * toDeg, lng: midLng * toDeg }];
  }

  const perpBearing1 = bearing12 + Math.PI / 2;
  const perpBearing2 = bearing12 - Math.PI / 2;
  const hDist = h / R;

  const p1Lat = Math.asin(
    Math.sin(midLat) * Math.cos(hDist) +
    Math.cos(midLat) * Math.sin(hDist) * Math.cos(perpBearing1)
  );
  const p1Lng = midLng + Math.atan2(
    Math.sin(perpBearing1) * Math.sin(hDist) * Math.cos(midLat),
    Math.cos(hDist) - Math.sin(midLat) * Math.sin(p1Lat)
  );

  const p2Lat = Math.asin(
    Math.sin(midLat) * Math.cos(hDist) +
    Math.cos(midLat) * Math.sin(hDist) * Math.cos(perpBearing2)
  );
  const p2Lng = midLng + Math.atan2(
    Math.sin(perpBearing2) * Math.sin(hDist) * Math.cos(midLat),
    Math.cos(hDist) - Math.sin(midLat) * Math.sin(p2Lat)
  );

  return [
    { lat: p1Lat * toDeg, lng: p1Lng * toDeg },
    { lat: p2Lat * toDeg, lng: p2Lng * toDeg },
  ];
}

showIntersectionsBtn.addEventListener('click', async () => {
  clearIntersections();

  let totalPoints = 0;
  const allPoints = [];

  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i].data;
      const b = circles[j].data;
      const pts = circleIntersectionPoints(
        a.lat, a.lng, a.radiusMeters,
        b.lat, b.lng, b.radiusMeters
      );
      pts.forEach(pt => {
        allPoints.push(pt);
        totalPoints++;
      });
    }
  }

  if (totalPoints === 0) {
    intersectionInfoEl.innerHTML = '<p>No intersections found. Circles may not overlap.</p>';
    return;
  }

  // Try to enrich with population density from backend
  let densityData = null;
  try {
    const res = await fetch(`${API_BASE}/density/at-points`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: allPoints }),
    });
    if (res.ok) {
      const result = await res.json();
      densityData = result.points;
    }
  } catch { /* backend unavailable — draw without density */ }

  // Draw intersection markers, sized/colored by density if available
  for (let i = 0; i < allPoints.length; i++) {
    const pt = allPoints[i];
    const density = densityData ? densityData[i].density : null;
    const hasPopulation = density !== null && density > 0;

    const markerColor = hasPopulation ? '#ff4444' : '#888888';
    const markerRadius = hasPopulation ? 7 + Math.min(density / 5, 8) : 5;
    const fillOpacity = hasPopulation ? 0.9 : 0.3;

    const m = L.circleMarker([pt.lat, pt.lng], {
      radius: markerRadius,
      color: markerColor,
      fillColor: markerColor,
      fillOpacity: fillOpacity,
      weight: 2,
    }).addTo(map);

    let popupText = `Intersection<br>Lat: ${pt.lat.toFixed(6)}<br>Lng: ${pt.lng.toFixed(6)}`;
    if (density !== null) {
      popupText += `<br>Pop. density: ${density.toFixed(1)} people/pixel`;
      if (!hasPopulation) popupText += '<br><em>Uninhabited area</em>';
    }
    m.bindPopup(popupText);
    intersectionMarkers.push(m);
  }

  if (circles.length >= 3) {
    const clusterRadius = 5000;
    const clusters = findClusters(allPoints, clusterRadius);
    clusters.forEach(cluster => {
      if (cluster.length >= 2) {
        const avgLat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
        const avgLng = cluster.reduce((s, p) => s + p.lng, 0) / cluster.length;

        const triMarker = L.marker([avgLat, avgLng], {
          icon: L.divIcon({
            className: 'tri-marker',
            html: `<div style="
              background:#ff4444;
              color:#fff;
              font-weight:bold;
              font-size:11px;
              padding:3px 7px;
              border-radius:4px;
              white-space:nowrap;
              box-shadow:0 2px 6px rgba(0,0,0,0.3);
              border:2px solid #fff;
            ">&#x2316; Triangulation Point</div>`,
            iconSize: null,
            iconAnchor: [70, 12],
          }),
        }).addTo(map);
        triMarker.bindPopup(`Triangulation Zone<br>Lat: ${avgLat.toFixed(6)}<br>Lng: ${avgLng.toFixed(6)}<br>${cluster.length} nearby intersections`);
        intersectionMarkers.push(triMarker);
      }
    });
  }

  const populatedCount = densityData ? densityData.filter(d => d.density > 0).length : null;
  let infoText = `<p>${totalPoints} intersection point${totalPoints > 1 ? 's' : ''} found.</p>`;
  if (populatedCount !== null) {
    infoText += `<p>${populatedCount} in populated areas, ${totalPoints - populatedCount} in uninhabited areas.</p>`;
  }
  intersectionInfoEl.innerHTML = infoText;

  clearIntersectionsBtn.style.display = '';
});

function findClusters(points, radiusMeters) {
  if (points.length === 0) return [];
  const used = new Set();
  const clusters = [];
  const R = 6371000;

  for (let i = 0; i < points.length; i++) {
    if (used.has(i)) continue;
    const cluster = [points[i]];
    used.add(i);
    for (let j = i + 1; j < points.length; j++) {
      if (used.has(j)) continue;
      const toRad = Math.PI / 180;
      const dLat = (points[j].lat - points[i].lat) * toRad;
      const dLng = (points[j].lng - points[i].lng) * toRad;
      const a = Math.sin(dLat/2)**2 + Math.cos(points[i].lat*toRad)*Math.cos(points[j].lat*toRad)*Math.sin(dLng/2)**2;
      const d = 2 * R * Math.asin(Math.sqrt(a));
      if (d < radiusMeters) {
        cluster.push(points[j]);
        used.add(j);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

clearIntersectionsBtn.addEventListener('click', () => {
  clearIntersections();
});

addressInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') previewBtn.click();
});

radiusInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') previewBtn.click();
});

// --- Population Analysis ---

function densityColor(norm) {
  // Heat-map: orange-red (low) → deep red → bright magenta (high)
  // Designed to stand out strongly against map tiles
  // norm is 0..1 (fraction of max density)
  const r = 255;
  const g = Math.round(80 * (1 - norm));   // 80→0
  const b = Math.round(norm * 80);          // 0→80 (adds magenta at high density)
  return `rgb(${r},${g},${b})`;
}

function clearPopulationMarkers() {
  populationMarkers.forEach(m => map.removeLayer(m));
  populationMarkers = [];
  // Also clear density overlays on all circles
  circles.forEach(entry => removeDensityOverlay(entry));
  populationInfoEl.innerHTML = '';
  clearPopBtn.style.display = 'none';
}

analyzePopBtn.addEventListener('click', async () => {
  clearPopulationMarkers();

  if (circles.length === 0) return;

  analyzePopBtn.disabled = true;
  setStatus('Analyzing population density...', 'info');

  try {
    if (circles.length === 1) {
      // Single circle: sample all points around the edge
      await analyzeSingleCircle(circles[0]);
    } else {
      // Multiple circles: analyze intersection points
      await analyzeIntersections();
    }
  } catch (e) {
    setStatus('Population analysis failed. Is the backend running? (make backend)', 'error');
    console.error(e);
  }

  analyzePopBtn.disabled = false;
  clearPopBtn.style.display = '';
});

async function analyzeSingleCircle(entry) {
  const res = await fetch(`${API_BASE}/density/sample-circle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat: entry.data.lat,
      lng: entry.data.lng,
      radius_meters: entry.data.radiusMeters,
      num_samples: 720,
    }),
  });

  if (!res.ok) throw new Error('API error');
  const result = await res.json();

  drawDensityOverlay(entry, result.samples, result.max_density);

  const popPercent = Math.round(result.populated_ratio * 100);
  populationInfoEl.innerHTML = `<p>${popPercent}% of the circle edge crosses populated areas.</p><p>Click on highlighted segments for density details.</p>`;
  setStatus(`Population analysis complete. ${popPercent}% of edge is populated.`, 'info');
}

function clusterSamples(samples, distThreshold) {
  // Simple clustering: group consecutive (by angle) samples
  if (samples.length === 0) return [];
  const sorted = [...samples].sort((a, b) => a.angle - b.angle);
  const clusters = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const angleDiff = sorted[i].angle - sorted[i - 1].angle;
    if (angleDiff < 5) { // within 5 degrees = same cluster
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);

  // Merge first and last cluster if they wrap around 360°
  if (clusters.length > 1) {
    const firstStart = clusters[0][0].angle;
    const lastEnd = clusters[clusters.length - 1][clusters[clusters.length - 1].length - 1].angle;
    if ((360 - lastEnd + firstStart) < 5) {
      clusters[0] = clusters[clusters.length - 1].concat(clusters[0]);
      clusters.pop();
    }
  }

  return clusters;
}

async function analyzeIntersections() {
  // Compute all intersection points
  const allPoints = [];
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i].data;
      const b = circles[j].data;
      const pts = circleIntersectionPoints(
        a.lat, a.lng, a.radiusMeters,
        b.lat, b.lng, b.radiusMeters
      );
      allPoints.push(...pts);
    }
  }

  if (allPoints.length === 0) {
    populationInfoEl.innerHTML = '<p>No intersections found. Circles may not overlap.</p>';
    setStatus('No intersections to analyze.', 'info');
    return;
  }

  // Query density at intersection points
  const res = await fetch(`${API_BASE}/density/at-points`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: allPoints }),
  });

  if (!res.ok) throw new Error('API error');
  const result = await res.json();

  const maxDensity = Math.max(...result.points.map(p => p.density), 0.001);
  let populatedCount = 0;

  for (const pt of result.points) {
    const isPopulated = pt.density > 0;
    if (isPopulated) populatedCount++;

    const norm = pt.density / maxDensity;
    const color = isPopulated ? densityColor(norm) : '#888888';
    const radius = isPopulated ? 8 + norm * 10 : 5;
    const opacity = isPopulated ? 0.4 + norm * 0.6 : 0.2;

    const m = L.circleMarker([pt.lat, pt.lng], {
      radius: radius,
      color: color,
      fillColor: color,
      fillOpacity: opacity,
      weight: 2,
    }).addTo(map);

    let popup = `Lat: ${pt.lat.toFixed(6)}<br>Lng: ${pt.lng.toFixed(6)}`;
    if (isPopulated) {
      popup = `<strong>Populated intersection</strong><br>Density: ${pt.density.toFixed(1)} people/pixel<br>${popup}`;
    } else {
      popup = `<em>Uninhabited intersection</em><br>${popup}`;
    }
    m.bindPopup(popup);
    populationMarkers.push(m);
  }

  populationInfoEl.innerHTML = `<p>${allPoints.length} intersection point${allPoints.length > 1 ? 's' : ''} analyzed.</p><p><strong>${populatedCount} in populated areas</strong>, ${allPoints.length - populatedCount} in uninhabited areas.</p>`;
  setStatus(`Population analysis complete. ${populatedCount}/${allPoints.length} intersections are populated.`, 'info');
}

clearPopBtn.addEventListener('click', () => {
  clearPopulationMarkers();
  clearStatus();
});

// --- Dev Tools ---

function addCircleDirect(lat, lng, radiusMeters, color, address) {
  // Skip if duplicate
  const isDuplicate = circles.some(c =>
    Math.abs(c.data.lat - lat) < 0.0001 &&
    Math.abs(c.data.lng - lng) < 0.0001 &&
    Math.abs(c.data.radiusMeters - radiusMeters) < 1
  );
  if (isDuplicate) return null;

  const circle = L.circle([lat, lng], {
    radius: radiusMeters,
    color: color,
    fillColor: color,
    fillOpacity: 0.08,
    weight: 2,
  }).addTo(map);

  const marker = L.circleMarker([lat, lng], {
    radius: 5,
    color: color,
    fillColor: color,
    fillOpacity: 1,
  }).addTo(map);

  const unit = unitSelect.value;
  const radiusDisplay = parseFloat(toDisplayUnit(radiusMeters, unit).toFixed(2));
  const id = Date.now() + Math.random();
  marker.on('click', () => selectCircle(id));
  const data = {
    lat, lng, radiusMeters, color, address,
    displayName: address,
    radiusDisplay, unit,
  };
  circles.push({ id, circle, marker, data });
  pushUndo({ type: 'add', id, index: circles.length - 1, data: { ...data } });
  return id;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('#dev-add-test, #dev-clear-all');
  if (!btn) return;

  if (btn.id === 'dev-add-test') {
    const bounds = map.getBounds();
    const cLat = bounds.getCenter().lat;
    const cLng = bounds.getCenter().lng;

    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lngSpan = bounds.getEast() - bounds.getWest();
    const offset = lngSpan * 0.15;

    const R = 6371000;
    const viewMeters = (latSpan * Math.PI / 180) * R;
    const radius = viewMeters * 0.25;

    const c1 = getNextColor();
    const c2 = getNextColor();

    addCircleDirect(cLat, cLng - offset, radius, c1, `Test A (${cLat.toFixed(2)}, ${(cLng - offset).toFixed(2)})`);
    addCircleDirect(cLat, cLng + offset, radius, c2, `Test B (${cLat.toFixed(2)}, ${(cLng + offset).toFixed(2)})`);

    renderCircleList();
    updateIntersectionButton();
    clearIntersections();
    clearPopulationMarkers();
    setStatus('Added 2 test circles.', 'info');
  }

  if (btn.id === 'dev-clear-all') {
    while (circles.length > 0) {
      const entry = circles.pop();
      removeDensityOverlay(entry);
      map.removeLayer(entry.circle);
      map.removeLayer(entry.marker);
    }
    renderCircleList();
    updateIntersectionButton();
    clearIntersections();
    clearPopulationMarkers();
    setStatus('All circles cleared.', 'info');
  }
});

// --- Meeting Point Feature ---

const meetPoints = [];
let meetLines = [];
let meetMidMarker = null;
let meetPickMode = false;
let meetPickMarker = null;

const MEET_POINT_COLORS = [
  '#10b981', '#059669', '#34d399', '#047857', '#6ee7b7', '#065f46',
];
let meetColorIndex = 0;
function getNextMeetColor() {
  const c = MEET_POINT_COLORS[meetColorIndex % MEET_POINT_COLORS.length];
  meetColorIndex++;
  return c;
}

const meetAddressInput = document.getElementById('meet-address');
const meetLocationBtn = document.getElementById('meet-location-btn');
const meetPickBtn = document.getElementById('meet-pick-btn');
const meetAddBtn = document.getElementById('meet-add-btn');
const meetFindBtn = document.getElementById('meet-find-btn');
const meetClearBtn = document.getElementById('meet-clear-btn');
const meetListEl = document.getElementById('meet-list');
const meetInfoEl = document.getElementById('meet-info');

function addMeetPoint(lat, lng, displayName) {
  const color = getNextMeetColor();
  const marker = L.circleMarker([lat, lng], {
    radius: 7,
    color: color,
    fillColor: color,
    fillOpacity: 0.9,
    weight: 2,
  }).addTo(map);

  const address = displayName.split(',').slice(0, 3).join(',').trim();
  const id = Date.now() + Math.random();

  marker.bindPopup(`<strong>${address}</strong><br><small>${lat.toFixed(5)}, ${lng.toFixed(5)}</small>`);

  meetPoints.push({
    id,
    marker,
    data: { lat, lng, displayName, address, color },
  });

  renderMeetList();
  updateMeetButtons();
  clearMeetResult();
  setStatus(`Start point added: ${address}`, 'info');
}

function removeMeetPoint(id) {
  const idx = meetPoints.findIndex(p => p.id === id);
  if (idx === -1) return;
  map.removeLayer(meetPoints[idx].marker);
  meetPoints.splice(idx, 1);
  renderMeetList();
  updateMeetButtons();
  clearMeetResult();
}

function renderMeetList() {
  if (meetPoints.length === 0) {
    meetListEl.innerHTML = '<p class="empty-msg">No start points yet.</p>';
    return;
  }
  meetListEl.innerHTML = meetPoints.map((p, i) => `
    <div class="meet-item" data-meet-id="${p.id}">
      <span class="meet-swatch" style="background:${p.data.color}"></span>
      <div class="meet-info">
        <div class="meet-label">${i + 1}. ${p.data.address}</div>
        <div class="meet-detail">${p.data.lat.toFixed(5)}, ${p.data.lng.toFixed(5)}</div>
      </div>
      <button class="delete-btn meet-delete" title="Remove">&#x2715;</button>
    </div>
  `).join('');
}

// Delegated click handler for meet list items
meetListEl.addEventListener('click', (e) => {
  const delBtn = e.target.closest('.meet-delete');
  if (delBtn) {
    const item = delBtn.closest('.meet-item');
    const id = parseFloat(item.dataset.meetId);
    removeMeetPoint(id);
    return;
  }

  // Click on item to pan to that point
  const item = e.target.closest('.meet-item');
  if (item) {
    const id = parseFloat(item.dataset.meetId);
    const pt = meetPoints.find(p => p.id === id);
    if (pt) {
      map.panTo([pt.data.lat, pt.data.lng]);
      pt.marker.openPopup();
    }
  }
});

function updateMeetButtons() {
  meetFindBtn.disabled = meetPoints.length < 2;
}

function clearMeetResult() {
  meetLines.forEach(l => map.removeLayer(l));
  meetLines = [];
  if (meetMidMarker) {
    map.removeLayer(meetMidMarker);
    meetMidMarker = null;
  }
  meetClearBtn.style.display = 'none';
  meetInfoEl.innerHTML = '';
}

// Geographic midpoint using cartesian centroid on the unit sphere
function computeGeographicMidpoint(points) {
  let x = 0, y = 0, z = 0;
  for (const p of points) {
    const latR = p.lat * Math.PI / 180;
    const lngR = p.lng * Math.PI / 180;
    x += Math.cos(latR) * Math.cos(lngR);
    y += Math.cos(latR) * Math.sin(lngR);
    z += Math.sin(latR);
  }
  x /= points.length;
  y /= points.length;
  z /= points.length;

  const lngR = Math.atan2(y, x);
  const hyp = Math.sqrt(x * x + y * y);
  const latR = Math.atan2(z, hyp);

  return {
    lat: latR * 180 / Math.PI,
    lng: lngR * 180 / Math.PI,
  };
}

// OSRM routing helper
const OSRM_BASE = 'https://router.project-osrm.org';

function osrmProfile() {
  const mode = document.getElementById('meet-mode').value;
  if (mode === 'walking') return 'foot';
  if (mode === 'cycling') return 'bike';
  return 'car';
}

function modeLabel() {
  const mode = document.getElementById('meet-mode').value;
  if (mode === 'walking') return 'walking';
  if (mode === 'cycling') return 'cycling';
  return 'driving';
}

async function osrmRoute(from, to) {
  const profile = osrmProfile();
  const url = `${OSRM_BASE}/route/v1/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`OSRM error: ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 'Ok' || !data.routes.length) throw new Error('No route found');
  return data.routes[0]; // { geometry, duration, distance, legs }
}

// Decode OSRM route geometry into array of [lat, lng]
function routeToLatLngs(route) {
  return route.geometry.coordinates.map(c => [c[1], c[0]]);
}

// Find the point along a route polyline at a given fraction of total duration
function pointAlongRoute(route, fraction) {
  const coords = route.geometry.coordinates; // [lng, lat]
  const totalDist = route.distance; // meters
  const targetDist = totalDist * fraction;

  let accumulated = 0;
  for (let i = 1; i < coords.length; i++) {
    const segDist = haversineDistance(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
    if (accumulated + segDist >= targetDist) {
      // Interpolate within this segment
      const remaining = targetDist - accumulated;
      const t = segDist > 0 ? remaining / segDist : 0;
      const lat = coords[i-1][1] + t * (coords[i][1] - coords[i-1][1]);
      const lng = coords[i-1][0] + t * (coords[i][0] - coords[i-1][0]);
      return { lat, lng };
    }
    accumulated += segDist;
  }
  // Fallback: return endpoint
  const last = coords[coords.length - 1];
  return { lat: last[1], lng: last[0] };
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

async function showMeetingPoint() {
  clearMeetResult();
  if (meetPoints.length < 2) return;

  const coords = meetPoints.map(p => ({ lat: p.data.lat, lng: p.data.lng }));

  meetFindBtn.disabled = true;
  meetFindBtn.textContent = 'Calculating route...';
  meetInfoEl.innerHTML = '<p>Fetching routes from OSRM...</p>';

  try {
    if (meetPoints.length === 2) {
      await showTwoPointMidpoint(coords);
    } else {
      await showMultiPointMidpoint(coords);
    }
  } catch (err) {
    console.error('Routing error:', err);
    // Fall back to geographic midpoint
    meetInfoEl.innerHTML = `<p class="help-text">Routing failed (${err.message}). Showing geographic midpoint instead.</p>`;
    showGeographicFallback(coords);
  } finally {
    meetFindBtn.disabled = false;
    meetFindBtn.textContent = 'Find Meeting Point';
  }
}

async function showTwoPointMidpoint(coords) {
  const [a, b] = coords;

  // Get route A→B
  const route = await osrmRoute(a, b);
  const totalDuration = route.duration;
  const totalDistance = route.distance;

  // Find midpoint along route at 50% distance
  const mid = pointAlongRoute(route, 0.5);

  // Get routes from each point to midpoint for accurate times
  const [routeA, routeB] = await Promise.all([
    osrmRoute(a, mid),
    osrmRoute(b, mid),
  ]);

  // Draw the full route as two colored halves
  const routeALatLngs = routeToLatLngs(routeA);
  const routeBLatLngs = routeToLatLngs(routeB);

  const lineA = L.polyline(routeALatLngs, {
    color: meetPoints[0].data.color,
    weight: 4,
    opacity: 0.8,
  }).addTo(map);
  meetLines.push(lineA);

  const lineB = L.polyline(routeBLatLngs, {
    color: meetPoints[1].data.color,
    weight: 4,
    opacity: 0.8,
  }).addTo(map);
  meetLines.push(lineB);

  // Place midpoint marker
  placeMidpointMarker(mid, [
    { name: meetPoints[0].data.address, duration: routeA.duration, distance: routeA.distance },
    { name: meetPoints[1].data.address, duration: routeB.duration, distance: routeB.distance },
  ]);

  // Fit bounds to route
  const allLatLngs = [...routeALatLngs, ...routeBLatLngs];
  const bounds = L.latLngBounds(allLatLngs);
  map.fitBounds(bounds.pad(0.15));
}

async function showMultiPointMidpoint(coords) {
  // For 3+ points: start with geographic centroid, then use OSRM table
  // to find the nearby point minimizing max travel time.
  const geo = computeGeographicMidpoint(coords);

  // Generate a grid of candidate points around the centroid
  const offset = 0.05; // ~5km at mid-latitudes
  const candidates = [
    geo,
    { lat: geo.lat + offset, lng: geo.lng },
    { lat: geo.lat - offset, lng: geo.lng },
    { lat: geo.lat, lng: geo.lng + offset },
    { lat: geo.lat, lng: geo.lng - offset },
    { lat: geo.lat + offset * 0.7, lng: geo.lng + offset * 0.7 },
    { lat: geo.lat + offset * 0.7, lng: geo.lng - offset * 0.7 },
    { lat: geo.lat - offset * 0.7, lng: geo.lng + offset * 0.7 },
    { lat: geo.lat - offset * 0.7, lng: geo.lng - offset * 0.7 },
  ];

  meetInfoEl.innerHTML = '<p>Testing 9 candidate points...</p>';

  // Use OSRM table to get durations from all starts to all candidates
  const profile = osrmProfile();
  const allPoints = [...coords, ...candidates];
  const coordStr = allPoints.map(p => `${p.lng},${p.lat}`).join(';');
  const sourceIndices = coords.map((_, i) => i).join(';');
  const destIndices = candidates.map((_, i) => i + coords.length).join(';');

  const url = `${OSRM_BASE}/table/v1/${profile}/${coordStr}?sources=${sourceIndices}&destinations=${destIndices}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`OSRM table error: ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 'Ok') throw new Error('OSRM table failed');

  // data.durations[source_idx][dest_idx] = seconds
  // Find candidate minimizing the maximum duration from any source
  let bestIdx = 0;
  let bestMaxTime = Infinity;

  for (let c = 0; c < candidates.length; c++) {
    let maxTime = 0;
    for (let s = 0; s < coords.length; s++) {
      const t = data.durations[s][c];
      if (t === null) { maxTime = Infinity; break; }
      maxTime = Math.max(maxTime, t);
    }
    if (maxTime < bestMaxTime) {
      bestMaxTime = maxTime;
      bestIdx = c;
    }
  }

  const mid = candidates[bestIdx];

  // Get individual routes from each start to the best midpoint
  const routes = await Promise.all(
    coords.map((c, i) => osrmRoute(c, mid))
  );

  // Draw each route
  routes.forEach((route, i) => {
    const line = L.polyline(routeToLatLngs(route), {
      color: meetPoints[i].data.color,
      weight: 4,
      opacity: 0.8,
    }).addTo(map);
    meetLines.push(line);
  });

  // Place midpoint marker
  const durations = routes.map((r, i) => ({
    name: meetPoints[i].data.address,
    duration: r.duration,
    distance: r.distance,
  }));
  placeMidpointMarker(mid, durations);

  // Fit bounds
  const allLatLngs = routes.flatMap(r => routeToLatLngs(r));
  const bounds = L.latLngBounds(allLatLngs);
  map.fitBounds(bounds.pad(0.15));
}

function placeMidpointMarker(mid, durations) {
  const midIcon = L.divIcon({
    className: '',
    html: '<div class="midpoint-icon">★</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  meetMidMarker = L.marker([mid.lat, mid.lng], { icon: midIcon }).addTo(map);

  const mode = modeLabel();
  const popupHtml = `
    <strong>${mode.charAt(0).toUpperCase() + mode.slice(1)} Midpoint</strong><br>
    <small>${mid.lat.toFixed(5)}, ${mid.lng.toFixed(5)}</small><br>
    ${durations.map(d => `<small>${d.name}: ${formatDuration(d.duration)} (${formatDistance(d.distance)})</small>`).join('<br>')}
  `;
  meetMidMarker.bindPopup(popupHtml).openPopup();

  meetInfoEl.innerHTML = `
    <p><strong>${mode.charAt(0).toUpperCase() + mode.slice(1)} midpoint</strong></p>
    <p>${mid.lat.toFixed(5)}, ${mid.lng.toFixed(5)}</p>
    ${durations.map(d => `<p>${d.name}: <strong>${formatDuration(d.duration)}</strong> (${formatDistance(d.distance)})</p>`).join('')}
  `;

  meetClearBtn.style.display = '';
}

function showGeographicFallback(coords) {
  const mid = computeGeographicMidpoint(coords);

  meetPoints.forEach(p => {
    const line = L.polyline(
      [[p.data.lat, p.data.lng], [mid.lat, mid.lng]],
      { color: p.data.color, weight: 2, dashArray: '8, 6', opacity: 0.6 }
    ).addTo(map);
    meetLines.push(line);
  });

  const midIcon = L.divIcon({
    className: '',
    html: '<div class="midpoint-icon">★</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  meetMidMarker = L.marker([mid.lat, mid.lng], { icon: midIcon }).addTo(map);

  const distances = meetPoints.map(p => {
    const d = haversineDistance(p.data.lat, p.data.lng, mid.lat, mid.lng);
    return { name: p.data.address, distance: d };
  });

  meetMidMarker.bindPopup(`
    <strong>Geographic Midpoint (fallback)</strong><br>
    ${distances.map(d => `<small>${d.name}: ${formatDistance(d.distance)}</small>`).join('<br>')}
  `).openPopup();

  meetInfoEl.innerHTML += `
    ${distances.map(d => `<p>${d.name}: <strong>${formatDistance(d.distance)}</strong> (straight line)</p>`).join('')}
  `;

  meetClearBtn.style.display = '';
  const allPts = [...coords, mid];
  map.fitBounds(L.latLngBounds(allPts.map(p => [p.lat, p.lng])).pad(0.2));
}

// Haversine distance in meters
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  if (km < 10) return `${km.toFixed(1)} km (${(km * 0.621371).toFixed(1)} mi)`;
  return `${Math.round(km)} km (${Math.round(km * 0.621371)} mi)`;
}

// --- Meeting Point: Add start point ---

meetAddBtn.addEventListener('click', async () => {
  const input = meetAddressInput.value.trim();
  if (!input) {
    setStatus('Enter an address or use the map to add a start point.', 'error');
    return;
  }

  meetAddBtn.disabled = true;
  meetAddBtn.textContent = 'Geocoding...';

  try {
    const result = await geocode(input);
    addMeetPoint(result.lat, result.lng, result.displayName);
    meetAddressInput.value = '';
  } catch (err) {
    setStatus(`Could not find: ${input}`, 'error');
  } finally {
    meetAddBtn.disabled = false;
    meetAddBtn.textContent = 'Add Start Point';
  }
});

meetAddressInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    meetAddBtn.click();
  }
});

// Use my location for meeting point
meetLocationBtn.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    setStatus('Geolocation not available.', 'error');
    return;
  }
  meetLocationBtn.classList.add('loading');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      let name = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      try {
        name = await reverseGeocode(lat, lng);
      } catch { /* keep coords */ }
      addMeetPoint(lat, lng, name);
      meetLocationBtn.classList.remove('loading');
    },
    () => {
      setStatus('Could not get your location.', 'error');
      meetLocationBtn.classList.remove('loading');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// Pick on map for meeting point
function enableMeetPickMode() {
  meetPickMode = true;
  meetPickBtn.classList.add('active');
  meetPickBtn.textContent = '\u{1F5FA} Cancel Pick';
  document.getElementById('map').classList.add('pick-mode');
  setStatus('Click on the map to place a start point.', 'info');
}

function disableMeetPickMode() {
  meetPickMode = false;
  meetPickBtn.classList.remove('active');
  meetPickBtn.textContent = '\u{1F5FA} Pick on Map';
  document.getElementById('map').classList.remove('pick-mode');
}

meetPickBtn.addEventListener('click', () => {
  if (meetPickMode) {
    disableMeetPickMode();
    if (meetPickMarker) {
      map.removeLayer(meetPickMarker);
      meetPickMarker = null;
    }
    clearStatus();
  } else {
    // Cancel circle pick mode if active
    if (pickMode) {
      disablePickMode();
      removePickMarker();
      clearSelectedLocation();
    }
    enableMeetPickMode();
  }
});

// Find meeting point button
meetFindBtn.addEventListener('click', () => {
  showMeetingPoint();
});

// Clear meeting point button
meetClearBtn.addEventListener('click', () => {
  clearMeetResult();
  clearStatus();
});

// --- Global keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  // Escape: cancel meet pick, deselect circle, or cancel preview (works even in inputs)
  if (e.key === 'Escape') {
    if (meetPickMode) {
      disableMeetPickMode();
      clearStatus();
    } else if (selectedCircleId !== null) {
      deselectCircle();
    } else if (previewCircle) {
      cancelBtn.click();
    }
    return;
  }

  // Don't intercept shortcuts while typing in inputs
  if (inInput) return;

  // Cmd+Shift+Z / Ctrl+Shift+Z or Ctrl+Y: redo
  if ((e.metaKey || e.ctrlKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
    e.preventDefault();
    performRedo();
    return;
  }

  // Cmd+Z / Ctrl+Z: undo
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    performUndo();
    return;
  }

  // Enter: accept preview
  if (e.key === 'Enter' && previewCircle && !acceptBtn.disabled) {
    e.preventDefault();
    acceptBtn.click();
    return;
  }
});

// --- Init ---
renderRecentLocations();
