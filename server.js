const express = require('express');
const fetch   = (...args) => import('node-fetch').then(({default:f}) => f(...args));
const path    = require('path');
const fs      = require('fs');
const { execSync } = require('child_process');
const app     = express();
const PORT    = process.env.PORT || 3000;
const TRADES_FILE = path.join(__dirname, 'trades_history.json');

// ── EASTERN TIME ─────────────────────────────────────────────────────────────
function todayMidnightET() {
  const etDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const ms = new Date(etDate + 'T00:00:00-04:00').getTime();
  return { ms, sec: Math.floor(ms/1000), date: etDate };
}
function todayDateET() {
  return new Date().toLocaleDateString('en-US', { timeZone:'America/New_York', weekday:'long', year:'numeric', month:'long', day:'numeric' });
}

// ── CACHE ────────────────────────────────────────────────────────────────────
const cache = new Map();
function cached(key, fn, ttl=45000) {
  const hit = cache.get(key);
  if (hit && Date.now()-hit.ts < ttl) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, {data, ts:Date.now()}); return data; });
}
function parseJSON(s) { try { return JSON.parse(s||'[]'); } catch { return []; } }

// ── PERSISTENT TRADE STORE ───────────────────────────────────────────────────
let tradeStore = new Map();
function tradeKey(t) { return t.transactionHash || `${t.proxyWallet||''}|${t.timestamp||''}|${t.size||''}`; }

function loadStore() {
  try {
    if (!fs.existsSync(TRADES_FILE)) return;
    const { sec } = todayMidnightET();
    const arr = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    let loaded = 0;
    for (const t of arr) { if (parseInt(t.timestamp||0) >= sec) { tradeStore.set(tradeKey(t), t); loaded++; } }
    console.log(`Loaded ${loaded} today trades from disk`);
  } catch(e) { console.error('Load error:', e.message); }
}
let saveTimer;
function persistStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(TRADES_FILE, JSON.stringify([...tradeStore.values()])); } catch(e) {}
  }, 3000);
}
function mergeTrades(fresh) {
  if (!Array.isArray(fresh)) return 0;
  const { sec } = todayMidnightET();
  let added = 0;
  for (const t of fresh) {
    const key = tradeKey(t);
    if (tradeStore.has(key)) continue;
    if (parseInt(t.timestamp||0) < sec) continue; // today only
    tradeStore.set(key, t); added++;
  }
  // Prune yesterday
  for (const [k,t] of tradeStore) { if (parseInt(t.timestamp||0) < sec) tradeStore.delete(k); }
  if (added > 0) persistStore();
  return added;
}
function todayTrades() {
  const { sec } = todayMidnightET();
  return [...tradeStore.values()].filter(t => parseInt(t.timestamp||0) >= sec).sort((a,b) => parseInt(b.timestamp||0)-parseInt(a.timestamp||0));
}
loadStore();

// ── PAGINATED FETCHER ────────────────────────────────────────────────────────
let lastFetchTime = 0, lastFetchAdded = 0;
async function fetchAndMerge() {
  const pages = await Promise.all([0,1000,2000,3000,4000].map(async off => {
    try { const r = await fetch(`https://data-api.polymarket.com/trades?limit=1000&offset=${off}`, {headers:{Accept:'application/json'}}); return r.ok ? r.json() : []; }
    catch { return []; }
  }));
  const fresh = pages.flat();
  const added = mergeTrades(fresh);
  lastFetchTime = Date.now();
  lastFetchAdded = added;
  console.log(`[FETCH] ${new Date().toLocaleTimeString()} | ${fresh.length} fetched | ${added} new | ${tradeStore.size} stored`);
  return { fetched: fresh.length, added, stored: tradeStore.size, fetchedAt: lastFetchTime };
}

// Force refresh (bypasses cache)
app.get('/api/force-refresh', async (req, res) => {
  try {
    cache.delete('fetch-merge'); // bust cache
    const result = await fetchAndMerge();
    res.json(result);
  } catch(e) { res.status(502).json({error:e.message}); }
});

