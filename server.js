const express = require('express');
const app = express();
const PORT = 3000;

// Middleware to parse JSON body
app.use(express.json());

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

// Default route (optional)
app.get('/', (req, res) => {
  res.send('PulseResQ API is running');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
const axios = require('axios');

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
