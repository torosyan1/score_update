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
const cron  = require("node-cron");
const crypto = require("crypto");

// ============== TELEGRAM CONFIG ========================
const BOT_TOKEN  = "8502979590:AAF0cTaLrqbHpOMIJvwAz3WZwwTfUTwGpYw";
const CHANNEL_ID = "@ETLiveScores";

// ============== API ENDPOINTS ==========================
const SITES = {
  dash     : "https://api.dash.bet/api/v2/multi",
  arada    : "https://api.arada.bet/api/v2/multi",
  victory  : "https://victorybet.et/api/v2/multi",
  ethiobet : "https://api.ethiobet.et/sport-data/matches/?ln=en",
  betika   : "https://api.betika.co.tz/v1/uo/matches?page=1&limit=200&keyword=&tab=&sub_type_id=1,186&country_id=3"
};

// ============== OPTIONAL COOKIES (helps with 403) =====
// Paste cookies captured from your browser DevTools (Application > Cookies)
// Keep them short; usually a session token / cf_clearance is enough.
const COOKIE_VICTORY = "";   // e.g. "cf_clearance=...; PHPSESSID=..."
const COOKIE_ARADA   = "";
const COOKIE_DASH    = "";

// ============== HEADERS HELPERS =======================
function headersFor(url) {
  const host = url.replace(/^https:\/\/|\/.*$/g, "");
  const base = {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "origin": `https://${host}`,
    "referer": `https://${host}/en/home`,
    "sec-ch-ua": '"Chromium";v="122", "Google Chrome";v="122", "Not_A Brand";v="99"',
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9"
  };
  if (host.includes("victorybet.et") && COOKIE_VICTORY) base.cookie = COOKIE_VICTORY;
  if (host.includes("arada.bet")     && COOKIE_ARADA)   base.cookie = COOKIE_ARADA;
  if (host.includes("dash.bet")      && COOKIE_DASH)    base.cookie = COOKIE_DASH;
  return base;
}