// (featured match removed)

// ── NOTIFICATIONS ────────────────────────────────────────────────────────────
const notified = new Set();
function checkNotify(t) {
  const key = t.transactionHash || `${t.proxyWallet}|${t.timestamp}`;
  if (notified.has(key)) return;
  notified.add(key);
  if (notified.size > 5000) { const a=[...notified]; notified.clear(); a.slice(-2000).forEach(k=>notified.add(k)); }
  const usd = parseFloat(t.size||0)*parseFloat(t.price||0);
  if (usd >= 10000 && process.platform === 'darwin') {
    const w = t.proxyWallet ? t.proxyWallet.slice(0,6)+'…'+t.proxyWallet.slice(-4) : '?';
    const icon = usd>=1e6?'🚨':usd>=50000?'🐳':'🎯';
    try { execSync(`osascript -e 'display notification "${w} $${Math.round(usd).toLocaleString()} on ${(t.title||'').slice(0,40).replace(/'/g,"\\'")}..." with title "${icon} WHALE" sound name "${usd>=50000?'Submarine':'Ping'}"'`); } catch {}
  }
}

// ── TRADE FORMATTER ──────────────────────────────────────────────────────────
function fmtTrade(t) {
  const usd = parseFloat(t.size||0)*parseFloat(t.price||0);
  const odds = parseFloat(t.price||0);
  const payout = odds>0 && odds<1 ? usd/odds-usd : 0;
  return {
    id: tradeKey(t), wallet: t.proxyWallet ? t.proxyWallet.slice(0,5)+'…'+t.proxyWallet.slice(-3) : '?',
    fullWallet: t.proxyWallet||'', pseudonym: t.pseudonym||'',
    usd, odds, payout, side: (t.side||'BUY').toUpperCase(), outcome: t.outcome||'?',
    title: t.title||'', timestamp: parseInt(t.timestamp||0),
    flag: usd>=1e6?'🚨':usd>=50000?'🐳':(usd>=5000||(odds<=0.20&&usd>=500))?'🎯':''
  };
}

// ── CATEGORIES ───────────────────────────────────────────────────────────────
const CAT_RULES = [
  ['MLB',['yankees','dodgers','cubs','padres','braves','mets','astros','phillies','rangers','orioles','tigers','twins','mariners','guardians','royals','red sox','white sox','rays','marlins','reds','pirates','cardinals','nationals','brewers','rockies','angels','giants','athletics','blue jays','diamondbacks']],
  ['NHL',['nhl','stanley cup','bruins','hurricanes','panthers','maple leafs','jets','oilers','avalanche','stars','lightning','wild','capitals','penguins','islanders','devils','senators','canadiens','flames','canucks','predators','kraken','blackhawks','sabres','flyers','red wings','golden knights','ducks','blue jackets','sharks']],
  ['NBA',['nba','lakers','celtics','warriors','bucks','76ers','knicks','nets','heat','suns','nuggets','thunder','timberwolves','cavaliers','magic','pacers','hawks','bulls','rockets','grizzlies','pelicans','kings','clippers','spurs','raptors','pistons','hornets','wizards','blazers','jazz','trail blazers']],
  ['Soccer',['champions league','ucl','uefa','premier league','serie a','la liga','fc ','real madrid','barcelona','arsenal','liverpool','chelsea','man city','psg','bayern']],
  ['Golf',['masters','golf','pga','augusta']],
  ['War',['iran','israel','war','nuclear','ukraine','russia','china','taiwan','military','regime']],
  ['Crypto',['bitcoin','ethereum','btc','eth','crypto','solana','dogecoin']],
];
const SPORT_ICONS = {MLB:'⚾',NHL:'🏒',NBA:'🏀',Soccer:'⚽',Golf:'⛳',War:'🚨',Crypto:'₿',Other:'📊'};
function categorize(title) {
  const t = (title||'').toLowerCase();
  for (const [cat,kws] of CAT_RULES) { if (kws.some(kw => t.includes(kw))) return cat; }
  return 'Other';
}

