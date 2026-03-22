import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4000;

app.get("/", (req, res) => {
  res.send("Dy Sports API Running 🚀");
});

app.get("/api/odds/nba", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.the-odds-api.com/v4/sports/basketball_nba/odds",
      {
        params: {
          apiKey: process.env.ODDS_API_KEY,
          regions: "us",
          markets: "spreads,totals,h2h"
        }
      }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
