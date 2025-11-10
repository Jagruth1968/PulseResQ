// 🌍 PulseResQ — DEMO SERVER (Fully Offline Safe)
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Rate Limiter to avoid spam
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: "Too many requests, please slow down." },
  })
);

// Utility: simulate delay
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// 🌎 Route: Geocoding (still real)
app.get("/geocode", async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: "Missing address" });
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${address}`
    );
    const data = await response.json();
    res.json({
      latitude: data[0].lat,
      longitude: data[0].lon,
      address: data[0].display_name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🏥 Route: Nearest Hospitals using Overpass API
app.get("/nearest-hospital", async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) {
      return res.status(400).json({ error: "Missing coordinates" });
    }

    const query = `
      [out:json];
      (
        node["amenity"="hospital"](around:5000,${lat},${lon});
        way["amenity"="hospital"](around:5000,${lat},${lon});
        relation["amenity"="hospital"](around:5000,${lat},${lon});
      );
      out center;
    `;
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });
    const data = await response.json();

    const hospitals = data.elements.slice(0, 5).map((h) => ({
      name: h.tags?.name || "Unnamed Hospital",
      lat: h.lat || h.center?.lat,
      lon: h.lon || h.center?.lon,
    }));

    res.json({ count: hospitals.length, hospitals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🚨 DEMO Emergency Alert
app.post("/emergency-alert", async (req, res) => {
  try {
    const { device_id, location, ecg, spo2 } = req.body;

    console.log("\n🚨 Alert triggered for patient", device_id);
    console.log(
      `📍 Location: (${location.lat}, ${location.lon}) | ❤️ ECG: ${ecg} | SpO2: ${spo2}`
    );

    // Fetch nearby hospitals (real)
    const query = `
      [out:json];
      (
        node["amenity"="hospital"](around:5000,${location.lat},${location.lon});
      );
      out center;
    `;
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });
    const data = await response.json();
    const hospitals = data.elements.slice(0, 5).map((el) => ({
      name: el.tags?.name || "Unnamed Hospital",
      lat: el.lat || el.center?.lat,
      lon: el.lon || el.center?.lon,
    }));

    console.log(`\n🏥 Found ${hospitals.length} nearby hospitals.`);
    console.log("📡 Sending alerts to hospitals...\n");

    // 🧩 Simulate hospital alerts
    for (const hospital of hospitals) {
      await delay(1200);
      console.log(`📤 Alert sent to ${hospital.name}... ✅ (Simulated)`);
    }

    console.log("\n📞 Simulating Twilio SMS...");
    await delay(1500);
    console.log("📨 Message: 🚨 Emergency alert for patient", device_id);
    console.log("➡️ Sent to: +91XXXXXXXXXX (Simulated Verified Number)");

    console.log("\n📩 Simulating Email notification...");
    await delay(1500);
    console.log(
      "✉️ Email sent to: emergency.alert@hospitaldemo.com (Simulated)"
    );

    console.log("\n✅ All simulated alerts completed successfully.");

    res.json({
      status: "success",
      message: "Demo alerts simulated successfully.",
      sent_to: hospitals.map((h) => h.name),
    });
  } catch (err) {
    console.error("❌ Demo alert error:", err.message);
    res.status(500).json({ status: "failed", error: err.message });
  }
});

// 🌐 Server start
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n✅ PulseResQ DEMO SERVER running at http://localhost:${PORT}`);
  console.log("🧠 All alerts, calls & emails are simulated for presentation.\n");
});