// ── WALLET CONSOLIDATION ─────────────────────────────────────────────────────
function consolidateTrades(trades) {
  // Group by wallet+outcome (same wallet same side = consolidate)
  const groups = new Map();
  for (const t of trades) {
    const key = `${t.fullWallet}|${t.outcome}|${t.side}`;
    const g = groups.get(key);
    if (g) { g.totalUsd += t.usd; g.count++; g.trades.push(t); }
    else groups.set(key, { ...t, totalUsd: t.usd, count: 1, trades: [t] });
  }
  return [...groups.values()].sort((a,b) => b.totalUsd - a.totalUsd).map(g => {
    if (g.count === 1) return g.trades[0];
    // Consolidated entry
    const best = g.trades.sort((a,b)=>b.usd-a.usd)[0];
    return { ...best, usd: g.totalUsd, consolidated: g.count,
      flag: g.totalUsd>=1e6?'🚨':g.totalUsd>=50000?'🐳':g.totalUsd>=5000?'🎯':'' };
  });
}

app.use(express.static(path.join(__dirname)));

// ── SUMMARY ──────────────────────────────────────────────────────────────────
app.get('/api/summary', async (req, res) => {
  try {
    await cached('fetch-merge', fetchAndMerge, 15000);
    const today = todayTrades();
    let totalVol=0, biggest=null, bigUsd=0;
    const mktVol = new Map(), walVol = new Map();
    for (const t of today) {
      const usd = parseFloat(t.size||0)*parseFloat(t.price||0);
      totalVol += usd;
      if (usd > bigUsd) { bigUsd=usd; biggest=t; }
      mktVol.set(t.title||'?', (mktVol.get(t.title||'?')||0)+usd);
      walVol.set(t.proxyWallet||'', (walVol.get(t.proxyWallet||'')||0)+usd);
    }
    let topMkt=null, topMktV=0; for (const [k,v] of mktVol) if(v>topMktV){topMktV=v;topMkt=k;}
    let topWal=null, topWalV=0; for (const [k,v] of walVol) if(v>topWalV){topWalV=v;topWal=k;}
    res.json({
      totalVolume:totalVol, tradeCount:today.length, storedTotal:tradeStore.size,
      biggestTrade: biggest ? {usd:bigUsd, title:(biggest.title||'').slice(0,50), wallet:biggest.proxyWallet?biggest.proxyWallet.slice(0,5)+'…'+biggest.proxyWallet.slice(-3):'?'} : null,
      topMarket: topMkt ? {title:topMkt.slice(0,50), volume:topMktV} : null,
      topWallet: topWal ? {address:topWal.slice(0,5)+'…'+topWal.slice(-3), volume:topWalV} : null
    });
  } catch(e) { res.status(502).json({error:e.message}); }
});

// ── MLB (game-structured) ────────────────────────────────────────────────────
function teamsMatch(team, title) {
  const t=team.toLowerCase(), ti=title.toLowerCase();
  if (ti.includes(t)) return true;
  const w=t.split(' ');
  if (w.length>=2){const two=w.slice(-2).join(' '); if(two.length>5&&ti.includes(two)) return true;}
  return w[w.length-1].length>4 && ti.includes(w[w.length-1]);
}

