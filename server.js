const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { execSync } = require('child_process');
const path = require('path');
const app = express();
const PORT = 3000;
const WHALE_MIN = 50000;
const seen = new Set();
let lastWhales = [];

async function fetchAndAlert() {
  try {
    const r = await fetch('https://data-api.polymarket.com/trades?limit=500', {
      headers: { 'Accept': 'application/json' }
    });
    if (!r.ok) return;
    const trades = await r.json();
    const whales = trades
      .map(t => ({ ...t, usd: parseFloat(t.size||0) * parseFloat(t.price||0) }))
      .filter(t => t.usd >= WHALE_MIN)
      .sort((a, b) => b.usd - a.usd);

    // Desktop alert for new whales
    whales.forEach(t => {
      const id = t.transactionHash || t.id || (t.usd + t.timestamp);
      if (!seen.has(id)) {
        seen.add(id);
        const usd = t.usd >= 1000000 ? '$' + (t.usd/1000000).toFixed(2) + 'M' : '$' + (t.usd/1000).toFixed(0) + 'K';
        const title = (t.title || 'Unknown Market').slice(0, 40);
        const side = (t.side || 'BUY').toUpperCase();
        const msg = `${usd} ${side} — ${title}`;
        try {
          execSync(`osascript -e 'display notification "${msg}" with title "🐳 WHALE ALERT" sound name "Submarine"'`);
        } catch(e) {}
        console.log('WHALE:', msg);
      }
    });
    lastWhales = whales;
  } catch(e) { console.error(e.message); }
}

// Poll every 30 seconds
fetchAndAlert();
setInterval(fetchAndAlert, 30000);

app.use(express.static(path.join(__dirname)));
app.get('/api/trades', async (req, res) => {
  try {
    const r = await fetch('https://data-api.polymarket.com/trades?limit=500', {
      headers: { 'Accept': 'application/json' }
    });
    const data = await r.json();
    res.json({ data });
  } catch(err) { res.status(502).json({ error: err.message }); }
});
app.get('/api/whales', (req, res) => res.json(lastWhales));
app.listen(PORT, () => console.log('🐳 Whale Watch running at http://localhost:' + PORT));
