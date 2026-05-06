const map = L.map('map').setView([39.8283, -98.5795], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

const circles = [];
let previewCircle = null;
let previewMarker = null;
let intersectionMarkers = [];
let intersectionShapes = [];
let deleteTarget = null;

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

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

function clearStatus() {
  statusEl.textContent = '';
  statusEl.className = 'status';
}

function toMeters(value, unit) {
  return unit === 'mi' ? value * 1609.344 : value * 1000;
}

function toDisplayUnit(meters, unit) {
  return unit === 'mi' ? meters / 1609.344 : meters / 1000;
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

  if (!address) { setStatus('Enter an address.', 'error'); return; }
  if (isNaN(radiusVal) || radiusVal <= 0) { setStatus('Enter a valid radius.', 'error'); return; }

  removePreview();
  setStatus('Geocoding address...', 'info');

  try {
    const geo = await geocode(address);
    const meters = toMeters(radiusVal, unit);
    const color = colorInput.value;

    previewCircle = L.circle([geo.lat, geo.lng], {
      radius: meters,
      color: color,
      fillColor: color,
      fillOpacity: 0.12,
      weight: 2,
      dashArray: '8 4',
    }).addTo(map);

    previewMarker = L.circleMarker([geo.lat, geo.lng], {
      radius: 5,
      color: color,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(map);

    previewCircle._previewData = {
      lat: geo.lat,
      lng: geo.lng,
      radiusMeters: meters,
      radiusDisplay: radiusVal,
      unit: unit,
      color: color,
      displayName: geo.displayName,
      address: address,
    };

    map.fitBounds(previewCircle.getBounds().pad(0.2));
    setStatus(`Preview: ${geo.displayName.split(',').slice(0, 2).join(',')}`, 'info');
    acceptBtn.disabled = false;
    cancelBtn.style.display = '';
  } catch (e) {
    setStatus(e.message, 'error');
  }
});

cancelBtn.addEventListener('click', () => {
  removePreview();
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

  previewCircle = null;
  previewMarker = null;
  acceptBtn.disabled = true;
  cancelBtn.style.display = 'none';

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