app.get('/api/mlb', async (req, res) => {
  const min = parseFloat(req.query.min) || 1;
  try {
    const today = new Date().toISOString().slice(0,10);
    const [games, polyEvents] = await Promise.all([
      cached('mlb-sched', async () => {
        const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,team`);
        if (!r.ok) return [];
        return ((await r.json()).dates||[])[0]?.games || [];
      }, 120000),
      cached('events-mlb', async () => {
        const r = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=mlb&limit=200');
        return r.ok ? r.json() : [];
      }, 120000)
    ]);
    await cached('fetch-merge', fetchAndMerge, 15000);
    const pool = todayTrades();

    const result = games.map(g => {
      const away = g.teams.away.team.name, home = g.teams.home.team.name;
      const awayPP = (g.teams.away.probablePitcher||{}).fullName||'TBD';
      const homePP = (g.teams.home.probablePitcher||{}).fullName||'TBD';
      const matched = polyEvents.filter(e => teamsMatch(away,e.title||'') && teamsMatch(home,e.title||''));

      // Classify markets per game
      let ml=null, ou=null;
      const mlCids=[], ouCids=[], allCids=[];
      for (const evt of matched) {
        for (const m of (evt.markets||[])) {
          if (!m.conditionId) continue;
          allCids.push(m.conditionId);
          const q = (m.question||'').toLowerCase();
          const prices = parseJSON(m.outcomePrices).map(Number);
          const live = prices.length>=2 && prices[0]>0.01 && prices[0]<0.99;
          if (!live) continue;
          if (q.includes('o/u')) {
            ouCids.push(m.conditionId);
            if (!ou) ou = { prices, line:(m.question||'').match(/O\/U\s*([\d.]+)/i)?.[1]||'?' };
          } else if (!q.includes('spread') && !q.includes('first inning')) {
            mlCids.push(m.conditionId);
            if (!ml && prices[0]>0.15 && prices[0]<0.85) ml = { prices, outcomes:parseJSON(m.outcomes) };
          }
        }
      }

      // Match trades to this game, split by ML vs O/U
      const mlSet=new Set(mlCids), ouSet=new Set(ouCids), allSet=new Set(allCids);
      const mlTrades=[], ouTrades=[], otherTrades=[];
      for (const t of pool) {
        if (!allSet.has(t.conditionId)) continue;
        const trade = fmtTrade(t);
        if (trade.usd < min || trade.odds>=0.99 || trade.odds<=0.001) continue;
        if (mlSet.has(t.conditionId)) mlTrades.push(trade);
        else if (ouSet.has(t.conditionId)) ouTrades.push(trade);
        else otherTrades.push(trade);
      }
      mlTrades.sort((a,b)=>b.usd-a.usd);
      ouTrades.sort((a,b)=>b.usd-a.usd);
      otherTrades.sort((a,b)=>b.usd-a.usd);

      const totalVol = mlTrades.concat(ouTrades,otherTrades).reduce((s,t)=>s+t.usd,0);
      const allGameTrades = mlTrades.concat(ouTrades,otherTrades);

      return {
        away, home, awayPitcher:awayPP, homePitcher:homePP,
        gameTime:g.gameDate, status:g.status.detailedState,
        awayRec:`${g.teams.away.leagueRecord?.wins||0}-${g.teams.away.leagueRecord?.losses||0}`,
        homeRec:`${g.teams.home.leagueRecord?.wins||0}-${g.teams.home.leagueRecord?.losses||0}`,
        moneyline:ml, ou,
        mlTrades: consolidateTrades(mlTrades).slice(0,15),
        ouTrades: consolidateTrades(ouTrades).slice(0,15),
        otherTrades: consolidateTrades(otherTrades).slice(0,10),
        totalWhaleVol: totalVol,
        tradeCount: allGameTrades.length,
        hot: totalVol >= 5000
      };
    });

    // Sort: hot games first, then by total whale volume
    result.sort((a,b) => (b.hot?1:0)-(a.hot?1:0) || b.totalWhaleVol-a.totalWhaleVol);

    res.json({ games:result, todayCount:pool.length, stored:tradeStore.size });
  } catch(e) { res.status(502).json({error:e.message}); }
});

// ── UNIFIED SPORT ENDPOINT ───────────────────────────────────────────────────
// /api/sport/mlb, /api/sport/nhl, /api/sport/nba, /api/sport/ucl, /api/sport/golf, /api/sport/war
const SPORT_TAGS = {
  mlb: ['mlb'],
  nhl: ['nhl','stanley-cup','hockey'],
  nba: ['nba','basketball'],
  ucl: ['champions-league','ucl','uefa'],
  golf: ['golf','masters','the-masters','pga','augusta'],
  war: ['iran','israel','middle-east','china','ukraine','russia','nuclear','geopolitics','taiwan','military'],
};
const WAR_KW = ['iran','israel','war','military','nuclear','russia','ukraine','china','taiwan','invade','strike','bomb','missile','troops','ceasefire','regime'];

app.get('/api/sport/:cat', async (req, res) => {
  const cat = req.params.cat;
  const min = parseFloat(req.query.min) || 1000;
  const tags = SPORT_TAGS[cat];
  if (!tags) return res.status(404).json({error:'Unknown category'});

  try {
    const allEvents = await cached(`events-${cat}`, async () => {
      const results = await Promise.all(tags.map(async tag => {
        try { const r = await fetch(`https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=${tag}&limit=100`); return r.ok ? r.json() : []; }
        catch { return []; }
      }));
      const seen = new Set(), merged = [];
      for (const b of results) for (const e of b) { if (!seen.has(e.id)) { seen.add(e.id); merged.push(e); } }
      if (cat === 'war') return merged.filter(e => WAR_KW.some(kw => (e.title||'').toLowerCase().includes(kw)));
      return merged;
    }, 120000);

    // Extract markets (skip settled)
    const markets = [];
    for (const evt of allEvents) {
      for (const m of (evt.markets||[])) {
        const prices = parseJSON(m.outcomePrices).map(Number);
        if (!prices.length) continue;
        const yp = prices[0]||0;
        if (yp<=0.005 || yp>=0.995) continue;
        const q = m.question||'';
        let label = q.replace(/^Will\s+(the\s+)?/i,'').replace(/\s+(win|finish|shoot|make|play|be |reach|record|score|have ).*$/i,'').trim();
        if (label.length > 40) label = label.slice(0,40);
        const isGame = / vs/.test(evt.title||'');
        markets.push({
          label, question:q, event:evt.title||'', isGame,
          conditionId: m.conditionId||'',
          yesPrice:yp, noPrice:prices[1]||0,
          volume: parseFloat(m.volume||0),
          volume24hr: parseFloat(m.volume24hr||evt.volume24hr||0)
        });
      }
    }

    // Match trades from store
    await cached('fetch-merge', fetchAndMerge, 15000);
    const pool = todayTrades();
    const cids = new Set(markets.map(m=>m.conditionId).filter(Boolean));
    const byMkt = {};
    const labelWallets = {};

    for (const t of pool) {
      if (!cids.has(t.conditionId)) continue;
      const trade = fmtTrade(t);
      if (trade.usd < min) continue;
      if (trade.odds >= 0.99 || trade.odds <= 0.001) continue;
      const c = t.conditionId;
      if (!byMkt[c]) byMkt[c] = [];
      byMkt[c].push(trade);
      const mkt = markets.find(m => m.conditionId === c);
      if (mkt) {
        if (!labelWallets[mkt.label]) labelWallets[mkt.label] = new Set();
        labelWallets[mkt.label].add(trade.fullWallet);
      }
      checkNotify(t);
    }
    for (const c of Object.keys(byMkt)) byMkt[c].sort((a,b) => b.usd-a.usd);

    const sharpLabels = Object.entries(labelWallets)
      .filter(([,ws]) => ws.size >= 3)
      .map(([label,ws]) => ({label, wallets:ws.size}))
      .sort((a,b) => b.wallets-a.wallets).slice(0,10);

    // Consolidate trades per market (dedup same wallet+outcome)
    const result = markets.filter(m => m.volume24hr>0 || (byMkt[m.conditionId]||[]).length>0)
      .map(m => {
        const raw = (byMkt[m.conditionId]||[]).slice(0,30);
        return { ...m, trades: consolidateTrades(raw), rawCount: raw.length,
          uniqueWallets: labelWallets[m.label] ? labelWallets[m.label].size : 0 };
      })
      .sort((a,b) => {
        if (a.trades.length !== b.trades.length) return b.trades.length - a.trades.length;
        return b.volume24hr - a.volume24hr;
      });

    // For MLB, also include game schedule
    let schedule = null;
    if (cat === 'mlb') {
      schedule = await cached('mlb-sched', async () => {
        const today = new Date().toISOString().slice(0,10);
        const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,team`);
        if (!r.ok) return [];
        return ((await r.json()).dates||[])[0]?.games || [];
      }, 120000);
    }

    res.json({ events:allEvents.length, markets:result, sharpLabels, schedule, todayCount:pool.length, stored:tradeStore.size });
  } catch(e) { res.status(502).json({error:e.message}); }
});

