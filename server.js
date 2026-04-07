const express = require('express');
const fetch   = (...args) => import('node-fetch').then(({default:f}) => f(...args));
const path    = require('path');
const fs      = require('fs');
const { execSync } = require('child_process');
const app     = express();
const PORT    = process.env.PORT || 3000;
const TRADES_FILE = path.join(__dirname, 'trades_history.json');
const SPORTS_KW = ['mlb','nba','nhl','nfl','soccer','football','tennis','atp','wta','serie a','la liga','premier league','champions league','ufc','mma'];
const DAY_MS  = 24*60*60*1000;
const WEEK_MS = 7*DAY_MS;

// ── CACHE ────────────────────────────────────────────────────────────────────
const cache = new Map();
function cached(key, fn, ttl = 45000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttl) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, ts: Date.now() }); return data; });
}
function parseJSON(s) { try { return JSON.parse(s||'[]'); } catch { return []; } }

// ── PERSISTENT TRADE STORE ───────────────────────────────────────────────────
let tradeStore = new Map(); // key -> raw trade object

function tradeKey(t) { return t.transactionHash || `${t.proxyWallet||''}|${t.timestamp||''}|${t.size||''}`; }

function isSports(t) {
  const title = (t.title||'').toLowerCase();
  return SPORTS_KW.some(kw => title.includes(kw));
}

function loadStore() {
  try {
    if (!fs.existsSync(TRADES_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    const now = Date.now();
    let loaded = 0;
    for (const t of arr) {
      const ts = parseInt(t.timestamp||0) * 1000;
      const ttl = isSports(t) ? DAY_MS : WEEK_MS;
      if (now - ts < ttl) { tradeStore.set(tradeKey(t), t); loaded++; }
    }
    console.log(`Loaded ${loaded} trades from disk (pruned expired)`);
  } catch(e) { console.error('Load trades error:', e.message); }
}

let saveTimer;
function persistStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(TRADES_FILE, JSON.stringify([...tradeStore.values()])); }
    catch(e) { console.error('Save trades error:', e.message); }
  }, 3000);
}

function mergeTrades(fresh) {
  if (!Array.isArray(fresh)) return 0;
  const now = Date.now();
  let added = 0;
  for (const t of fresh) {
    const key = tradeKey(t);
    if (tradeStore.has(key)) continue;
    const ts = parseInt(t.timestamp||0) * 1000;
    const ttl = isSports(t) ? DAY_MS : WEEK_MS;
    if (ts > 0 && now - ts > ttl) continue;
    tradeStore.set(key, t);
    added++;
  }
  // Prune expired
  for (const [k, t] of tradeStore) {
    const ts = parseInt(t.timestamp||0) * 1000;
    const ttl = isSports(t) ? DAY_MS : WEEK_MS;
    if (ts > 0 && now - ts > ttl) tradeStore.delete(k);
  }
  if (added > 0) persistStore();
  return added;
}

function allTrades() {
  return [...tradeStore.values()].sort((a,b) => parseInt(b.timestamp||0) - parseInt(a.timestamp||0));
}

loadStore();

// ── PAGINATED FETCHER: 5 pages = 5000 trades ────────────────────────────────
async function fetchAndMerge() {
  const pages = await Promise.all([0,1000,2000,3000,4000].map(async off => {
    try {
      const r = await fetch(`https://data-api.polymarket.com/trades?limit=1000&offset=${off}`, { headers: { Accept:'application/json' } });
      return r.ok ? r.json() : [];
    } catch { return []; }
  }));
  const fresh = pages.flat();
  const added = mergeTrades(fresh);
  return { fetched: fresh.length, added, stored: tradeStore.size };
}

