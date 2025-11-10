// 🌍 PulseResQ – Real-Life Emergency Server (Batch Contact System)
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import fs from "fs";
import twilio from "twilio";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ⚙️ Rate limiter to prevent abuse
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests, try again later." }
}));

// ⚙️ Twilio setup
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ✅ Test Twilio credentials
console.log("🔧 Twilio Setup Check:");
console.log("SID:", process.env.TWILIO_ACCOUNT_SID);
console.log("TOKEN:", process.env.TWILIO_AUTH_TOKEN ? "Loaded ✅" : "Missing ❌");
console.log("FROM:", process.env.TWILIO_PHONE_NUMBER);
console.log("TO (demo):", process.env.VERIFIED_HOSPITAL_NUMBER);
console.log("-------------------------------------------\n");

// 📍 Fetch nearby hospitals (Overpass API)
async function fetchHospitals(lat, lon, radius = 8000) {
  const query = `
    [out:json];
    (
      node["amenity"="hospital"](around:${radius},${lat},${lon});
      way["amenity"="hospital"](around:${radius},${lat},${lon});
      relation["amenity"="hospital"](around:${radius},${lat},${lon});
    );
    out center;
  `;
  const resp = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`
  });

  const data = await resp.json();
  const hospitals = data.elements
    .filter(h => h.tags?.name)
    .map(h => ({
      id: h.id,
      name: h.tags.name,
      lat: h.lat || h.center?.lat,
      lon: h.lon || h.center?.lon,
    }));
  return hospitals.slice(0, 20); // limit to 20 hospitals for efficiency
}

// 📤 Send SMS through Twilio
async function sendSmsAlert(hospital, patientData) {
  try {
    const msg = await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: process.env.VERIFIED_HOSPITAL_NUMBER, // trial supports only verified
      body: `🚨 EMERGENCY ALERT 🚨
Patient: ${patientData.device_id}
ECG: ${patientData.ecg} | SpO₂: ${patientData.spo2}
Location: https://maps.google.com/?q=${patientData.location.lat},${patientData.location.lon}
Nearest Hospital: ${hospital.name}`
    });

    console.log(`✅ SMS sent to ${hospital.name} (${process.env.VERIFIED_HOSPITAL_NUMBER}) | SID: ${msg.sid}`);
    return true;
  } catch (error) {
    console.log(`❌ SMS failed to ${hospital.name}:`, error.message);
    return false;
  }
}

// 🏥 Emergency Alert Endpoint
app.post("/emergency-alert", async (req, res) => {
  try {
    const { device_id, location, ecg, spo2 } = req.body;
    console.log(`\n🚨 Emergency alert received from ${device_id}`);
    console.log(`📍 Coordinates: ${location.lat}, ${location.lon}`);

    const hospitals = await fetchHospitals(location.lat, location.lon);
    console.log(`🏥 Found ${hospitals.length} hospitals nearby.`);

    const patientData = { device_id, ecg, spo2, location };
    const log = [];

    // Process hospitals in batches of 3
    for (let i = 0; i < hospitals.length; i += 3) {
      const batch = hospitals.slice(i, i + 3);
      console.log(`📡 Sending batch ${i / 3 + 1}: ${batch.map(h => h.name).join(", ")}`);

      const results = await Promise.all(batch.map(h => sendSmsAlert(h, patientData)));

      const success = results.some(r => r === true);
      log.push({ batch: i / 3 + 1, success });

      if (success) {
        console.log(`✅ Accepted by batch ${i / 3 + 1}`);
        break;
      } else {
        console.log(`⚠️ No response from batch ${i / 3 + 1}, retrying next...`);
      }

      // Simulate small delay between batches
      await new Promise(res => setTimeout(res, 5000));
    }

    // Save logs
    fs.writeFileSync("alert_log.json", JSON.stringify(log, null, 2));
    res.json({ status: "success", message: "Emergency alerts sent", log });

  } catch (err) {
    console.error("🚨 Error in /emergency-alert:", err.message);
    res.status(500).json({ status: "failed", message: "Internal server error" });
  }
});

// 🌐 Root
app.get("/", (req, res) => {
  res.send("PulseResQ server is running 🩺");
});

// 🚀 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server active at http://localhost:${PORT}`));