// ── ALL WHALES + TRENDING ────────────────────────────────────────────────────
app.get('/api/allwhales', async (req, res) => {
  const min = parseFloat(req.query.min)||1000;
  try {
    await cached('fetch-merge', fetchAndMerge, 15000);
    const pool = todayTrades();
    const all = pool.map(fmtTrade).filter(t => t.usd>=min && t.odds<0.99 && t.odds>0.001);

    // Consolidate + categorize
    const consolidated = consolidateTrades(all).slice(0, 200).map(t => {
      t.sportIcon = SPORT_ICONS[categorize(t.title)] || '';
      t.category = categorize(t.title);
      return t;
    });

    // Breakdown
    const breakdown = {};
    for (const t of pool) {
      const cat = categorize(t.title||'');
      const usd = parseFloat(t.size||0)*parseFloat(t.price||0);
      if (!breakdown[cat]) breakdown[cat] = {count:0, volume:0};
      breakdown[cat].count++; breakdown[cat].volume += usd;
    }

    // TRENDING: markets with most unique wallets in last hour
    const oneHourAgo = Math.floor(Date.now()/1000) - 3600;
    const recentTrades = pool.filter(t => parseInt(t.timestamp||0) >= oneHourAgo);
    const mktActivity = {};
    for (const t of recentTrades) {
      const title = t.title||'?';
      if (!mktActivity[title]) mktActivity[title] = { title, wallets: new Set(), volume: 0, count: 0 };
      mktActivity[title].wallets.add(t.proxyWallet||'');
      mktActivity[title].volume += parseFloat(t.size||0)*parseFloat(t.price||0);
      mktActivity[title].count++;
    }
    const trending = Object.values(mktActivity)
      .filter(m => m.wallets.size >= 2)
      .map(m => ({ title: m.title, wallets: m.wallets.size, volume: m.volume, trades: m.count, icon: SPORT_ICONS[categorize(m.title)]||'' }))
      .sort((a,b) => b.wallets - a.wallets)
      .slice(0, 5);

    const newest = pool.length ? parseInt(pool[0].timestamp||0) : 0;
    res.json({ trades:consolidated, todayDate:todayDateET(), todayCount:pool.length, stored:tradeStore.size, breakdown, trending, lastFetchTime, lastFetchAdded, newestTradeTs:newest });
  } catch(e) { res.status(502).json({error:e.message}); }
});