// ── MAC NOTIFICATIONS ────────────────────────────────────────────────────────
const notified = new Set();
function macNotify(title, msg, sound) {
  if (process.platform !== 'darwin') return;
  try { execSync(`osascript -e 'display notification "${msg.replace(/'/g,"\\'")}" with title "${title.replace(/'/g,"\\'")}" sound name "${sound}"'`); } catch {}
}
function checkNotify(t) {
  const key = t.transactionHash || `${t.proxyWallet}|${t.timestamp}`;
  if (notified.has(key)) return;
  notified.add(key);
  if (notified.size > 5000) { const a=[...notified]; notified.clear(); a.slice(-2000).forEach(k=>notified.add(k)); }
  const usd = parseFloat(t.size||0)*parseFloat(t.price||0);
  if (usd >= 10000) {
    const w = t.proxyWallet ? t.proxyWallet.slice(0,6)+'…'+t.proxyWallet.slice(-4) : '?';
    macNotify(`${usd>=1e6?'🚨':usd>=50000?'🐳':'🎯'} WHALE $${Math.round(usd).toLocaleString()}`,
      `${w} on "${(t.title||'').slice(0,50)}"`, usd>=50000?'Submarine':'Ping');
  }
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function teamsMatch(team, title) {
  const t = team.toLowerCase(), ti = title.toLowerCase();
  if (ti.includes(t)) return true;
  const w = t.split(' ');
  if (w.length>=2) { const two=w.slice(-2).join(' '); if (two.length>5&&ti.includes(two)) return true; }
  const last = w[w.length-1];
  return last.length>4 && ti.includes(last);
}

function fmtTrade(t) {
  const usd = parseFloat(t.size||0)*parseFloat(t.price||0);
  const odds = parseFloat(t.price||0);
  const payout = odds>0 && odds<1 ? usd/odds-usd : 0;
  return {
    id: tradeKey(t),
    wallet: t.proxyWallet ? t.proxyWallet.slice(0,5)+'…'+t.proxyWallet.slice(-3) : '?',
    fullWallet: t.proxyWallet||'', pseudonym: t.pseudonym||'',
    usd, odds, payout,
    side: (t.side||'BUY').toUpperCase(), outcome: t.outcome||'?',
    title: t.title||'', timestamp: parseInt(t.timestamp||0),
    flag: usd>=1e6?'🚨':usd>=50000?'🐳':(usd>=5000||(odds<=0.20&&usd>=500))?'🎯':''
  };
}

app.use(express.static(path.join(__dirname)));

// ── TODAY'S SUMMARY ──────────────────────────────────────────────────────────
app.get('/api/summary', async (req, res) => {
  try {
    await cached('fetch-merge', fetchAndMerge, 25000);
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todaySec = Math.floor(todayStart.getTime()/1000);
    const today = allTrades().filter(t => parseInt(t.timestamp||0) >= todaySec);

    let totalVol=0, biggest=null, biggestUsd=0;
    const marketVol = new Map(), walletVol = new Map();
    for (const t of today) {
      const usd = parseFloat(t.size||0)*parseFloat(t.price||0);
      totalVol += usd;
      if (usd > biggestUsd) { biggestUsd=usd; biggest=t; }
      const title = t.title||'Unknown';
      marketVol.set(title, (marketVol.get(title)||0)+usd);
      const addr = t.proxyWallet||'';
      walletVol.set(addr, (walletVol.get(addr)||0)+usd);
    }

    let topMarket = null, topMarketVol = 0;
    for (const [k,v] of marketVol) { if (v>topMarketVol) { topMarketVol=v; topMarket=k; } }
    let topWallet = null, topWalletVol = 0;
    for (const [k,v] of walletVol) { if (v>topWalletVol) { topWalletVol=v; topWallet=k; } }

    res.json({
      totalVolume: totalVol,
      tradeCount: today.length,
      storedTotal: tradeStore.size,
      biggestTrade: biggest ? { usd:biggestUsd, title:(biggest.title||'').slice(0,50), wallet:biggest.proxyWallet?biggest.proxyWallet.slice(0,5)+'…'+biggest.proxyWallet.slice(-3):'?' } : null,
      topMarket: topMarket ? { title:topMarket.slice(0,50), volume:topMarketVol } : null,
      topWallet: topWallet ? { address:topWallet.slice(0,5)+'…'+topWallet.slice(-3), volume:topWalletVol } : null
    });
  } catch(e) { res.status(502).json({error:e.message}); }
});

// ── MLB TODAY ────────────────────────────────────────────────────────────────
app.get('/api/mlb', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const [games, polyEvents] = await Promise.all([
      cached('mlb-'+today, async () => {
        const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,team`);
        if (!r.ok) throw new Error('MLB API '+r.status);
        return ((await r.json()).dates||[])[0]?.games || [];
      }, 120000),
      cached('poly-mlb', async () => {
        const r = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=mlb&limit=200');
        return r.ok ? r.json() : [];
      }, 120000)
    ]);
    await cached('fetch-merge', fetchAndMerge, 25000);
    const pool = allTrades();
    const prevOdds = cache.get('mlb-prev-odds')?.data || {};

    const result = games.map(g => {
      const away=g.teams.away.team.name, home=g.teams.home.team.name;
      const awayPP=g.teams.away.probablePitcher||{}, homePP=g.teams.home.probablePitcher||{};
      const matched = polyEvents.filter(e => teamsMatch(away,e.title||'') && teamsMatch(home,e.title||''));

      let moneyline=null, ou=null, totalVol=0, vol24=0;
      const allCids=[];
      for (const evt of matched) {
        totalVol+=parseFloat(evt.volume||0); vol24+=parseFloat(evt.volume24hr||0);
        for (const m of (evt.markets||[])) {
          if (m.conditionId) allCids.push(m.conditionId);
          const q=(m.question||'').toLowerCase(), prices=parseJSON(m.outcomePrices).map(Number);
          const live = prices.length>=2 && prices[0]>0.01 && prices[0]<0.99;
          const value = prices.length>=2 && prices[0]>0.15 && prices[0]<0.85 && prices[1]>0.15 && prices[1]<0.85;
          if (!q.includes('o/u')&&!q.includes('spread')&&!q.includes('first inning')&&!moneyline&&value)
            moneyline={prices,outcomes:parseJSON(m.outcomes),vol:parseFloat(m.volume||0),question:m.question};
          if (q.includes('o/u')&&!ou&&live)
            ou={prices,question:m.question,line:(m.question||'').match(/O\/U\s*([\d.]+)/i)?.[1]||'?'};
        }
      }

      const awayP=moneyline?.prices?.[0]||0;
      const mispriced=moneyline&&((awayP>0.15&&awayP<0.40)||(awayP>0.60&&awayP<0.85));
      const mlKey=`${away}@${home}`, prevAway=prevOdds[mlKey];
      const delta=prevAway!=null?awayP-prevAway:0, isSharp=Math.abs(delta)>=0.05;

      const cidSet=new Set(allCids);
      const gameTrades=pool.filter(t=>cidSet.has(t.conditionId)).map(fmtTrade).sort((a,b)=>b.usd-a.usd).slice(0,30);

      return {
        away, home, awayPitcher:awayPP.fullName||'TBD', homePitcher:homePP.fullName||'TBD',
        gameTime:g.gameDate, status:g.status.detailedState,
        awayRec:`${g.teams.away.leagueRecord?.wins||0}-${g.teams.away.leagueRecord?.losses||0}`,
        homeRec:`${g.teams.home.leagueRecord?.wins||0}-${g.teams.home.leagueRecord?.losses||0}`,
        moneyline, ou, allConditionIds:allCids, totalVol, vol24,
        delta:parseFloat(delta.toFixed(4)), isSharp, mispriced,
        trades:gameTrades, tradeCount:gameTrades.length
      };
    });

    const np={}; result.forEach(g=>{if(g.moneyline) np[`${g.away}@${g.home}`]=g.moneyline.prices[0];});
    cache.set('mlb-prev-odds',{data:np,ts:Date.now()});
    res.json(result);
  } catch(e) { res.status(502).json({error:e.message}); }
});

// ── WAR / GEOPOLITICAL INTEL ─────────────────────────────────────────────────
const WAR_TAGS=['iran','israel','middle-east','china','ukraine','russia','nuclear','geopolitics','taiwan','military'];
const WAR_KW=['iran','israel','war','military','nuclear','russia','ukraine','china','taiwan','invade','strike','bomb','missile','troops','ceasefire','regime'];

app.get('/api/war', async (req, res) => {
  const minTrade=parseFloat(req.query.min)||1;
  try {
    const allEvents = await cached('war-events', async () => {
      const results = await Promise.all(WAR_TAGS.map(async tag => {
        try { const r=await fetch(`https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=${tag}&limit=100`); return r.ok?r.json():[]; }
        catch{return[];}
      }));
      const seen=new Set(), merged=[];
      for (const b of results) for (const e of b) { if(!seen.has(e.id)){seen.add(e.id);merged.push(e);} }
      return merged.filter(e=>WAR_KW.some(kw=>(e.title||'').toLowerCase().includes(kw)));
    }, 120000);

    const markets=[];
    for (const evt of allEvents) for (const m of (evt.markets||[])) {
      const prices=parseJSON(m.outcomePrices).map(Number);
      if(!prices.length)continue;
      markets.push({ question:m.question||evt.title, conditionId:m.conditionId||'',
        yesPrice:prices[0]||0, noPrice:prices[1]||0,
        volume:parseFloat(m.volume||0), volume24hr:parseFloat(m.volume24hr||evt.volume24hr||0) });
    }
    markets.sort((a,b)=>b.volume-a.volume);

    await cached('fetch-merge', fetchAndMerge, 25000);
    const pool=allTrades(), cids=new Set(markets.map(m=>m.conditionId).filter(Boolean));
    const byMkt={};
    for (const t of pool) {
      if(!cids.has(t.conditionId))continue;
      const trade=fmtTrade(t);
      if(trade.usd<minTrade)continue;
      const c=t.conditionId;
      if(!byMkt[c])byMkt[c]=[];
      byMkt[c].push(trade);
      checkNotify(t);
    }
    for (const c of Object.keys(byMkt)) byMkt[c].sort((a,b)=>b.usd-a.usd);

    const allW=Object.values(byMkt).flat().sort((a,b)=>b.usd-a.usd);
    const topWhales=allW.filter(t=>t.usd>=Math.max(minTrade,1000)).slice(0,10);
    const result=markets.map(m=>({...m,trades:(byMkt[m.conditionId]||[]).slice(0,20)}));
    res.json({ markets:result, topWhales, totalFetched:pool.length, stored:tradeStore.size });
  } catch(e) { res.status(502).json({error:e.message}); }
});

// ── WALLET TRACKER ───────────────────────────────────────────────────────────
app.get('/api/wallets', async (req, res) => {
  try {
    await cached('fetch-merge', fetchAndMerge, 25000);
    const wallets=new Map();
    for (const t of allTrades()) {
      const addr=t.proxyWallet; if(!addr)continue;
      const usd=parseFloat(t.size||0)*parseFloat(t.price||0);
      const w=wallets.get(addr)||{address:addr,short:addr.slice(0,5)+'…'+addr.slice(-3),pseudonym:t.pseudonym||'',volume:0,trades:0,biggest:0,buys:0,sells:0,recentBets:[]};
      w.volume+=usd; w.trades++; w.biggest=Math.max(w.biggest,usd);
      if((t.side||'').toUpperCase()==='BUY')w.buys++;else w.sells++;
      if(w.recentBets.length<5)w.recentBets.push({title:(t.title||'').slice(0,40),usd,side:(t.side||'BUY').toUpperCase(),outcome:t.outcome||'?',odds:parseFloat(t.price||0)});
      wallets.set(addr,w);
    }
    res.json(Array.from(wallets.values()).sort((a,b)=>b.volume-a.volume).slice(0,10));
  } catch(e) { res.status(502).json({error:e.message}); }
});

// ── ALL WHALES ───────────────────────────────────────────────────────────────
app.get('/api/allwhales', async (req, res) => {
  const min=parseFloat(req.query.min)||1;
  try {
    await cached('fetch-merge', fetchAndMerge, 25000);
    const pool=allTrades();
    const result=pool.map(fmtTrade).filter(t=>t.usd>=min).sort((a,b)=>b.usd-a.usd).slice(0,100);
    for (const t of result) { if(t.usd>=50000) { const raw=pool.find(x=>x.proxyWallet===t.fullWallet&&parseInt(x.timestamp||0)===t.timestamp); if(raw)checkNotify(raw); } }
    res.json({ trades:result, totalFetched:pool.length, stored:tradeStore.size });
  } catch(e) { res.status(502).json({error:e.message}); }
});

app.listen(PORT, () => console.log('WhaleWatch running at http://localhost:'+PORT));
