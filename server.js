const express = require('express');
const fetch   = (...args) => import('node-fetch').then(({default:f}) => f(...args));
const path    = require('path');
const { execSync } = require('child_process');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── CACHE ────────────────────────────────────────────────────────────────────
const cache = new Map();
function cached(key, fn, ttl = 45000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttl) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, ts: Date.now() }); return data; });
}
function parseJSON(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

// ── PAGINATED TRADE FETCHER ──────────────────────────────────────────────────
// data-api caps at 1000 per request — fetch 3 pages (3000 trades) via offset
async function fetchAllTrades() {
  const pages = await Promise.all([0, 1000, 2000].map(async offset => {
    try {
      const r = await fetch(`https://data-api.polymarket.com/trades?limit=1000&offset=${offset}`, { headers: { Accept: 'application/json' } });
      return r.ok ? r.json() : [];
    } catch { return []; }
  }));
  return pages.flat();
}

// ── MAC NOTIFICATIONS ────────────────────────────────────────────────────────
const notifiedTrades = new Set();
function macNotify(title, msg, sound) {
  if (process.platform !== 'darwin') return;
  const t = title.replace(/'/g, "\\'"), m = msg.replace(/'/g, "\\'");
  try { execSync(`osascript -e 'display notification "${m}" with title "${t}" sound name "${sound}"'`); }
  catch(e) {}
}
function checkAndNotify(trade) {
  const key = trade.transactionHash || `${trade.proxyWallet}|${trade.timestamp}`;
  if (notifiedTrades.has(key)) return;
  notifiedTrades.add(key);
  if (notifiedTrades.size > 5000) { const a=[...notifiedTrades]; notifiedTrades.clear(); a.slice(-2000).forEach(k=>notifiedTrades.add(k)); }
  const usd = parseFloat(trade.size||0) * parseFloat(trade.price||0);
  const wallet = trade.proxyWallet ? trade.proxyWallet.slice(0,6)+'…'+trade.proxyWallet.slice(-4) : '?';
  if (usd >= 10000) {
    macNotify(
      `${usd>=1e6?'🚨':usd>=50000?'🐳':'🎯'} WHALE — $${Math.round(usd).toLocaleString()}`,
      `${wallet} bet $${Math.round(usd).toLocaleString()} on "${(trade.title||'').slice(0,50)}"`,
      usd >= 50000 ? 'Submarine' : 'Ping'
    );
  }
}

// ── TEAM MATCHING ────────────────────────────────────────────────────────────
function teamsMatch(team, title) {
  const t = team.toLowerCase(), ti = title.toLowerCase();
  if (ti.includes(t)) return true;
  const words = t.split(' ');
  if (words.length >= 2) { const two = words.slice(-2).join(' '); if (two.length>5 && ti.includes(two)) return true; }
  const last = words[words.length-1];
  return last.length > 4 && ti.includes(last);
}

// ── SHARED TRADE FORMATTER ───────────────────────────────────────────────────
function formatTrade(t) {
  const usd = parseFloat(t.size||0) * parseFloat(t.price||0);
  const odds = parseFloat(t.price||0);
  const payout = odds > 0 && odds < 1 ? usd/odds - usd : 0;
  return {
    wallet: t.proxyWallet ? t.proxyWallet.slice(0,5)+'…'+t.proxyWallet.slice(-3) : '?',
    fullWallet: t.proxyWallet || '',
    pseudonym: t.pseudonym || '',
    usd, odds, payout,
    side: (t.side||'BUY').toUpperCase(),
    outcome: t.outcome || '?',
    title: t.title || '',
    timestamp: parseInt(t.timestamp||0),
    flag: usd>=1e6 ? '🚨' : usd>=50000 ? '🐳' : (usd>=5000 || (odds<=0.20 && usd>=500)) ? '🎯' : ''
  };
}

app.use(express.static(path.join(__dirname)));

// ── MLB TODAY ────────────────────────────────────────────────────────────────
app.get('/api/mlb', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const [games, polyEvents, allTrades] = await Promise.all([
      cached('mlb-'+today, async () => {
        const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,team`);
        if (!r.ok) throw new Error('MLB API '+r.status);
        const d = await r.json();
        return (d.dates||[])[0]?.games || [];
      }, 120000),
      cached('poly-mlb', async () => {
        const r = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=mlb&limit=200');
        return r.ok ? r.json() : [];
      }, 120000),
      cached('trades-3k', fetchAllTrades, 30000)
    ]);

    const prevOdds = cache.get('mlb-prev-odds')?.data || {};

    const result = games.map(g => {
      const away = g.teams.away.team.name;
      const home = g.teams.home.team.name;
      const awayPP = g.teams.away.probablePitcher || {};
      const homePP = g.teams.home.probablePitcher || {};
      const matched = polyEvents.filter(e => teamsMatch(away, e.title||'') && teamsMatch(home, e.title||''));

      let moneyline = null, ou = null;
      let totalVol = 0, vol24 = 0;
      const allConditionIds = [];
      for (const evt of matched) {
        totalVol += parseFloat(evt.volume||0);
        vol24 += parseFloat(evt.volume24hr||0);
        for (const m of (evt.markets||[])) {
          if (m.conditionId) allConditionIds.push(m.conditionId);
          const q = (m.question||'').toLowerCase();
          const prices = parseJSON(m.outcomePrices).map(Number);
          // Filter settled (>99% or <1%) and value range (15%-85%)
          const valid = prices.length>=2 && prices[0]>0.15 && prices[0]<0.85 && prices[1]>0.15 && prices[1]<0.85;
          if (!q.includes('o/u') && !q.includes('spread') && !q.includes('first inning') && !moneyline && valid)
            moneyline = { prices, outcomes:parseJSON(m.outcomes), vol:parseFloat(m.volume||0), question:m.question, conditionId:m.conditionId||'' };
          if (q.includes('o/u') && !ou && prices.length>=2 && prices[0]>0.05 && prices[0]<0.95)
            ou = { prices, question:m.question, line:(m.question||'').match(/O\/U\s*([\d.]+)/i)?.[1]||'?', conditionId:m.conditionId||'' };
        }
      }

      // Mispricing flag: heavy favorite < 60% or big underdog > 40%
      const awayP = moneyline?.prices?.[0] || 0;
      const mispriced = moneyline && (awayP > 0.15 && awayP < 0.40) || (awayP > 0.60 && awayP < 0.85);

      // Sharp detection
      const mlKey = `${away}@${home}`;
      const prevAway = prevOdds[mlKey];
      const delta = prevAway != null ? awayP - prevAway : 0;
      const isSharp = Math.abs(delta) >= 0.05;

      // Inline trades for this game (from the 3K trade pool)
      const cidSet = new Set(allConditionIds);
      const gameTrades = allTrades
        .filter(t => cidSet.has(t.conditionId))
        .map(formatTrade)
        .sort((a,b) => b.usd - a.usd)
        .slice(0, 20);

      return {
        away, home,
        awayPitcher: awayPP.fullName || 'TBD',
        homePitcher: homePP.fullName || 'TBD',
        gameTime: g.gameDate,
        status: g.status.detailedState,
        awayRec: `${g.teams.away.leagueRecord?.wins||0}-${g.teams.away.leagueRecord?.losses||0}`,
        homeRec: `${g.teams.home.leagueRecord?.wins||0}-${g.teams.home.leagueRecord?.losses||0}`,
        moneyline, ou, allConditionIds,
        totalVol, vol24,
        delta: parseFloat(delta.toFixed(4)), isSharp, mispriced,
        trades: gameTrades,
        tradeCount: gameTrades.length
      };
    });

    const newPrev = {};
    result.forEach(g => { if (g.moneyline) newPrev[`${g.away}@${g.home}`] = g.moneyline.prices[0]; });
    cache.set('mlb-prev-odds', { data: newPrev, ts: Date.now() });

    res.json(result);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── WAR / GEOPOLITICAL INTEL ─────────────────────────────────────────────────
const WAR_TAGS = ['iran','israel','middle-east','china','ukraine','russia','nuclear','geopolitics','taiwan','military'];
const WAR_KW = ['iran','israel','war','military','nuclear','russia','ukraine','china','taiwan','invade','strike','bomb','missile','troops','ceasefire','regime'];

app.get('/api/war', async (req, res) => {
  const minTrade = parseFloat(req.query.min) || 1;
  try {
    const allEvents = await cached('war-events', async () => {
      const results = await Promise.all(WAR_TAGS.map(async tag => {
        try { const r = await fetch(`https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=${tag}&limit=100`); return r.ok ? r.json() : []; }
        catch { return []; }
      }));
      const seen = new Set(), merged = [];
      for (const batch of results) for (const e of batch) { if (!seen.has(e.id)) { seen.add(e.id); merged.push(e); } }
      return merged.filter(e => WAR_KW.some(kw => (e.title||'').toLowerCase().includes(kw)));
    }, 120000);

    const markets = [];
    for (const evt of allEvents) {
      for (const m of (evt.markets||[])) {
        const prices = parseJSON(m.outcomePrices).map(Number);
        if (!prices.length) continue;
        markets.push({
          question: m.question||evt.title, conditionId: m.conditionId||'',
          yesPrice: prices[0]||0, noPrice: prices[1]||0,
          volume: parseFloat(m.volume||0),
          volume24hr: parseFloat(m.volume24hr||evt.volume24hr||0),
          endDate: m.endDate||evt.endDate||''
        });
      }
    }
    markets.sort((a,b) => b.volume - a.volume);

    // Fetch 3K trades via pagination
    const conditionIds = new Set(markets.map(m=>m.conditionId).filter(Boolean));
    const allTrades = await cached('trades-3k', fetchAllTrades, 30000);
    const totalFetched = allTrades.length;

    const tradesByMarket = {};
    for (const t of allTrades) {
      if (!conditionIds.has(t.conditionId)) continue;
      const trade = formatTrade(t);
      if (trade.usd < minTrade) continue;
      const cid = t.conditionId;
      if (!tradesByMarket[cid]) tradesByMarket[cid] = [];
      tradesByMarket[cid].push(trade);
      checkAndNotify(t);
    }
    for (const cid of Object.keys(tradesByMarket)) tradesByMarket[cid].sort((a,b) => b.usd-a.usd);

    const allWarTrades = Object.values(tradesByMarket).flat().sort((a,b) => b.usd-a.usd);
    const topWhales = allWarTrades.filter(t => t.usd >= Math.max(minTrade, 1000)).slice(0, 10);

    const result = markets.map(m => ({ ...m, trades: (tradesByMarket[m.conditionId]||[]).slice(0,20) }));
    res.json({ markets: result, topWhales, totalFetched });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── WALLET TRACKER ───────────────────────────────────────────────────────────
app.get('/api/wallets', async (req, res) => {
  try {
    const trades = await cached('trades-3k', fetchAllTrades, 30000);
    const wallets = new Map();
    for (const t of trades) {
      const addr = t.proxyWallet; if (!addr) continue;
      const usd = parseFloat(t.size||0)*parseFloat(t.price||0);
      const w = wallets.get(addr)||{ address:addr, short:addr.slice(0,5)+'…'+addr.slice(-3), pseudonym:t.pseudonym||'', volume:0, trades:0, biggest:0, buys:0, sells:0, recentBets:[] };
      w.volume+=usd; w.trades++; w.biggest=Math.max(w.biggest,usd);
      if((t.side||'').toUpperCase()==='BUY')w.buys++; else w.sells++;
      if(w.recentBets.length<5) w.recentBets.push({ title:(t.title||'').slice(0,40), usd, side:(t.side||'BUY').toUpperCase(), outcome:t.outcome||'?', odds:parseFloat(t.price||0) });
      wallets.set(addr,w);
    }
    res.json(Array.from(wallets.values()).sort((a,b)=>b.volume-a.volume).slice(0,10));
  } catch (e) { res.status(502).json({error:e.message}); }
});

// ── ALL WHALES ───────────────────────────────────────────────────────────────
app.get('/api/allwhales', async (req, res) => {
  const minTrade = parseFloat(req.query.min) || 1;
  try {
    const trades = await cached('trades-3k', fetchAllTrades, 30000);
    const result = trades.map(formatTrade)
      .filter(t => t.usd >= minTrade)
      .sort((a,b) => b.usd - a.usd)
      .slice(0, 100);

    for (const t of result) {
      if (t.usd >= 50000) {
        const raw = trades.find(x => x.proxyWallet===t.fullWallet && parseInt(x.timestamp||0)===t.timestamp);
        if (raw) checkAndNotify(raw);
      }
    }

    res.json({ trades: result, totalFetched: trades.length });
  } catch (e) { res.status(502).json({error:e.message}); }
});

app.listen(PORT, () => console.log('WhaleWatch running at http://localhost:'+PORT));
