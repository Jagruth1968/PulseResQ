// ---------- Replace/insert these functions & routes into server.js ----------

// 🌍 PulseResQ Server (ESM Compatible)
// ✅ Import section
import express from "express";
import fs from "fs";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import twilio from "twilio";
import path from "path";
import { fileURLToPath } from "url";

// ✅ ES Module path fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Initialize environment & app
dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// ✅ Confirm environment loaded
console.log("✅ Environment variables loaded successfully");


const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE,
  EMAIL_USER,
  EMAIL_PASS
} = process.env;

// Twilio client
const twClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// Nodemailer transporter (Gmail example)
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// Utility: send webhook POST to hospital (if it exposes webhook)
async function sendWebhook(hospital, payload, timeout = 5000) {
  if (!hospital.webhook) return null;
  try {
    const resp = await axios.post(hospital.webhook, payload, { timeout });
    // expect { accepted: true } or similar from hospital webhook
    if (resp && resp.data && resp.data.accepted) return { accepted: true, hospital, raw: resp.data };
    return { accepted: false, hospital, raw: resp.data };
  } catch (err) {
    // treat as not accepted / no response
    return { accepted: false, hospital, error: err.message || 'no-response' };
  }
}

// Utility: send SMS (Twilio)
async function sendSms(hospital, message) {
  if (!twClient) return { ok: false, reason: 'no-twilio-client' };
  try {
    const to = hospital.phone || hospital.phone_number || hospital.tel;
    if (!to) return { ok: false, reason: 'no-phone' };
    const m = await twClient.messages.create({
      body: message,
      from: TWILIO_PHONE,
      to
    });
    return { ok: true, sid: m.sid };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Utility: send WhatsApp (Twilio). Requires Twilio WhatsApp sandbox or approved number
async function sendWhatsapp(hospital, message) {
  if (!twClient) return { ok: false, reason: 'no-twilio-client' };
  const toPhone = hospital.phone || hospital.phone_number || hospital.tel;
  if (!toPhone) return { ok: false, reason: 'no-phone' };
  try {
    const m = await twClient.messages.create({
      from: `whatsapp:${TWILIO_PHONE}`, // twilio sandbox or WhatsApp-enabled number
      to: `whatsapp:${toPhone}`,
      body: message
    });
    return { ok: true, sid: m.sid };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Utility: make a voice call with TwiML message (simple "we need help" message)
async function makeVoiceCall(hospital, twimlMessage) {
  if (!twClient) return { ok: false, reason: 'no-twilio-client' };
  const to = hospital.phone || hospital.phone_number || hospital.tel;
  if (!to) return { ok: false, reason: 'no-phone' };
  try {
    const call = await twClient.calls.create({
      to,
      from: TWILIO_PHONE,
      twiml: `<Response><Say voice="alice">${twimlMessage}</Say></Response>`
    });
    return { ok: true, sid: call.sid };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Utility: send email fallback
async function sendEmail(hospital, subject, text) {
  if (!EMAIL_USER || !EMAIL_PASS) return { ok: false, reason: 'no-email-credentials' };
  const to = (hospital.email || hospital.contact_email);
  if (!to) return { ok: false, reason: 'no-email' };
  try {
    const info = await mailer.sendMail({
      from: EMAIL_USER,
      to,
      subject,
      text
    });
    return { ok: true, info };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Primary notify helper — attempts webhooks first (parallel), if none accept -> fallback notify
// returns { acceptedHospital, attempts: [ ... ] }
async function notifyHospitalsPhased(hospitals, patient, options = {}) {
  // hospitals must be array of objects { name, lat, lon, phone, webhook, email }
  // Create batches of `batchSize` (default 3) and try each batch sequentially.
  const batchSize = options.batchSize || 3;
  const webhookTimeout = options.webhookTimeout || 5000; // ms to wait for webhook response per POST
  const waitForAcceptanceMs = options.waitForAcceptanceMs || 90_000; // overall wait for the batch to accept
  const fallbackMessage = options.fallbackMessage ||
    `EMERGENCY: patient at ${patient.location?.lat},${patient.location?.lon} requires urgent help. Device ${patient.device_id || 'unknown'}. ECG: ${patient.ecg || 'n/a'}, SpO2: ${patient.spo2 || 'n/a'}. Please respond.`;

  const attemptsLog = [];

  for (let i = 0; i < hospitals.length; i += batchSize) {
    const batch = hospitals.slice(i, i + batchSize);
    console.log(`📡 Notifying batch ${Math.floor(i / batchSize) + 1} (size ${batch.length})`);

    // 1) Fire webhook posts in parallel
    const webhookPromises = batch.map(h => sendWebhook(h, { patient }, webhookTimeout));
    // Wait for all to settle but also watch for an accepted result during the wait
    const settled = await Promise.all(webhookPromises);
    // Log attempts
    settled.forEach(s => attemptsLog.push({ channel: 'webhook', hospital: s.hospital, accepted: !!s.accepted, raw: s.raw || s.error || null }));

    // Check if any accepted
    const acceptedEntry = settled.find(s => s.accepted);
    if (acceptedEntry) {
      console.log(`✅ Hospital accepted via webhook: ${acceptedEntry.hospital.name}`);
      return { acceptedHospital: acceptedEntry.hospital, attempts: attemptsLog };
    }

    // 2) No webhook acceptance — send fallback notifications (SMS/Whatsapp/Call/Email)
    // We'll send them in parallel but don't treat them as 'acceptance' (acceptance must be via webhook)
    const notifyPromises = batch.map(async (h) => {
      const sms = await sendSms(h, fallbackMessage).catch(e => ({ ok: false, reason: e.message }));
      const wa = await sendWhatsapp(h, fallbackMessage).catch(e => ({ ok: false, reason: e.message }));
      const call = await makeVoiceCall(h, `Emergency! Please respond. Patient location latitude ${patient.location?.lat}, longitude ${patient.location?.lon}.`);
      const email = await sendEmail(h, 'Emergency Alert - Immediate Assistance Required', `${fallbackMessage}\n\nHospital: ${h.name}`);
      const result = { hospital: h, sms, whatsapp: wa, call, email };
      attemptsLog.push({ channel: 'fallback', hospital: h, result });
      return result;
    });

    await Promise.allSettled(notifyPromises);

    // 3) Wait a short period for webhooks to respond (hospitals might POST back)
    console.log(`⏳ Waiting ${waitForAcceptanceMs/1000}s for any acceptance from batch ${Math.floor(i / batchSize) + 1}...`);
    // Polling approach: we'll wait and periodically check an in-memory acceptances map (if you implement it).
    // For now: simply sleep for the wait time while webhooks could POST to your /hospital-ack endpoint.
    await new Promise(r => setTimeout(r, waitForAcceptanceMs));

    // OPTIONAL: If you implement a separate /hospital-ack endpoint that writes to an in-memory map `acceptedMap`,
    // you could check it here and return early. Example check (if implemented):
    // if (acceptedMap[patient.device_id]) return { acceptedHospital: acceptedMap[patient.device_id], attempts: attemptsLog };

    console.log(`↪️ No acceptance from batch ${Math.floor(i / batchSize) + 1}; moving to next batch (if any).`);
  }

  // If we reached here, none accepted
  return { acceptedHospital: null, attempts: attemptsLog, message: 'No hospital accepted the alert' };
}


// --- Route: /notify-hospitals (internal) ---
// Expects body: { nearest: {...}, alternatives: [...], patient: {...} }
app.post('/notify-hospitals', async (req, res) => {
  try {
    const { nearest, alternatives = [], patient } = req.body;
    if (!nearest || !patient) return res.status(400).json({ error: 'Missing nearest hospital or patient' });

    // Build hospital list (nearest first)
    const hospitals = [nearest, ...alternatives].slice(0, 50); // limit to 50 to avoid wild notifications
    const result = await notifyHospitalsPhased(hospitals, patient, {
      batchSize: 3,
      webhookTimeout: 5000,
      waitForAcceptanceMs: 90_000
    });

    if (result.acceptedHospital) {
      return res.json({ status: 'success', accepted_hospital: result.acceptedHospital, attempts: result.attempts });
    } else {
      return res.status(504).json({ status: 'failed', message: 'No hospital accepted the alert', attempts: result.attempts });
    }
  } catch (err) {
    console.error('Error in /notify-hospitals:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// 🏥 2️⃣ Nearest Hospital Finder (using Overpass API + Distance Filter)
app.get("/nearest-hospital", async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) {
      return res.status(400).json({ error: "Missing latitude or longitude" });
    }

    console.log(`🔍 Searching hospitals near: ${lat}, ${lon}`);

    // Overpass query for hospitals within 5 km
    const overpassQuery = `
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
      body: `data=${encodeURIComponent(overpassQuery)}`
    });

    const data = await response.json();
    if (!data.elements || data.elements.length === 0) {
      return res.status(404).json({ message: "No hospitals found nearby" });
    }

    // Function to calculate distance using Haversine formula
    function haversine(lat1, lon1, lat2, lon2) {
      const toRad = (x) => (x * Math.PI) / 180;
      const R = 6371; // km
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
          Math.cos(toRad(lat2)) *
          Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Map hospitals + calculate distance
    const hospitals = data.elements
      .map((el) => {
        const name =
          el.tags?.name || el.tags?.["official_name"] || "Unnamed Hospital";
        const lat2 = el.lat || el.center?.lat;
        const lon2 = el.lon || el.center?.lon;
        const distance = haversine(lat, lon, lat2, lon2);
        return { name, lat: lat2, lon: lon2, distance };
      })
      .filter((h) => h.lat && h.lon)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3); // ✅ Only 3 closest

    console.log(`✅ Found ${hospitals.length} nearest hospitals`);
    res.json({ count: hospitals.length, hospitals });
  } catch (err) {
    console.error("❌ Error fetching hospitals:", err.message);
    res.status(500).json({ status: "failed", message: "Error finding hospitals" });
  }
});

// === Test Route for Twilio SMS ===


const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.get('/test-sms', async (req, res) => {
  try {
    const message = await client.messages.create({
      body: '🚨 Test Alert: PulseResQ server is live and Twilio SMS is working perfectly!',
      from: process.env.TWILIO_PHONE,
      to: '+916360049318' // Replace this with your verified number
    });

    res.status(200).json({
      success: true,
      sid: message.sid,
      status: message.status
    });
  } catch (error) {
    console.error('Twilio SMS Test Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
