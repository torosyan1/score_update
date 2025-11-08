// odds-diff-server.js
//---------------------------------------------------------
// Express + Odds Comparison Bot
//---------------------------------------------------------
const express = require("express");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 4008;

// import all logic from your bot file
const axios = require("axios");
const cron = require("node-cron");
const crypto = require("crypto");

// ============== TELEGRAM CONFIG ========================
const BOT_TOKEN  = "8502979590:AAF0cTaLrqbHpOMIJvwAz3WZwwTfUTwGpYw";
const CHANNEL_ID = "@ETOddsNow";

// ============== API ENDPOINTS ==========================
const SITES = {
  dash     : "https://api.dash.bet/api/v2/multi",
  arada    : "https://api.arada.bet/api/v2/multi",
  victory  : "https://victorybet.et/api/v2/multi",
  ethiobet : "https://api.ethiobet.et/sport-data/matches/?ln=en",
  betika   : "https://api.betika.co.tz/v1/uo/matches?page=1&limit=200&keyword=&tab=&sub_type_id=1,186&country_id=3"
};

// ============== HEADERS/UTILITIES ======================
function headersFor(url) {
  const host = url.replace(/^https:\/\/|\/.*$/g, "");
  return {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "origin": `https://${host}`,
    "referer": `https://${host}/en/home`,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "accept-language": "en-US,en;q=0.9"
  };
}