// ============== GRAPHQL BODIES ========================
const BODY_MAIN = [
  {
    module: "graphs",
    method: "makeQuery",
    options: {
      query: `
        mutation {
          mainEventList(mainEventListInput: { page: 1, sportId: 501, topEvents: true }) {
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

const BODY_EVENT = [
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

// ============== UTILITIES =============================
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

const flagISO = iso2 => {
  if (!iso2 || !/^[A-Z]{2}$/.test(iso2)) return "🌍";
  const A = 0x1F1E6, a = "A".charCodeAt(0);
  return String.fromCodePoint(A + (iso2.charCodeAt(0) - a)) +
         String.fromCodePoint(A + (iso2.charCodeAt(1) - a));
};
const countryISO = {
  ENGLAND: "GB", SCOTLAND: "GB", WALES: "GB", TANZANIA: "TZ", ETHIOPIA: "ET",
  SPAIN: "ES", ITALY: "IT", FRANCE: "FR", GERMANY: "DE", PORTUGAL: "PT",
  NETHERLANDS: "NL", BELGIUM: "BE", SWITZERLAND: "CH", AUSTRIA: "AT",
  DENMARK: "DK", RUSSIA: "RU", SCOTIA: "GB"
};
const flag = name => flagISO(countryISO[(name || "").toUpperCase()] || "");

// ============== FETCHERS (with retry) ==================
async function postWithRetry(url, body, headers, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      return await axios.post(url, body, { headers, timeout: 25000 });
    } catch (e) {
      const code = e.response?.status;
      if (i === tries - 1) throw e;
      // small backoff
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      // if 403 and no cookie, just retry; many times a second hit passes
      if (code !== 403 && code !== 429) continue;
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
    console.error(`${site} error:`, e.response?.status || e.message);
    return [];
  }
}

async function fetchMulti(site, url) {
  const [main, events] = await Promise.all([
    fetchGraphQL(site, url, BODY_MAIN),
    fetchGraphQL(site, url, BODY_EVENT)
  ]);
  // dedupe by site+key
  const map = new Map();
  [...main, ...events].forEach(m => map.set(m.site + "::" + m.key, m));
  return [...map.values()];
}

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
        league: String(m.league || "Ethiobet"),
        start_time: m.schedule,
        odds: m.win_odds.slice(0, 3).map(o => o.odd)
      }));
  } catch (e) {
    console.error("ethiobet error:", e.response?.status || e.message);
    return [];
  }
}

async function fetchBetika() {
  try {
    const res = await axios.get(SITES.betika, {
      headers: {
        "accept": "application/json, text/plain, */*",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        "origin": "https://www.betika.co.tz",
        "referer": "https://www.betika.co.tz/en-tz/",
        "accept-language": "en-US,en;q=0.9"
      },
      timeout: 25000
    });

    const now = Date.now();
    const rows = res.data?.data || [];
    const out = [];

    for (const r of rows) {
      if (String(r.sport_name || "").toLowerCase() !== "soccer") continue;
      const start = new Date(r.start_time.replace(" ", "T") + "Z").getTime();
      if (!isFinite(start) || start < now) continue;

      const market1x2 = (r.odds || []).find(o => String(o.name).toUpperCase() === "1X2");
      if (!market1x2) continue;

      const pick = { "1": null, "X": null, "2": null };
      for (const o of market1x2.odds || []) {
        const k = (o.display || "").toUpperCase();
        if (k === "1" || k === "X" || k === "2") pick[k] = Number(o.odd_value);
      }
      const odds = [pick["1"], pick["X"], pick["2"]];
      if (!odds.some(v => v)) continue;

      const h = (r.home_team || "").trim();
      const a = (r.away_team || "").trim();

      out.push({
        site: "betika.co.tz",
        key: `${norm(h)}__${norm(a)}`,
        match: `${h} vs ${a}`,
        country: r.category || "Tanzania",
        league: r.competition_name || "",
        start_time: new Date(start).toISOString(),
        odds
      });
    }
    return out;
  } catch (e) {
    console.error("betika error:", e.response?.status || e.message);
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
    // prefer non-Unknown country if mixed
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
    }, { timeout: 15000 });
  } catch (e) {
    console.error("telegram error:", e.response?.status || e.message);
  }
}

function buildMessage(diff) {
  const order = ["dash.bet", "arada.bet", "victory.bet", "ethiobet.et", "betika.co.tz"];
  const f = flag(diff.country);
  let s = `⚽️ <b>${diff.match}</b>\n${f} <b>${diff.country}</b> — ${diff.league}\n⏰ ጊዜ፡ ${new Date(diff.start_time).toLocaleString("am-ET", { hour12:false, day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" })}\n\n`;
  s += `💰 <b>1 — X — 2 የውጤት እድሎች</b>\n`;
  for (const name of order) {
    const r = diff.sites.find(x => x.site === name);
    if (r) s += `• <b>${name}</b> → ${r.odds.map(fmt).join(" / ")}\n`;
  }
  s += `\n━━━━━━━━━━━━━━━\n📊 የቀድሞ ጨዋታ የፈተና እድሎች ልዩነት ተገኘ።`;
  return s;
}

// ============== MAIN LOOP ==============================
const sentHashes = new Set();
const hash = obj => crypto.createHash("md5").update(JSON.stringify(obj)).digest("hex");

async function fetchAll() {
  const [dash, arada, victory, ethiobet, betika] = await Promise.all([
    fetchMulti("dash.bet", SITES.dash),
    fetchMulti("arada.bet", SITES.arada),
    fetchMulti("victory.bet", SITES.victory),
    fetchEthiobet(),
    fetchBetika()
  ]);
  return [...dash, ...arada, ...victory, ...ethiobet, ...betika];
}

async function runOnce() {
  const all = await fetchAll();
  const grouped = groupByMatch(all);
  const diffs = findDifferences(grouped);
  if (!diffs.length) return console.log("No pre-match football differences.");

  let sentCount = 0;
  for (const d of diffs.slice(0, 12)) {
    const h = hash({ k: d.match, s: d.sites.map(x => [x.site, x.odds]) });
    if (sentHashes.has(h)) continue;
    sentHashes.add(h);
    await sendTelegram(buildMessage(d));
    sentCount++;
  }
  console.log(`✅ Sent ${sentCount}/${diffs.length} differences.`);
}

// run immediately + every minute
runOnce();
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
