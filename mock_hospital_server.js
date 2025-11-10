// === MOCK HOSPITAL SERVER ===
// Simulates hospitals that receive PulseResQ emergency alerts.

import express from "express";
const app = express();
app.use(express.json());

const PORT = 4000;

// Mock hospital data
const hospitals = [
  { id: 1, name: "City Care Hospital", accepts: true },
  { id: 2, name: "Apollo Heart Center", accepts: false },
  { id: 3, name: "Fortis Cardiac Institute", accepts: true },
];

// Route to receive alert
app.post("/alert", async (req, res) => {
  const { patient } = req.body;
  const hospital = hospitals[Math.floor(Math.random() * hospitals.length)];
  console.log(`🏥 ${hospital.name} received alert for patient ${patient.device_id}`);

  // Simulate random response delay (1–4 seconds)
  await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 3000));

  if (hospital.accepts) {
    console.log(`✅ ${hospital.name} accepted the case.`);
    return res.json({ accepted: true, hospital: hospital.name });
  } else {
    console.log(`❌ ${hospital.name} ignored the alert.`);
    return res.json({ accepted: false });
  }
});

// Default route
app.get("/", (req, res) => res.send("🏥 Mock Hospital Server Running"));

// Start the mock server
app.listen(PORT, () => {
  console.log(`🏥 Mock Hospital Server running at http://localhost:${PORT}`);
  console.log("Hospitals ready to receive alerts!");
});
