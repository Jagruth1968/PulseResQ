// === PULSE RESQ FINAL SERVER (v1.0) ===

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import cors from "cors";
import twilio from "twilio";
import nodemailer from "nodemailer";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 🚦 Rate limiter (anti-spam)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many requests, try again later.",
});
app.use(limiter);

// Twilio setup
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// 📧 Email setup (fallback for non-Twilio hospitals)
const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// 🧮 Distance calculation
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// === 1️⃣ NEAREST HOSPITAL FINDER ===
app.get("/nearest-hospital", async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: "Missing coordinates" });

    const overpassQuery = `
      [out:json];
      (
        node["amenity"="hospital"](around:8000,${lat},${lon});
        way["amenity"="hospital"](around:8000,${lat},${lon});
        relation["amenity"="hospital"](around:8000,${lat},${lon});
      );
      out center tags;
    `;

    const response = await axios.post(
      "https://overpass-api.de/api/interpreter",
      `data=${encodeURIComponent(overpassQuery)}`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const results = response.data.elements
      .map((el) => ({
        id: el.id,
        name: el.tags?.name || "Unknown Hospital",
        lat: el.lat || el.center?.lat,
        lon: el.lon || el.center?.lon,
        tags: el.tags || {},
      }))
      .filter((h) => h.lat && h.lon)
      .map((h) => ({
        ...h,
        distance_km: haversineKm(lat, lon, h.lat, h.lon),
      }))
      .sort((a, b) => a.distance_km - b.distance_km);

    res.json({ count: results.length, hospitals: results.slice(0, 30) });
  } catch (err) {
    console.error("Error fetching hospitals:", err.message);
    res.status(500).json({ error: "Failed to fetch hospitals" });
  }
});

// === 2️⃣ SMART NOTIFY HOSPITALS ROUTE ===
app.post("/notify-hospitals", async (req, res) => {
  const { hospitals, patient } = req.body;
  if (!Array.isArray(hospitals) || hospitals.length === 0) {
    return res.status(400).json({ error: "Hospital list is empty" });
  }

  console.log(`🚨 Alert triggered for patient ${patient.device_id}`);
  console.log(`Found ${hospitals.length} nearby hospitals.`);

  const chunked = [];
  for (let i = 0; i < hospitals.length; i += 3) chunked.push(hospitals.slice(i, i + 3));

  for (const [batchIndex, batch] of chunked.entries()) {
    console.log(`📡 Sending alert batch ${batchIndex + 1}...`);

    const responses = await Promise.allSettled(
      batch.map(async (h) => {
        if (h.webhook) {
          try {
            const resp = await axios.post(h.webhook, { patient }, { timeout: 5000 });
            if (resp.data.accepted) {
              console.log(`✅ ${h.name} accepted via webhook`);
              return h;
            }
          } catch {
            console.log(`⚠️ ${h.name} webhook failed`);
          }
        }

        // Fallback Twilio + email
        try {
          await Promise.all([
            twilioClient.messages.create({
              from: process.env.TWILIO_PHONE,
              to: process.env.ALTERNATE_NUMBER,
              body: `🚨 Emergency! Patient ${patient.device_id} needs help at ${patient.location.lat}, ${patient.location.lon}`,
            }),
            // twilioClient.calls.create({
            //   from: process.env.TWILIO_PHONE,
            //   to: process.env.ALTERNATE_NUMBER,
            //   url: "http://demo.twilio.com/docs/voice.xml",
            // }),
            // mailer.sendMail({
            //   from: process.env.EMAIL_USER,
            //   to: process.env.ALTERNATE_EMAIL,
            //   subject: "🚨 Emergency Alert",
            //   text: `PulseResQ Alert — Patient ${patient.device_id} requires immediate care at location (${patient.location.lat}, ${patient.location.lon}).`,
            // }),
          ]);
          console.log(`📞 Fallback alert sent to ${h.name}`);
        } catch (err) {
          console.log(`❌ Fallback failed for ${h.name}: ${err.message}`);
        }
        return null;
      })
    );

    const accepted = responses.map((r) => r.value).filter(Boolean)[0];
    if (accepted) {
      console.log(`🎯 Hospital selected: ${accepted.name}`);
      return res.json({
        status: "success",
        assigned_hospital: accepted.name,
        location: { lat: accepted.lat, lon: accepted.lon },
      });
    }

    console.log(`⏳ No response from batch ${batchIndex + 1}, moving to next...`);
  }

  console.log("❌ No hospitals responded after all batches.");
  res.status(504).json({ status: "failed", message: "No hospital accepted in time" });
});

// === 3️⃣ EMERGENCY ALERT MAIN ENDPOINT ===
app.post("/emergency-alert", async (req, res) => {
  try {
    const { device_id, location, ecg, spo2 } = req.body;
    if (!device_id || !location?.lat || !location?.lon) {
      return res.status(400).json({ error: "Missing device or location data" });
    }

    console.log("🚨 Received emergency alert:", req.body);

    const nearestRes = await axios.get(`http://localhost:${PORT}/nearest-hospital`, {
      params: { lat: location.lat, lon: location.lon },
    });

    const { hospitals } = nearestRes.data;
    const patientData = {
      device_id,
      ecg,
      spo2,
      timestamp: new Date().toISOString(),
      location,
    };

    const notifyRes = await axios.post(`http://localhost:${PORT}/notify-hospitals`, {
      hospitals,
      patient: patientData,
    });

    res.json({
      status: "success",
      message: "Emergency alert processed",
      assigned_hospital: notifyRes.data.assigned_hospital || null,
    });
  } catch (error) {
    console.error("🚨 Emergency alert error:", error.message);
    res.status(500).json({ status: "failed", message: "Internal server error" });
  }
});

// === 4️⃣ TEST SMS ROUTE ===
app.get("/test-sms", async (req, res) => {
  try {
    const message = await twilioClient.messages.create({
      body: "🚨 Test Alert: PulseResQ server is live and Twilio SMS works!",
      from: process.env.TWILIO_PHONE_NUMBER,
      to: process.env.ALTERNATE_NUMBER,
    });

    res.status(200).json({ success: true, sid: message.sid, status: message.status });
  } catch (error) {
    console.error("Twilio SMS Test Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Start Server
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