const fmt = n => (n == null ? "—" : Number(n).toFixed(2));
const norm = s => (s || "")
  .toLowerCase()
  .replace(/\b(fc|sc|cf|afc|cf|u\d{2})\b/g, "")
  .replace(/[^\w\s]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const splitTeams = n => {
  if (!n) return [null, null];
  const p = n.split(/\s+vs?\s+| v /i);
  return p.length >= 2 ? [p[0].trim(), p[1].trim()] : [n, null];
};

function extract1x2(markets = []) {
  const m = markets.find(x => (x.marketCode || "").toLowerCase() === "1x2" && Array.isArray(x.prices));
  if (!m) return [];
  const map = { "1": null, "X": null, "2": null };
  for (const p of m.prices) {
    const k = (p.priceName || "").toUpperCase();
    if (k in map) map[k] = p.rate;
  }
  return [map["1"], map["X"], map["2"]];
}

// ============== CORE FETCH =============================
async function postWithRetry(url, body, headers, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      return await axios.post(url, body, { headers, timeout: 25000 });
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function fetchGraphQL(site, url, body) {
  try {
    const res = await postWithRetry(url, body, headersFor(url), 2);
    const data = res.data?.[0]?.data;
    const list = data?.mainEventList || data?.eventList || [];
    const now = Date.now();
    const out = [];

    for (const sport of list) {
      for (const comp of sport.competitions || []) {
        for (const ev of comp.events || []) {
          if (ev.isLive) continue;
          const [h, a] = splitTeams(ev.eventName);
          if (!h || !a) continue;
          const start = new Date(ev.eventStartTime).getTime();
          if (!isFinite(start) || start < now) continue;
          const markets = ev.collections?.flatMap(c => c.markets || []) || [];
          const odds = extract1x2(markets);
          if (!odds.length) continue;
          out.push({
            site,
            key: `${norm(h)}__${norm(a)}`,
            match: `${h} vs ${a}`,
            country: comp.country || "Unknown",
            league : comp.competitionName || "",
            start_time: ev.eventStartTime,
            odds
          });
        }
      }
    }
    return out;
  } catch (e) {
    console.error(`${site} error:`, e.message);
    return [];
  }
}

async function fetchMulti(site, url) {
  const BODY = [
    {
      module: "graphs",
      method: "makeQuery",
      options: {
        query: `
          mutation {
            eventList(eventListInput: { sportId: 501, markets: ["1x2"], topEvents: false }) {
              sportId sportName
              competitions {
                competitionId country competitionName
                events {
                  eventId eventName eventStartTime isLive
                  collections {
                    markets {
                      marketCode
                      prices { priceName rate }
                    }
                  }
                }
              }
            }
          }`
      }
    }
  ];
  return fetchGraphQL(site, url, BODY);
}

// ============== ETHIOBET / BETIKA ======================
async function fetchEthiobet() {
  try {
    const res = await axios.get(SITES.ethiobet, { timeout: 20000 });
    return (res.data || [])
      .filter(m => !m.expired && m.hom && m.awy && Array.isArray(m.win_odds))
      .map(m => ({
        site: "ethiobet.et",
        key: `${norm(m.hom)}__${norm(m.awy)}`,
        match: `${m.hom} vs ${m.awy}`,
        country: "Ethiopia",
        league: "Ethiobet",
        start_time: m.schedule,
        odds: m.win_odds.slice(0, 3).map(o => o.odd)
      }));
  } catch (e) {
    console.error("ethiobet error:", e.message);
    return [];
  }
}

// ============== COMPARISON =============================
function groupByMatch(rows) {
  const map = {};
  for (const r of rows) {
    if (!map[r.key]) map[r.key] = [];
    map[r.key].push(r);
  }
  return map;
}

function findDifferences(grouped) {
  const out = [];
  for (const arr of Object.values(grouped)) {
    if (arr.length < 2) continue;
    const sigs = new Set(arr.map(a => (a.odds || []).map(x => (x ?? "-")).join("/")));
    if (sigs.size <= 1) continue;
    const country = (arr.find(x => x.country && x.country !== "Unknown") || arr[0]).country;
    out.push({
      match: arr[0].match,
      country,
      league: arr[0].league,
      start_time: arr[0].start_time,
      sites: arr
    });
  }
  return out;
}

// ============== TELEGRAM ===============================
async function sendTelegram(html) {
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHANNEL_ID,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (e) {
    console.error("telegram error:", e.message);
  }
}

function buildMessage(diff) {
  let s = `⚽️ <b>${diff.match}</b>\n🌍 ${diff.country} — ${diff.league}\n⏰ ${new Date(diff.start_time).toLocaleString("am-ET", { hour12:false })}\n\n💰 <b>1 — X — 2</b>\n`;
  for (const r of diff.sites) s += `• <b>${r.site}</b> → ${r.odds.map(fmt).join(" / ")}\n`;
  s += `\n━━━━━━━━━━━━━━━\n📊 የእድሎች ልዩነት ተገኘ።`;
  return s;
}

// ============== MAIN LOOP ==============================
const sentHashes = new Set();
const hash = obj => crypto.createHash("md5").update(JSON.stringify(obj)).digest("hex");

async function fetchAll() {
  const [dash, arada, victory, ethiobet] = await Promise.all([
    fetchMulti("dash.bet", SITES.dash),
    fetchMulti("arada.bet", SITES.arada),
    fetchMulti("victory.bet", SITES.victory),
    fetchEthiobet()
  ]);
  return [...dash, ...arada, ...victory, ...ethiobet];
}

async function runOnce() {
  const all = await fetchAll();
  const grouped = groupByMatch(all);
  const diffs = findDifferences(grouped);
  if (!diffs.length) return console.log("No pre-match football differences.");
  let sentCount = 0;
  for (const d of diffs.slice(0, 10)) {
    const h = hash({ k: d.match, s: d.sites.map(x => [x.site, x.odds]) });
    if (sentHashes.has(h)) continue;
    sentHashes.add(h);
    await sendTelegram(buildMessage(d));
    sentCount++;
  }
  console.log(`✅ Sent ${sentCount}/${diffs.length} differences.`);
}

// run every minute
cron.schedule("*/1 * * * *", runOnce);

// ============== EXPRESS SERVER =========================
app.use(cors());
app.get("/", (req, res) => res.send("OddsDiffBot server running ✅"));
app.get("/status", (req, res) => res.json({ ok: true, lastSent: sentHashes.size }));
app.get("/run", async (req, res) => {
  await runOnce();
  res.send("Manual run complete ✅");
});

app.listen(PORT, () => {
  console.log(`🚀 Server started on http://localhost:${PORT}`);
});
