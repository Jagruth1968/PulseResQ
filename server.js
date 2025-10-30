
const express = require('express');
const app = express();
const PORT = 3000;
const axios = require('axios');
const fs = require('fs');
const path = require('path');
// 🧠 Simple in-memory cache
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

const rateLimit = require('express-rate-limit');
require('dotenv').config();


// load local backup hospitals
const LOCAL_HOSPITALS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data/hospitals.json'), 'utf8')
);


// Middleware to parse JSON body
app.use(express.json());

// 🚦 Rate limiter: limits each IP to 10 requests/min
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many requests, please try again later."
});
app.use(limiter);


// POST route for /api/alert
app.post('/api/alert', (req, res) => {
  const { device_id, heart_rate, gps } = req.body;

  console.log('Received alert:', req.body);

  // Example simple logic
  if (heart_rate > 120) {
    res.status(200).json({
      message: 'ALERT: High heart rate detected!',
      device_id,
      heart_rate,
      gps
    });
  } else {
    res.status(200).json({
      message: 'Heart rate normal.',
      device_id,
      heart_rate,
      gps
    });
  }
});



// Haversine distance (to calculate real-world distance between points)
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = v => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Detect if hospital has cardiac or heart-care keywords
function looksLikeCardiac(h) {
  const textFields = [];
  if (h.tags) {
    for (const k of Object.keys(h.tags)) {
      if (typeof h.tags[k] === 'string') textFields.push(h.tags[k].toLowerCase());
    }
  }
  if (h.name) textFields.push(String(h.name).toLowerCase());
  const keywords = ['cardio', 'cardiac', 'heart', 'cardiology', 'coronary', 'cath', 'cardiothoracic'];
  return textFields.some(s => keywords.some(kw => s.includes(kw)));
}



// Fetch hospitals from Overpass API (within radius in meters)
async function fetchHospitalsFromOverpass(lat, lon, radius = 8000) {
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="hospital"](around:${radius},${lat},${lon});
      way["amenity"="hospital"](around:${radius},${lat},${lon});
      relation["amenity"="hospital"](around:${radius},${lat},${lon});
    );
    out center tags;
  `;
  const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query);
  const resp = await axios.get(url, {
    timeout: 20000,
    headers: { 'User-Agent': 'PulseResQ/1.0 (student project; your@email.com)' }
  });

  const items = (resp.data.elements || [])
    .map(el => {
      const latLng =
        el.type === 'node'
          ? { lat: el.lat, lon: el.lon }
          : el.center
          ? { lat: el.center.lat, lon: el.center.lon }
          : {};
      return {
        id: el.id,
        type: el.type,
        name:
          (el.tags && el.tags.name) ||
          (el.tags && el.tags.operator) ||
          'Unknown Hospital',
        tags: el.tags || {},
        lat: latLng.lat,
        lon: latLng.lon
      };
    })
    .filter(h => h.lat && h.lon);
  return items;
}



async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const r = await axios.get(url, {
      headers: { 'User-Agent': 'PulseResQ/1.0 (student project; your@email.com)' },
      timeout: 10000
    });
    return r.data;
  } catch (e) {
    return null;
  }
}



// Default route (optional)
app.get('/', (req, res) => {
  res.send('PulseResQ API is running');
});


app.get("/realtime-hospital", async (req, res) => {
  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "Latitude and Longitude required" });
  }

  const cacheKey = `${lat},${lon}`;
  if (cache.has(cacheKey)) {
    console.log("📦 Cache hit!");
    return res.json({ source: "cache", ...cache.get(cacheKey) });
  }

  try {
    // ✅ Overpass API URL
    const overpassUrl = `https://overpass-api.de/api/interpreter?data=[out:json];node["amenity"="hospital"](around:8000,${lat},${lon});out;`;

    const overpassRes = await fetch(overpassUrl, {
      headers: { "User-Agent": "PulseResQ/1.0 (student project; contact: example@email.com)" },
    });
    const overpassData = await overpassRes.json();

    if (!overpassData.elements || overpassData.elements.length === 0) {
      return res.status(404).json({ message: "No hospitals found nearby." });
    }

    // ✅ Filter cardio hospitals
    const hospitals = overpassData.elements.filter(el =>
      el.tags && (
        (el.tags.name && /heart|cardio|hospital/i.test(el.tags.name)) ||
        (el.tags["healthcare:speciality"] && /cardio|heart/i.test(el.tags["healthcare:speciality"]))
      )
    );

    if (hospitals.length === 0) {
      return res.status(404).json({ message: "No IHD-capable hospitals nearby." });
    }

    // ✅ Find nearest
    const nearest = hospitals[0];
    const distanceKm = Math.sqrt(
      Math.pow(lat - nearest.lat, 2) + Math.pow(lon - nearest.lon, 2)
    ) * 111; // Rough conversion to km

    // ✅ Reverse geocode
    const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${nearest.lat}&lon=${nearest.lon}`;
    const nomRes = await fetch(nominatimUrl, {
      headers: { "User-Agent": "PulseResQ/1.0 (student project; contact: example@email.com)" },
    });
    const nomData = await nomRes.json();

    const result = {
      nearest: {
        name: nearest.tags.name || "Unnamed Hospital",
        address: nomData.display_name || "Address unavailable",
        lat: nearest.lat,
        lon: nearest.lon,
        distance_km: parseFloat(distanceKm.toFixed(2)),
      },
      found_at: new Date().toISOString(),
    };

    // ✅ Store in cache for 5 minutes
    cache.set(cacheKey, result);
    setTimeout(() => cache.delete(cacheKey), 5 * 60 * 1000);

    res.json({ source: "live", ...result });
  } catch (error) {
    console.error("❌ Error fetching hospital data:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to fetch hospital data",
      details: error.message,
    });
  }
});





// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// --- NEAREST HOSPITAL (Free Overpass API) ---
app.get('/nearest-hospital', async (req, res) => {
  try {
    const { lat, lon } = req.query; // latitude and longitude of patient
    const radius = 8000; // 8 km radius search

    // Query OpenStreetMap via Overpass API
    const query = `
      [out:json];
      node["amenity"="hospital"](around:${radius},${lat},${lon});
      out body;
    `;

    const response = await axios.get(
      `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`
    );

    const results = response.data.elements
      .filter(h => h.tags.name && /cardio|heart|hospital/i.test(h.tags.name))
      .map(h => ({
        name: h.tags.name,
        lat: h.lat,
        lon: h.lon,
        address: h.tags["addr:full"] || h.tags["addr:street"] || "Unknown address"
      }));

    if (results.length === 0) {
      return res.json({ message: "No nearby hospital with heart facilities found." });
    }

    // Haversine Distance Formula
    const calcDistance = (lat1, lon1, lat2, lon2) => {
      const R = 6371; // Earth radius (km)
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
          Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const ranked = results
      .map(h => ({
        ...h,
        distance_km: calcDistance(lat, lon, h.lat, h.lon)
      }))
      .sort((a, b) => a.distance_km - b.distance_km);

    res.json({
      nearest: ranked[0],
      alternatives: ranked.slice(1, 3)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching hospitals" });
  }
});
