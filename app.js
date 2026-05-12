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

// --- Undo system ---
const undoStack = [];
const MAX_UNDO = 50;

function pushUndo(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function undoAdd(action) {
  const idx = circles.findIndex(c => c.id === action.id);
  if (idx === -1) { setStatus('Nothing to undo.', 'info'); return; }
  map.removeLayer(circles[idx].circle);
  map.removeLayer(circles[idx].marker);
  circles.splice(idx, 1);
  renderCircleList();
  updateIntersectionButton();
  clearIntersections();
  setStatus('Undo: circle removed.', 'info');
}

function undoDelete(action) {
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
  circles.splice(insertIdx, 0, { id: action.id, circle, marker, data: { ...action.data } });
  renderCircleList();
  updateIntersectionButton();
  clearIntersections();
  setStatus('Undo: circle restored.', 'info');
}

function undoMove(action) {
  const entry = circles.find(c => c.id === action.id);
  if (!entry) { setStatus('Nothing to undo.', 'info'); return; }
  entry.circle.setLatLng([action.oldLat, action.oldLng]);
  entry.marker.setLatLng([action.oldLat, action.oldLng]);
  entry.data.lat = action.oldLat;
  entry.data.lng = action.oldLng;
  clearIntersections();
  setStatus('Undo: circle moved back.', 'info');
}

function performUndo() {
  if (undoStack.length === 0) {
    setStatus('Nothing to undo.', 'info');
    return;
  }
  const action = undoStack.pop();
  switch (action.type) {
    case 'add':    undoAdd(action);    break;
    case 'delete': undoDelete(action); break;
    case 'move':   undoMove(action);   break;
  }
}

// Selected location from "Use My Location" or "Pick on Map" — skips geocoding when set
let selectedLocation = null;
// Pick-on-map state
let pickMode = false;
let pickMarker = null;

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
  const color = colorInput.value;

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
  circles.push({ id, circle, marker, data });
  pushUndo({ type: 'add', id });

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
  setStatus('Circle added!', 'info');
});

function renderCircleList() {
  if (circles.length === 0) {
    circleListEl.innerHTML = '<p class="empty-msg">No circles yet.</p>';
    return;
  }
  circleListEl.innerHTML = '';
  circles.forEach(c => {
    const item = document.createElement('div');
    item.className = 'circle-item';
    const label = c.data.address.length > 25
      ? c.data.address.substring(0, 25) + '...'
      : c.data.address;
    item.innerHTML = `
      <span class="circle-swatch" style="background:${c.data.color}"></span>
      <div class="circle-info">
        <div class="circle-label" title="${c.data.displayName}">${label}</div>
        <div class="circle-detail">${c.data.radiusDisplay} ${c.data.unit}</div>
      </div>
      <button class="delete-btn" data-id="${c.id}" title="Delete circle">&times;</button>
    `;
    circleListEl.appendChild(item);
  });

  circleListEl.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = parseInt(e.target.dataset.id);
      const entry = circles.find(c => c.id === id);
      if (!entry) return;
      deleteTarget = id;
      deleteModalText.textContent = `Delete the circle at "${entry.data.address}" (${entry.data.radiusDisplay} ${entry.data.unit})?`;
      deleteModal.style.display = 'flex';
    });
  });
}

deleteConfirm.addEventListener('click', () => {
  if (deleteTarget == null) return;
  const idx = circles.findIndex(c => c.id === deleteTarget);
  if (idx !== -1) {
    pushUndo({ type: 'delete', id: circles[idx].id, index: idx, data: { ...circles[idx].data } });
    map.removeLayer(circles[idx].circle);
    map.removeLayer(circles[idx].marker);
    circles.splice(idx, 1);
    renderCircleList();
    updateIntersectionButton();
    clearIntersections();
  }
  deleteTarget = null;
  deleteModal.style.display = 'none';
});

deleteCancel.addEventListener('click', () => {
  deleteTarget = null;
  deleteModal.style.display = 'none';
});

function updateIntersectionButton() {
  showIntersectionsBtn.disabled = circles.length < 2;
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

showIntersectionsBtn.addEventListener('click', () => {
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

      if (pts.length > 0) {
        const lineColor = '#ff4444';
        pts.forEach(pt => {
          allPoints.push(pt);
          const m = L.circleMarker([pt.lat, pt.lng], {
            radius: 7,
            color: lineColor,
            fillColor: '#ff4444',
            fillOpacity: 0.9,
            weight: 2,
          }).addTo(map);
          m.bindPopup(`Intersection<br>Lat: ${pt.lat.toFixed(6)}<br>Lng: ${pt.lng.toFixed(6)}`);
          intersectionMarkers.push(m);
          totalPoints++;
        });
      }
    }
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

  if (totalPoints === 0) {
    intersectionInfoEl.innerHTML = '<p>No intersections found. Circles may not overlap.</p>';
  } else {
    intersectionInfoEl.innerHTML = `<p>${totalPoints} intersection point${totalPoints > 1 ? 's' : ''} found.</p>`;
  }

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

// --- Global keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  const modalOpen = deleteModal.style.display === 'flex';

  // Escape: close modal or cancel preview (works even in inputs)
  if (e.key === 'Escape') {
    if (modalOpen) {
      deleteCancel.click();
    } else if (previewCircle) {
      cancelBtn.click();
    }
    return;
  }

  // Don't intercept shortcuts while typing in inputs
  if (inInput) return;

  // Cmd+Z / Ctrl+Z: undo
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
    if (modalOpen) return;
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
