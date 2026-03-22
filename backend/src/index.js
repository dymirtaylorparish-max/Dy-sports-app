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
const BDL_HEADERS = {
  Authorization: process.env.BALLDONTLIE_API_KEY,
};

const cache = new Map();

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;

  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function setCache(key, data, ttlMs = 5 * 60 * 1000) {
  cache.set(key, {
    data,
    expiry: Date.now() + ttlMs,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCurrentSeason() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  return month >= 10 ? year : year - 1;
}

function isFinishedGame(game) {
  const status = String(game.status || "").toLowerCase();
  return (
    typeof game.home_team_score === "number" &&
    typeof game.visitor_team_score === "number" &&
    !status.includes("scheduled") &&
    !status.includes("postponed")
  );
}

function isTeamHome(teamId, game) {
  return game.home_team?.id === teamId;
}

function getTeamScore(teamId, game) {
  return isTeamHome(teamId, game) ? game.home_team_score : game.visitor_team_score;
}

function getOpponentScore(teamId, game) {
  return isTeamHome(teamId, game) ? game.visitor_team_score : game.home_team_score;
}

function didTeamWin(teamId, game) {
  return getTeamScore(teamId, game) > getOpponentScore(teamId, game);
}

function calculateTeamStats(teamId, games) {
  if (!games || games.length === 0) {
    return {
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      record: "0-0",
      pointsPerGame: 0,
      pointsAllowedPerGame: 0,
    };
  }

  let wins = 0;
  let losses = 0;
  let totalPoints = 0;
  let totalAllowed = 0;

  for (const game of games) {
    const teamScore = getTeamScore(teamId, game);
    const opponentScore = getOpponentScore(teamId, game);

    totalPoints += teamScore;
    totalAllowed += opponentScore;

    if (teamScore > opponentScore) {
      wins += 1;
    } else {
      losses += 1;
    }
  }

  return {
    gamesPlayed: games.length,
    wins,
    losses,
    record: `${wins}-${losses}`,
    pointsPerGame: Number((totalPoints / games.length).toFixed(1)),
    pointsAllowedPerGame: Number((totalAllowed / games.length).toFixed(1)),
  };
}

function summarizeH2H(teamAId, games) {
  if (!games || games.length === 0) {
    return {
      gamesPlayed: 0,
      record: "0-0",
      wins: 0,
      losses: 0,
      averageTotalPoints: 0,
    };
  }

  let wins = 0;
  let losses = 0;
  let totalPoints = 0;

  for (const game of games) {
    const teamAScore = getTeamScore(teamAId, game);
    const teamBScore = getOpponentScore(teamAId, game);

    totalPoints += teamAScore + teamBScore;

    if (teamAScore > teamBScore) {
      wins += 1;
    } else {
      losses += 1;
    }
  }

  return {
    gamesPlayed: games.length,
    record: `${wins}-${losses}`,
    wins,
    losses,
    averageTotalPoints: Number((totalPoints / games.length).toFixed(1)),
  };
}

function isH2HGame(teamAId, teamBId, game) {
  const homeId = game.home_team?.id;
  const awayId = game.visitor_team?.id;

  return (
    (homeId === teamAId && awayId === teamBId) ||
    (homeId === teamBId && awayId === teamAId)
  );
}

async function getLastNGames(teamId, n, season = getCurrentSeason()) {
  const cacheKey = `last-${n}-games-${teamId}-${season}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  let allGames = [];
  let cursor;
  let keepGoing = true;

  while (keepGoing) {
    const response = await axios.get(`${BDL_BASE}/games`, {
      headers: BDL_HEADERS,
      params: {
        "team_ids[]": teamId,
        seasons: [season],
        per_page: 100,
        cursor,
      },
    });

    const payload = response.data;
    const pageGames = (payload.data || []).filter(isFinishedGame);

    allGames = allGames.concat(pageGames);

    if (allGames.length >= n) {
      keepGoing = false;
    } else if (!payload.meta?.next_cursor) {
      keepGoing = false;
    } else {
      cursor = payload.meta.next_cursor;
      await sleep(250);
    }
  }

  allGames.sort((a, b) => new Date(b.date) - new Date(a.date));

  const result = allGames.slice(0, n);
  setCache(cacheKey, result, 5 * 60 * 1000);
  return result;
}

async function getTeamSeasonGames(teamId, season) {
  const cacheKey = `team-season-games-${teamId}-${season}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  let allGames = [];
  let cursor;
  let keepGoing = true;

  while (keepGoing) {
    const response = await axios.get(`${BDL_BASE}/games`, {
      headers: BDL_HEADERS,
      params: {
        "team_ids[]": teamId,
        seasons: [season],
        per_page: 100,
        cursor,
      },
    });

    const payload = response.data;
    const pageGames = (payload.data || []).filter(isFinishedGame);
    allGames = allGames.concat(pageGames);

    if (!payload.meta?.next_cursor) {
      keepGoing = false;
    } else {
      cursor = payload.meta.next_cursor;
      await sleep(250);
    }
  }

  allGames.sort((a, b) => new Date(b.date) - new Date(a.date));
  setCache(cacheKey, allGames, 10 * 60 * 1000);
  return allGames;
}

async function calculateH2H(teamAId, teamBId) {
  const currentSeason = getCurrentSeason();
  const overallSeasons = [currentSeason, currentSeason - 1, currentSeason - 2, currentSeason - 3];

  const thisSeasonGamesRaw = await getTeamSeasonGames(teamAId, currentSeason);
  const thisSeasonGames = thisSeasonGamesRaw.filter((game) =>
    isH2HGame(teamAId, teamBId, game)
  );

  let overallGames = [...thisSeasonGames];

  for (const season of overallSeasons.slice(1)) {
    const seasonGames = await getTeamSeasonGames(teamAId, season);
    overallGames = overallGames.concat(
      seasonGames.filter((game) => isH2HGame(teamAId, teamBId, game))
    );
    await sleep(200);
  }

  overallGames.sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    thisSeason: summarizeH2H(teamAId, thisSeasonGames),
    overall: summarizeH2H(teamAId, overallGames),
    recentGames: overallGames.slice(0, 5),
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
    const cacheKey = `game-details-${gameId}`;
    const cached = getCache(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    const response = await axios.get(`${BDL_BASE}/games?ids[]=${gameId}`, {
      headers: BDL_HEADERS,
    });

    const game = response.data?.data?.[0];

    if (!game) {
      return res.status(404).json({
        error: "Game not found",
        details: `No BallDontLie game found for id ${gameId}`,
      });
    }

    const homeTeam = game.home_team;
    const awayTeam = game.visitor_team;
    const season = game.season || getCurrentSeason();

    const [
      homeLast10,
      awayLast10,
      homeSeasonGames,
      awaySeasonGames,
      h2h,
    ] = await Promise.all([
      getLastNGames(homeTeam.id, 10, season),
      getLastNGames(awayTeam.id, 10, season),
      getTeamSeasonGames(homeTeam.id, season),
      getTeamSeasonGames(awayTeam.id, season),
      calculateH2H(homeTeam.id, awayTeam.id),
    ]);

    const homeLast5 = homeLast10.slice(0, 5);
    const awayLast5 = awayLast10.slice(0, 5);

    const homeOverallStats = calculateTeamStats(homeTeam.id, homeSeasonGames);
    const awayOverallStats = calculateTeamStats(awayTeam.id, awaySeasonGames);

    const homeLast5Stats = calculateTeamStats(homeTeam.id, homeLast5);
    const homeLast10Stats = calculateTeamStats(homeTeam.id, homeLast10);

    const awayLast5Stats = calculateTeamStats(awayTeam.id, awayLast5);
    const awayLast10Stats = calculateTeamStats(awayTeam.id, awayLast10);

    const responsePayload = {
      gameId: game.id,
      date: game.date,
      season: game.season,
      status: game.status,
      homeTeam: {
        id: homeTeam.id,
        name: homeTeam.full_name,
        abbreviation: homeTeam.abbreviation,
        score: game.home_team_score,
        overall: homeOverallStats,
        last5: homeLast5Stats,
        last10: homeLast10Stats,
      },
      awayTeam: {
        id: awayTeam.id,
        name: awayTeam.full_name,
        abbreviation: awayTeam.abbreviation,
        score: game.visitor_team_score,
        overall: awayOverallStats,
        last5: awayLast5Stats,
        last10: awayLast10Stats,
      },
      h2h: {
        thisSeason: h2h.thisSeason,
        overall: h2h.overall,
        recentGames: h2h.recentGames.map((g) => ({
          id: g.id,
          date: g.date,
          homeTeam: g.home_team?.full_name,
          awayTeam: g.visitor_team?.full_name,
          homeScore: g.home_team_score,
          awayScore: g.visitor_team_score,
          status: g.status,
        })),
      },
    };

    setCache(cacheKey, responsePayload, 5 * 60 * 1000);
    res.json(responsePayload);
  } catch (err) {
    if (err.response?.status === 429) {
      return res.status(429).json({
        error: "Rate limited by BallDontLie",
        details: "Too many requests. Please try again later.",
      });
    }

    if (err.response?.status === 401) {
      return res.status(401).json({
        error: "Unauthorized with BallDontLie",
        details: "Check BALLDONTLIE_API_KEY in Railway variables.",
      });
    }

    res.status(500).json({
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
