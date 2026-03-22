import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

const BDL_BASE = "https://api.balldontlie.io/v1";
const BDL_HEADERS = { Authorization: process.env.BALLDONTLIE_API_KEY };

function getCurrentSeason() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  return month >= 10 ? year : year - 1;
}

async function getLastNGames(teamId, n = 10) {
  const season = getCurrentSeason();
  let allGames = [];
  let cursor = null;

  while (true) {
    const params = {
      team_ids: [teamId],
      seasons: [season],
      per_page: 100,
    };
    if (cursor) params.cursor = cursor;

    const res = await axios.get(`${BDL_BASE}/games`, {
      headers: BDL_HEADERS,
      params,
    });

    const finished = res.data.data.filter(
      (g) => g.status === "Final" && g.home_team_score > 0
    );
    allGames = allGames.concat(finished);

    if (!res.data.meta?.next_cursor) break;
    cursor = res.data.meta.next_cursor;
  }

  allGames.sort((a, b) => new Date(b.date) - new Date(a.date));
  return allGames.slice(0, n);
}

function calculateTeamStats(teamId, games) {
  if (!games.length) {
    return { wins: 0, losses: 0, record: "0-0", pointsPerGame: 0, pointsAllowed: 0 };
  }

  let wins = 0;
  let losses = 0;
  let totalScored = 0;
  let totalAllowed = 0;

  for (const game of games) {
    const isHome = game.home_team.id === teamId;
    const teamScore = isHome ? game.home_team_score : game.visitor_team_score;
    const oppScore = isHome ? game.visitor_team_score : game.home_team_score;

    totalScored += teamScore;
    totalAllowed += oppScore;

    if (teamScore > oppScore) wins++;
    else losses++;
  }

  return {
    wins,
    losses,
    record: `${wins}-${losses}`,
    pointsPerGame: parseFloat((totalScored / games.length).toFixed(1)),
    pointsAllowed: parseFloat((totalAllowed / games.length).toFixed(1)),
  };
}

function isH2HGame(game, teamAId, teamBId) {
  const ids = [game.home_team.id, game.visitor_team.id];
  return ids.includes(teamAId) && ids.includes(teamBId);
}

function summarizeH2H(teamAId, games) {
  let wins = 0;
  let losses = 0;
  let totalPoints = 0;

  for (const game of games) {
    const isHome = game.home_team.id === teamAId;
    const teamScore = isHome ? game.home_team_score : game.visitor_team_score;
    const oppScore = isHome ? game.visitor_team_score : game.home_team_score;

    totalPoints += teamScore + oppScore;

    if (teamScore > oppScore) wins++;
    else losses++;
  }

  return {
    wins,
    losses,
    record: `${wins}-${losses}`,
    avgTotalPoints:
      games.length > 0
        ? parseFloat((totalPoints / games.length).toFixed(1))
        : null,
    gamesPlayed: games.length,
  };
}

async function calculateH2H(teamAId, teamBId) {
  const season = getCurrentSeason();
  const allSeasons = [season, season - 1, season - 2];

  const thisSeasonRes = await axios.get(`${BDL_BASE}/games`, {
    headers: BDL_HEADERS,
    params: {
      team_ids: [teamAId, teamBId],
      seasons: [season],
      per_page: 100,
    },
  });

  const thisSeasonGames = thisSeasonRes.data.data.filter(
    (g) =>
      g.status === "Final" &&
      g.home_team_score > 0 &&
      isH2HGame(g, teamAId, teamBId)
  );

  const overallRes = await axios.get(`${BDL_BASE}/games`, {
    headers: BDL_HEADERS,
    params: {
      team_ids: [teamAId, teamBId],
      seasons: allSeasons,
      per_page: 100,
    },
  });

  const overallGames = overallRes.data.data.filter(
    (g) =>
      g.status === "Final" &&
      g.home_team_score > 0 &&
      isH2HGame(g, teamAId, teamBId)
  );

  return {
    thisSeason: summarizeH2H(teamAId, thisSeasonGames),
    overall: summarizeH2H(teamAId, overallGames),
  };
}

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
          markets: "spreads,totals,h2h",
        },
      }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

app.get("/api/games/:id", async (req, res) => {
  try {
    const gameId = req.params.id;

    const gameRes = await axios.get(`${BDL_BASE}/games/${gameId}`, {
      headers: BDL_HEADERS,
    });
    const game = gameRes.data.data;

    const homeTeam = game.home_team;
    const awayTeam = game.visitor_team;

    const [homeLast5, homeLast10, awayLast5, awayLast10, h2h] =
      await Promise.all([
        getLastNGames(homeTeam.id, 5),
        getLastNGames(homeTeam.id, 10),
        getLastNGames(awayTeam.id, 5),
        getLastNGames(awayTeam.id, 10),
        calculateH2H(homeTeam.id, awayTeam.id),
      ]);

    const homeStats = calculateTeamStats(homeTeam.id, homeLast10);
    const awayStats = calculateTeamStats(awayTeam.id, awayLast10);

    res.json({
      gameId,
      date: game.date,
      status: game.status,
      homeTeam: {
        id: homeTeam.id,
        name: homeTeam.full_name,
        abbreviation: homeTeam.abbreviation,
        overall: homeStats,
        last5: calculateTeamStats(homeTeam.id, homeLast5),
        last10: homeStats,
        pointsPerGame: homeStats.pointsPerGame,
        pointsAllowed: homeStats.pointsAllowed,
      },
      awayTeam: {
        id: awayTeam.id,
        name: awayTeam.full_name,
        abbreviation: awayTeam.abbreviation,
        overall: awayStats,
        last5: calculateTeamStats(awayTeam.id, awayLast5),
        last10: awayStats,
        pointsPerGame: awayStats.pointsPerGame,
        pointsAllowed: awayStats.pointsAllowed,
      },
      h2h: {
        thisSeason: h2h.thisSeason,
        overall: h2h.overall,
        avgTotalPoints: h2h.overall.avgTotalPoints,
      },
    });
  } catch (err) {
    console.error("Error in /api/games/:id:", err.message);
    res.status(500).json({
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
