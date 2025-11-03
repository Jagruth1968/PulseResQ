// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const Twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio client (optional — requires .env filled)
let twilioClient = null;
try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
} catch (e) {
  console.warn('Twilio init failed:', e.message);
}

// Nodemailer transporter (optional — requires .env EMAIL_USER / EMAIL_PASS)
let mailTransporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
}

app.use(cors());
app.use(express.json());

// simple rate limiter
app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));

// local fallback hospitals file
const LOCAL_HOSPITALS_PATH = path.join(__dirname, 'data', 'hospitals.json');
let LOCAL_HOSPITALS = [];
try {
  LOCAL_HOSPITALS = JSON.parse(fs.readFileSync(LOCAL_HOSPITALS_PATH, 'utf8'));
} catch (e) {
  console.warn('Could not read local hospitals.json, continuing with empty fallback.');
}

// simple in-memory cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ---------- utilities ----------
function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// haversine in km
function haversineKm(aLat, aLon, bLat, bLon) {
  const toRad = v => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const A =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(A), Math.sqrt(1 - A));
}

// detect cardiac hospital by tags/name
function looksLikeCardiac(h) {
  const keywords = ['cardio', 'cardiac', 'heart', 'cardiology', 'coronary', 'cath'];
  const name = (h.name || '') + ' ' + (h.tags && (h.tags.healthcare || h.tags.operator || '') || '');
  const text = String(name).toLowerCase();
  return keywords.some(k => text.includes(k));
}

// polite axios headers for Overpass/Nominatim
const defaultHeaders = { 'User-Agent': 'PulseResQ/1.0 (student project; contact: your@email.com)' };

// ---------- Overpass + Nominatim fetch ----------
async function fetchHospitalsFromOverpass(lat, lon, radius = 8000) {
  // build Overpass query: nodes / ways / relations with amenity=hospital
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

  const resp = await axios.get(url, { headers: defaultHeaders, timeout: 20000 });
  const els = resp.data.elements || [];
  const items = els
    .map(el => {
      const latLon = el.type === 'node' ? { lat: el.lat, lon: el.lon } : (el.center ? { lat: el.center.lat, lon: el.center.lon } : {});
      return {
        id: el.id,
        type: el.type,
        name: (el.tags && (el.tags.name || el.tags.operator)) || 'Unknown Hospital',
        tags: el.tags || {},
        lat: latLon.lat,
        lon: latLon.lon,
        // optional fields that may be present
        phone: el.tags && (el.tags['contact:phone'] || el.tags.phone || el.tags['phone']),
        website: el.tags && el.tags.website,
        address: [
          el.tags && el.tags['addr:street'],
          el.tags && el.tags['addr:city'],
          el.tags && el.tags['addr:postcode']
        ].filter(Boolean).join(', ')
      };
    })
    .filter(h => typeof h.lat === 'number' && typeof h.lon === 'number');

  return items;
}

async function nominatimReverse(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const r = await axios.get(url, { headers: defaultHeaders, timeout: 10000 });
    return r.data;
  } catch (e) {
    return null;
  }
}

