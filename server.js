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

// ── MAC NOTIFICATIONS via osascript ──────────────────────────────────────────
const notifiedTrades = new Set();
function macNotify(title, msg, sound) {
  if (process.platform !== 'darwin') return;
  const t = title.replace(/'/g, "\\'");
  const m = msg.replace(/'/g, "\\'");
  try { execSync(`osascript -e 'display notification "${m}" with title "${t}" sound name "${sound}"'`); }
  catch(e) { /* ignore on non-mac / Railway */ }
}

function checkAndNotify(trade) {
  const key = trade.transactionHash || `${trade.proxyWallet}|${trade.timestamp}`;
  if (notifiedTrades.has(key)) return;
  notifiedTrades.add(key);
  if (notifiedTrades.size > 5000) {
    const arr = [...notifiedTrades]; notifiedTrades.clear();
    arr.slice(-2000).forEach(k => notifiedTrades.add(k));
  }
  const usd = parseFloat(trade.size || 0) * parseFloat(trade.price || 0);
  const wallet = trade.proxyWallet ? trade.proxyWallet.slice(0, 6) + '…' + trade.proxyWallet.slice(-4) : '?';
  if (usd >= 10000) {
    const icon = usd >= 1000000 ? '🚨' : usd >= 50000 ? '🐳' : '🎯';
    macNotify(
      `${icon} WAR WHALE — $${Math.round(usd).toLocaleString()}`,
      `${wallet} bet $${Math.round(usd).toLocaleString()} on "${(trade.title || '').slice(0, 50)}"`,
      usd >= 50000 ? 'Submarine' : 'Ping'
    );
  }
}

// ── TEAM MATCHING ────────────────────────────────────────────────────────────
function teamsMatch(team, title) {
  const t = team.toLowerCase(), ti = title.toLowerCase();
  if (ti.includes(t)) return true;
  const words = t.split(' ');
  if (words.length >= 2) { const two = words.slice(-2).join(' '); if (two.length > 5 && ti.includes(two)) return true; }
  const last = words[words.length - 1];
  return last.length > 4 && ti.includes(last);
}

app.use(express.static(path.join(__dirname)));

// ── MLB TODAY ────────────────────────────────────────────────────────────────
app.get('/api/mlb', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [games, polyEvents] = await Promise.all([
      cached('mlb-' + today, async () => {
        const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,team`);
        if (!r.ok) throw new Error('MLB API ' + r.status);
        const d = await r.json();
        return (d.dates || [])[0]?.games || [];
      }, 120000),
      cached('poly-mlb', async () => {
        const r = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=mlb&limit=200');
        if (!r.ok) return [];
        return r.json();
      }, 120000)
    ]);

    // Track previous odds for sharp detection
    const prevOdds = cache.get('mlb-prev-odds')?.data || {};

    const result = games.map(g => {
      const away = g.teams.away.team.name;
      const home = g.teams.home.team.name;
      const matched = polyEvents.filter(e => teamsMatch(away, e.title || '') && teamsMatch(home, e.title || ''));

      let moneyline = null, ou = null;
      let totalVol = 0, vol24 = 0;
      const allConditionIds = [];
      for (const evt of matched) {
        totalVol += parseFloat(evt.volume || 0);
        vol24 += parseFloat(evt.volume24hr || 0);
        for (const m of (evt.markets || [])) {
          if (m.conditionId) allConditionIds.push(m.conditionId);
          const q = (m.question || '').toLowerCase();
          const prices = parseJSON(m.outcomePrices).map(Number);
          // Filter broken markets: both prices must be between 5% and 95%
          const valid = prices.length >= 2 && prices[0] > 0.05 && prices[0] < 0.95 && prices[1] > 0.05 && prices[1] < 0.95;
          if (!q.includes('o/u') && !q.includes('spread') && !q.includes('first inning') && !moneyline && valid) {
            moneyline = { prices, outcomes: parseJSON(m.outcomes), vol: parseFloat(m.volume || 0), question: m.question, conditionId: m.conditionId || '' };
          }
          if (q.includes('o/u') && !ou && valid) {
            ou = { prices, question: m.question, line: (m.question || '').match(/O\/U\s*([\d.]+)/i)?.[1] || '?', conditionId: m.conditionId || '' };
          }
        }
      }

      // Sharp detection: compare current odds to previous snapshot
      const mlKey = `${away}@${home}`;
      const prevAway = prevOdds[mlKey];
      const currAway = moneyline?.prices?.[0] || 0;
      const delta = prevAway != null ? currAway - prevAway : 0;
      const isSharp = Math.abs(delta) >= 0.05;

      return {
        away, home,
        gameTime: g.gameDate,
        status: g.status.detailedState,
        awayRec: `${g.teams.away.leagueRecord?.wins || 0}-${g.teams.away.leagueRecord?.losses || 0}`,
        homeRec: `${g.teams.home.leagueRecord?.wins || 0}-${g.teams.home.leagueRecord?.losses || 0}`,
        moneyline, ou, allConditionIds,
        totalVol, vol24,
        delta: parseFloat(delta.toFixed(4)),
        isSharp
      };
    });

    // Save current odds as "previous" for next refresh
    const newPrev = {};
    result.forEach(g => { if (g.moneyline) newPrev[`${g.away}@${g.home}`] = g.moneyline.prices[0]; });
    cache.set('mlb-prev-odds', { data: newPrev, ts: Date.now() });

    res.json(result);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── MLB TRADES per game ──────────────────────────────────────────────────────
app.get('/api/mlb/trades/:conditionIds', async (req, res) => {
  const targetIds = new Set(req.params.conditionIds.split(',').filter(Boolean));
  if (!targetIds.size) return res.json([]);
  try {
    const allTrades = await cached('all-trades', async () => {
      const r = await fetch('https://data-api.polymarket.com/trades?limit=2000', { headers: { Accept: 'application/json' } });
      return r.ok ? r.json() : [];
    }, 30000);
    const result = (Array.isArray(allTrades) ? allTrades : [])
      .filter(t => targetIds.has(t.conditionId))
      .map(t => ({
        wallet: t.proxyWallet ? t.proxyWallet.slice(0, 5) + '…' + t.proxyWallet.slice(-3) : '?',
        fullWallet: t.proxyWallet || '',
        pseudonym: t.pseudonym || '',
        usd: parseFloat(t.size || 0) * parseFloat(t.price || 0),
        odds: parseFloat(t.price || 0),
        side: (t.side || 'BUY').toUpperCase(),
        outcome: t.outcome || '?',
        title: t.title || '',
        timestamp: parseInt(t.timestamp || 0),
        flag: (() => { const u = parseFloat(t.size||0)*parseFloat(t.price||0); return u>=1e6?'🚨':u>=50000?'🐳':u>=5000?'🎯':''; })()
      }))
      .filter(t => t.usd >= 100)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 30);
    res.json(result);
  } catch (e) { res.json([]); }
});

// ── WAR / GEOPOLITICAL INTEL ─────────────────────────────────────────────────
const WAR_TAGS = ['iran', 'israel', 'middle-east', 'china', 'ukraine', 'russia', 'nuclear', 'geopolitics', 'taiwan', 'military'];
const WAR_KW   = ['iran', 'israel', 'war', 'military', 'nuclear', 'russia', 'ukraine', 'china', 'taiwan', 'invade', 'strike', 'bomb', 'missile', 'troops', 'ceasefire', 'regime'];

app.get('/api/war', async (req, res) => {
  try {
    // 1. Fetch events from all war-related tags in parallel
    const allEvents = await cached('war-events', async () => {
      const results = await Promise.all(WAR_TAGS.map(async tag => {
        try {
          const r = await fetch(`https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=${tag}&limit=100`);
          return r.ok ? r.json() : [];
        } catch { return []; }
      }));
      // Deduplicate by event id
      const seen = new Set();
      const merged = [];
      for (const batch of results) {
        for (const e of batch) {
          if (!seen.has(e.id)) { seen.add(e.id); merged.push(e); }
        }
      }
      // Filter to those matching war keywords in title
      return merged.filter(e => {
        const t = (e.title || '').toLowerCase();
        return WAR_KW.some(kw => t.includes(kw));
      });
    }, 120000);

    // 2. Extract markets with conditionIds
    const markets = [];
    for (const evt of allEvents) {
      for (const m of (evt.markets || [])) {
        const prices = parseJSON(m.outcomePrices).map(Number);
        if (!prices.length) continue;
        markets.push({
          question: m.question || evt.title,
          conditionId: m.conditionId || '',
          yesPrice: prices[0] || 0,
          noPrice: prices[1] || 0,
          volume: parseFloat(m.volume || 0),
          volume24hr: parseFloat(m.volume24hr || evt.volume24hr || 0),
          endDate: m.endDate || evt.endDate || ''
        });
      }
    }
    // Sort by volume descending
    markets.sort((a, b) => b.volume - a.volume);

    // 3. Fetch recent trades and match to war conditionIds
    const conditionIds = new Set(markets.map(m => m.conditionId).filter(Boolean));
    const allTrades = await cached('war-trades', async () => {
      const r = await fetch('https://data-api.polymarket.com/trades?limit=2000', { headers: { Accept: 'application/json' } });
      return r.ok ? r.json() : [];
    }, 30000);

    // Map conditionId -> trades
    const tradesByMarket = {};
    for (const t of (Array.isArray(allTrades) ? allTrades : [])) {
      if (!conditionIds.has(t.conditionId)) continue;
      const usd = parseFloat(t.size || 0) * parseFloat(t.price || 0);
      const cid = t.conditionId;
      if (!tradesByMarket[cid]) tradesByMarket[cid] = [];

      const trade = {
        wallet: t.proxyWallet ? t.proxyWallet.slice(0, 5) + '…' + t.proxyWallet.slice(-3) : '?',
        fullWallet: t.proxyWallet || '',
        pseudonym: t.pseudonym || '',
        usd,
        odds: parseFloat(t.price || 0),
        side: (t.side || 'BUY').toUpperCase(),
        outcome: t.outcome || '?',
        timestamp: parseInt(t.timestamp || 0),
        title: t.title || '',
        flag: usd >= 1000000 ? '🚨' : usd >= 50000 ? '🐳' : usd >= 5000 ? '🎯' : ''
      };
      if (usd >= 100) tradesByMarket[cid].push(trade);  // $100 minimum

      // Fire mac notification for war whale trades
      checkAndNotify(t);
    }

    // Sort trades within each market by largest first
    for (const cid of Object.keys(tradesByMarket)) {
      tradesByMarket[cid].sort((a, b) => b.usd - a.usd);
    }

    // Build top whale trades list across ALL war markets for the alert banner
    const allWarTrades = Object.values(tradesByMarket).flat().sort((a, b) => b.usd - a.usd);
    const topWhales = allWarTrades.filter(t => t.usd >= 1000).slice(0, 10);

    // Attach trades to markets
    const result = markets.map(m => ({
      ...m,
      trades: (tradesByMarket[m.conditionId] || []).slice(0, 20)
    }));

    res.json({ markets: result, topWhales });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── WALLET TRACKER (aggregated from trades) ──────────────────────────────────
app.get('/api/wallets', async (req, res) => {
  try {
    const trades = await cached('wallet-trades', async () => {
      const r = await fetch('https://data-api.polymarket.com/trades?limit=2000', { headers: { Accept: 'application/json' } });
      return r.ok ? r.json() : [];
    }, 60000);

    const wallets = new Map();
    for (const t of (Array.isArray(trades) ? trades : [])) {
      const addr = t.proxyWallet; if (!addr) continue;
      const usd = parseFloat(t.size || 0) * parseFloat(t.price || 0);
      const w = wallets.get(addr) || {
        address: addr, short: addr.slice(0, 5) + '…' + addr.slice(-3),
        pseudonym: t.pseudonym || '', volume: 0, trades: 0, biggest: 0,
        buys: 0, sells: 0, recentBets: []
      };
      w.volume += usd; w.trades++; w.biggest = Math.max(w.biggest, usd);
      if ((t.side || '').toUpperCase() === 'BUY') w.buys++; else w.sells++;
      if (w.recentBets.length < 5) {
        w.recentBets.push({
          title: (t.title || '').slice(0, 40), usd,
          side: (t.side || 'BUY').toUpperCase(),
          outcome: t.outcome || '?',
          odds: parseFloat(t.price || 0)
        });
      }
      wallets.set(addr, w);
    }

    const top = Array.from(wallets.values())
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 10);
    res.json(top);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.listen(PORT, () => console.log('WhaleWatch running at http://localhost:' + PORT));
