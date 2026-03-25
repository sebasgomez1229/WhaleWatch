const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const cache = new Map();
const CACHE_TTL = 30000;

const WHALE_MIN = 5000;
const ALERT_MIN = 10000;

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) {
    return Promise.resolve(hit.data);
  }
  return fn().then((data) => {
    cache.set(key, { data, ts: Date.now() });
    return data;
  });
}

function getTradeSize(trade) {
  return Number(trade.size || trade.amount || trade.usdcSize || 0);
}

app.use(express.static(path.join(__dirname)));

app.get('/api/trades', async (req, res) => {
  try {
    const data = await cached('trades', async () => {
      const r = await fetch('https://data-api.polymarket.com/trades?limit=500', {
        headers: { Accept: 'application/json' }
      });
      if (!r.ok) throw new Error('API ' + r.status);
      return r.json();
    });

    const whaleTrades = data
      .filter((trade) => getTradeSize(trade) >= WHALE_MIN)
      .sort((a, b) => getTradeSize(b) - getTradeSize(a));

    res.json(whaleTrades);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const data = await cached('trades', async () => {
      const r = await fetch('https://data-api.polymarket.com/trades?limit=500', {
        headers: { Accept: 'application/json' }
      });
      if (!r.ok) throw new Error('API ' + r.status);
      return r.json();
    });

    const alerts = data
      .filter((trade) => getTradeSize(trade) >= ALERT_MIN)
      .sort((a, b) => getTradeSize(b) - getTradeSize(a));

    res.json(alerts);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/markets/bulk', async (req, res) => {
  const ids = (req.query.ids || '').split(',').filter(Boolean).slice(0, 30);

  if (!ids.length) return res.json([]);

  try {
    const results = await Promise.allSettled(
      ids.map((id) =>
        cached('market:' + id, async () => {
          const r = await fetch(
            'https://gamma-api.polymarket.com/markets?clob_token_ids=' + id + '&limit=1',
            { headers: { Accept: 'application/json' } }
          );
          if (!r.ok) return [];
          return r.json();
        })
      )
    );

    res.json(
      results
        .filter((r) => r.status === 'fulfilled')
        .flatMap((r) => r.value || [])
    );
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('Whale Watch running at http://localhost:' + PORT);
});
