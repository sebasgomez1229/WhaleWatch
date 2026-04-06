const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const seen = new Set();

async function getWhales() {
  const r = await fetch('https://data-api.polymarket.com/trades?limit=500', {headers:{'Accept':'application/json'}});
  if (!r.ok) throw new Error('API ' + r.status);
  const trades = await r.json();
  return trades.map(t => ({...t, usd: parseFloat(t.size||0) * parseFloat(t.price||0)}))
    .filter(t => t.usd >= 5000).sort((a,b) => b.usd - a.usd);
}

app.use(express.static(path.join(__dirname)));
app.get('/api/trades', async (req, res) => {
  try { res.json({ data: await getWhales() }); }
  catch(err) { res.status(502).json({error: err.message}); }
});
app.listen(PORT, () => console.log('Whale Watch running at http://localhost:' + PORT));