// ---------- ROUTE: nearest hospital ----------
app.get('/nearest-hospital', async (req, res) => {
  try {
    // accept either query or body
    const lat = toNumber(req.query.lat ?? req.body?.lat ?? req.query.latitude ?? req.body?.latitude);
    const lon = toNumber(req.query.lon ?? req.body?.lon ?? req.query.longitude ?? req.body?.longitude);

    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'Missing or invalid lat/lon' });

    const cacheKey = `${lat},${lon}`;
    const now = Date.now();
    if (cache.has(cacheKey)) {
      const c = cache.get(cacheKey);
      if (now - c.ts < CACHE_TTL) {
        return res.json({ source: 'cache', ...c.value });
      } else cache.delete(cacheKey);
    }

    // try Overpass first
    let hospitals = [];
    try {
      hospitals = await fetchHospitalsFromOverpass(lat, lon, 10000); // 10 km default radius
    } catch (e) {
      console.warn('Overpass failed:', e.message);
    }

    // fallback to local file if none
    if (!hospitals || hospitals.length === 0) {
      hospitals = (LOCAL_HOSPITALS || []).map(h => ({
        ...h,
        lat: toNumber(h.latitude),
        lon: toNumber(h.longitude)
      }));
    }

    if (!hospitals || hospitals.length === 0) {
      return res.status(404).json({ error: 'No hospitals found' });
    }

    // if query includes ecg=irregular then prefer cardiac hospitals
    const ecg = req.query.ecg || req.body?.ecg;
    let filtered = hospitals;
    if (String(ecg).toLowerCase() === 'irregular') {
      const cardiac = hospitals.filter(looksLikeCardiac);
      if (cardiac.length > 0) filtered = cardiac;
    }

    // compute distances
    const ranked = filtered
      .map(h => {
        const d = haversineKm(lat, lon, Number(h.lat), Number(h.lon));
        return { ...h, distance_km: Number.isFinite(d) ? +d.toFixed(3) : Infinity };
      })
      .sort((a, b) => a.distance_km - b.distance_km);

    if (ranked.length === 0) return res.status(404).json({ error: 'No hospitals found after filtering' });

    // reverse geocode nearest for nicer address
    const nearest = ranked[0];
    const rev = await nominatimReverse(nearest.lat, nearest.lon);
    const address = rev?.display_name || nearest.address || 'Address unavailable';

    const result = {
      nearest: {
        name: nearest.name,
        lat: nearest.lat,
        lon: nearest.lon,
        phone: nearest.phone || null,
        address
      },
      alternatives: ranked.slice(1, 4).map(h => ({
        name: h.name,
        lat: h.lat,
        lon: h.lon,
        phone: h.phone || null,
        distance_km: h.distance_km
      }))
    };

    cache.set(cacheKey, { ts: now, value: result });
    return res.json(result);
  } catch (err) {
    console.error('nearest-hospital error:', err.message || err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------- helper: send alert to single hospital ----------
async function sendAlertToHospital(hospital, patientPayload, opts = {}) {
  // hospital: { name, lat, lon, phone, webhook }
  // patientPayload: { device_id, ecg, spo2, location, last30s }
  // returns { accepted: bool, hospital, reason }
  try {
    // try webhook if present
    if (hospital.webhook) {
      try {
        const r = await axios.post(hospital.webhook, patientPayload, { timeout: 5000 });
        if (r.status >= 200 && r.status < 300 && r.data && r.data.accepted) {
          return { accepted: true, hospital, reason: 'webhook-accepted' };
        }
      } catch (e) {
        // webhook failed/timeouts -> fallback
      }
    }

    // CASE: no webhook or webhook didn't accept: fallback to call/SMS/email
    // 1) call hospital phone via Twilio (if we have credentials)
    if (twilioClient && hospital.phone) {
      try {
        // Make a call — here we create a simple TwiML Bin URL or Twilio whisper — for demo we do a call that reads text via TwiML from Twilio's TwiML app (simplified)
        await twilioClient.calls.create({
          to: hospital.phone,
          from: process.env.TWILIO_PHONE_NUMBER,
          twiml: `<Response><Say voice="alice">Emergency alert: patient with cardiac emergency requires immediate attention. Check your email for patient data and location.</Say></Response>`
        });
        // assume success -> treat as accepted by hospital (in real world you'd wait for a confirmation route)
        return { accepted: true, hospital, reason: 'twilio-call-sent' };
      } catch (e) {
        // call failed -> continue fallback
      }
    }

    // 2) send SMS via Twilio
    if (twilioClient && hospital.phone) {
      try {
        const sms = await twilioClient.messages.create({
          body: `EMERGENCY: Patient near ${patientPayload.location.lat},${patientPayload.location.lon}. Check email for details.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: hospital.phone
        });
        return { accepted: true, hospital, reason: 'twilio-sms-sent' };
      } catch (e) {
        // continue
      }
    }

    // 3) send email to hospital email if we have (we attempt only if mail transporter is configured and hospital has tags.email)
    const hospitalEmail = hospital.tags && (hospital.tags.email || hospital.tags['contact:email']);
    if (mailTransporter && hospitalEmail) {
      try {
        await mailTransporter.sendMail({
          from: process.env.EMAIL_USER,
          to: hospitalEmail,
          subject: 'Emergency alert from PulseResQ',
          text: `Emergency patient data:\n${JSON.stringify(patientPayload, null, 2)}`
        });
        return { accepted: true, hospital, reason: 'email-sent' };
      } catch (e) {
        // not accepted
      }
    }

    // As last resort, if no comm method available, return not accepted
    return { accepted: false, hospital, reason: 'no-comm-path' };
  } catch (err) {
    return { accepted: false, hospital, reason: 'exception', error: err.message };
  }
}

// ---------- ROUTE: notify-hospitals (tries 3 hospitals concurrently; returns first accepted) ----------
app.post('/notify-hospitals', async (req, res) => {
  // expects { nearest: {...}, alternatives: [...], patient: {...} }
  try {
    const { nearest, alternatives = [], patient } = req.body;
    if (!nearest || !patient) return res.status(400).json({ error: 'Missing nearest or patient' });

    const hospitals = [nearest, ...alternatives].slice(0, 3);

    // attempt all in parallel (we'll accept the first which returns accepted=true)
    const attempts = hospitals.map(h => sendAlertToHospital(h, patient));

    const settled = await Promise.all(attempts);

    const accepted = settled.find(s => s && s.accepted);
    if (accepted) {
      return res.json({ status: 'accepted', hospital: accepted.hospital, reason: accepted.reason });
    } else {
      return res.status(504).json({ status: 'failed', message: 'No hospital accepted the alert', attempts: settled });
    }
  } catch (err) {
    console.error('notify-hospitals error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------- ROUTE: emergency-alert (single endpoint device calls) ----------
app.post('/emergency-alert', async (req, res) => {
  try {
    // device payload should include device_id, location:{lat,lon}, ecg, spo2, optionally last30s
    const { device_id, location, ecg, spo2, last30s } = req.body;
    if (!device_id || !location || toNumber(location.lat) === NaN || toNumber(location.lon) === NaN) {
      return res.status(400).json({ error: 'Missing device_id or valid location' });
    }
    const lat = toNumber(location.lat);
    const lon = toNumber(location.lon);

    // 1) find nearest hospital by calling internal handler (not HTTP, call the function)
    // reuse /nearest-hospital logic by invoking the handler code inline:
    const nearestRes = await (async () => {
      // small wrapper that calls the same logic
      const tmpReq = { query: { lat, lon } };
      // direct call to function above would be cleaner; for clarity re-run essential steps:
      let hospitals = [];
      try {
        hospitals = await fetchHospitalsFromOverpass(lat, lon, 10000);
      } catch (e) {
        hospitals = (LOCAL_HOSPITALS || []).map(h => ({ ...h, lat: toNumber(h.latitude), lon: toNumber(h.longitude) }));
      }
      if (!hospitals || hospitals.length === 0) throw new Error('No hospitals found');

      const ranked = hospitals
        .map(h => ({ ...h, distance_km: haversineKm(lat, lon, Number(h.lat), Number(h.lon)) }))
        .sort((a, b) => a.distance_km - b.distance_km);

      return {
        nearest: {
          name: ranked[0].name,
          lat: ranked[0].lat,
          lon: ranked[0].lon,
          phone: ranked[0].phone,
          tags: ranked[0].tags || {}
        },
        alternatives: ranked.slice(1, 4).map(r => ({ name: r.name, lat: r.lat, lon: r.lon, phone: r.phone, tags: r.tags || {} }))
      };
    })();

    // 2) prepare patient payload (last 30s ECG chunk optional)
    const patientPayload = {
      device_id,
      ecg,
      spo2,
      timestamp: new Date().toISOString(),
      location: { lat, lon },
      last30s: last30s || null
    };

    // 3) notify hospitals (calls notify-hospitals logic)
    const notifyRes = await (async () => {
      const hospitals = [nearestRes.nearest, ...(nearestRes.alternatives || [])].slice(0, 3);
      const results = await Promise.all(hospitals.map(h => sendAlertToHospital(h, patientPayload)));
      const accepted = results.find(r => r.accepted);
      return { accepted, results };
    })();

    if (notifyRes.accepted) {
      // success
      return res.json({
        status: 'ok',
        assigned_hospital: notifyRes.accepted.hospital,
        reason: notifyRes.accepted.reason
      });
    } else {
      return res.status(504).json({ status: 'failed', message: 'No hospital accepted', results: notifyRes.results });
    }
  } catch (err) {
    console.error('emergency-alert error', err);
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

// ---------- start server ----------
app.listen(PORT, () => {
  console.log(`🚀 PulseResQ server listening at http://localhost:${PORT}`);
});
