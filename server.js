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
