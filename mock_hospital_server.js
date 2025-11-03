import express from "express";
const app = express();
app.use(express.json());

app.post("/webhook", (req, res) => {
  console.log("🏥 Received alert:", req.body);
  res.json({
    accepted: true,
    message: "Hospital acknowledged emergency alert"
  });
});

app.listen(4000, () => console.log("🏥 Mock hospital running at http://localhost:4000/webhook"));