// ── SMART MONEY / WALLET P&L ─────────────────────────────────────────────────
const WATCHLIST_FILE = path.join(__dirname, 'watchlist.json');
function loadWatchlist() { try { return fs.existsSync(WATCHLIST_FILE) ? JSON.parse(fs.readFileSync(WATCHLIST_FILE,'utf8')) : []; } catch { return []; } }
function saveWatchlist(list) { try { fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list)); } catch {} }

app.get('/api/smart-money', async (req, res) => {
  try {
    const lb = await cached('sm-leaderboard', async () => {
      const r = await fetch('https://data-api.polymarket.com/v1/leaderboard?category=SPORTS&timePeriod=MONTH&orderBy=PNL&limit=25');
      if (!r.ok) throw new Error('Leaderboard API '+r.status);
      return r.json();
    }, 300000);

    // Fetch positions + activity for ALL 25 wallets
    const details = await Promise.all(lb.map(async (w) => {
      const addr = w.proxyWallet;
      return cached(`sm-${addr}`, async () => {
        const [posRes, actRes] = await Promise.allSettled([
          fetch(`https://data-api.polymarket.com/positions?user=${addr}&limit=20&sizeThreshold=0.1`).then(r=>r.ok?r.json():[]),
          fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=15`).then(r=>r.ok?r.json():[])
        ]);
        const posArr = Array.isArray(posRes.value) ? posRes.value : [];
        const actArr = Array.isArray(actRes.value) ? actRes.value : [];

        const pnl = parseFloat(w.pnl||0);
        const vol = parseFloat(w.vol||0);
        const rank = parseInt(w.rank||999);

        // Win rate from settled positions
        const settled = posArr.filter(p => {
          const cp = parseFloat(p.curPrice||0);
          return cp === 0 || cp === 1 || parseFloat(p.redeemable||0) > 0;
        });
        const wins = settled.filter(p => parseFloat(p.cashPnl||0) > 0).length;
        const winRate = settled.length > 0 ? wins/settled.length : 0;
        const roi = vol > 0 ? (pnl/vol)*100 : 0;

        // Open positions
        const openPositions = posArr
          .filter(p => parseFloat(p.size||0)>0.1 && parseFloat(p.curPrice||0)>0 && parseFloat(p.curPrice||0)<1)
          .map(p => ({
            title:(p.title||'').slice(0,55), outcome:p.outcome||'?',
            size:parseFloat(p.size||0), avgPrice:parseFloat(p.avgPrice||0),
            curPrice:parseFloat(p.curPrice||0), currentValue:parseFloat(p.currentValue||0),
            cashPnl:parseFloat(p.cashPnl||0), percentPnl:parseFloat(p.percentPnl||0)
          }))
          .sort((a,b) => Math.abs(b.size*b.curPrice)-Math.abs(a.size*a.curPrice))
          .slice(0,15);

        // Recent trades
        const recentTrades = actArr.filter(a=>a.type==='TRADE').map(a=>({
          title:(a.title||'').slice(0,50), side:(a.side||'BUY').toUpperCase(),
          outcome:a.outcome||'?', usd:parseFloat(a.usdcSize||0),
          price:parseFloat(a.price||0), timestamp:parseInt(a.timestamp||0),
          verified:!!a.transactionHash
        })).slice(0,15);

        const openPnl = openPositions.reduce((s,p)=>s+p.cashPnl,0);

        // Sharp rating
        let rating='📊 AVERAGE', ratingClass='avg';
        if (rank<=5 && winRate>=0.60) { rating='🔥 ELITE'; ratingClass='elite'; }
        else if (pnl>0 && winRate>=0.55) { rating='⚡ SHARP'; ratingClass='sharp'; }
        else if (pnl<-10000) { rating='❌ FADE'; ratingClass='fade'; }

        return {
          rank, address:addr, short:addr.slice(0,6)+'…'+addr.slice(-4),
          pseudonym: w.userName&&!w.userName.startsWith('0x')?w.userName:'',
          pnl, vol, winRate, roi:parseFloat(roi.toFixed(2)),
          settledCount:settled.length, openCashPnl:openPnl,
          rating, ratingClass,
          lowSample:settled.length<10,
          openPositions, recentTrades
        };
      }, 300000);
    }));

    // Sort: elite first, then by PnL
    const order = {elite:0,sharp:1,avg:2,fade:3};
    details.sort((a,b) => (order[a.ratingClass]||2)-(order[b.ratingClass]||2) || b.pnl-a.pnl);

    res.json({ wallets:details, watchlist:loadWatchlist() });
  } catch(e) { res.status(502).json({error:e.message}); }
});

// Watchlist management
app.post('/api/watchlist', express.json(), (req, res) => {
  const { address, action } = req.body || {};
  if (!address) return res.status(400).json({error:'address required'});
  let list = loadWatchlist();
  if (action === 'remove') list = list.filter(w => w !== address);
  else if (!list.includes(address)) list.push(address);
  saveWatchlist(list);
  res.json({ watchlist: list });
});

app.listen(PORT, () => console.log('WhaleWatch running at http://localhost:'+PORT));
