import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const DATA_DIR = join(__dirname, 'data');
const TOKEN_FILE = join(DATA_DIR, 'tokens.json');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function getTokens() {
  try { return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')); }
  catch { return null; }
}

function saveTokens(tokens) {
  ensureDataDir();
  writeFileSync(TOKEN_FILE, JSON.stringify({ ...tokens, updated_at: Date.now() }));
}

async function refreshToken(tokens) {
  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error}`);
  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in * 1000),
  };
  saveTokens(newTokens);
  return newTokens;
}

async function mlFetch(path, options = {}) {
  let tokens = getTokens();
  if (!tokens) throw new Error('No tokens — visit /auth to configure');

  if (tokens.expires_at && Date.now() > tokens.expires_at - 300000) {
    tokens = await refreshToken(tokens);
  }

  const url = `https://api.mercadolibre.com${path}`;
  const headers = { 'Authorization': `Bearer ${tokens.access_token}`, ...options.headers };
  let res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    tokens = await refreshToken(tokens);
    headers['Authorization'] = `Bearer ${tokens.access_token}`;
    res = await fetch(url, { ...options, headers });
  }

  return res.json();
}

// Static
app.use(express.static(join(__dirname, 'public')));

// Auth redirect
app.get('/auth', (req, res) => {
  res.redirect(`https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=https://ml.letracaixadozero.com/callback`);
});

// OAuth callback
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: 'https://ml.letracaixadozero.com/callback',
      }),
    });
    const data = await tokenRes.json();
    if (data.error) return res.status(400).json(data);
    saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in * 1000),
    });
    res.redirect('/');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// API: Summary
app.get('/api/summary', async (req, res) => {
  try {
    const [seller, orders, items] = await Promise.all([
      mlFetch('/users/me'),
      mlFetch('/orders/search?seller=me&sort=date_desc&limit=50'),
      mlFetch('/users/me/items/search?limit=50'),
    ]);

    let listings = [];
    if (items.results?.length) {
      const ids = items.results.slice(0, 20).join(',');
      const details = await mlFetch(`/items?ids=${ids}`);
      listings = details.map(d => d.body).filter(Boolean);
    }

    res.json({
      seller: {
        id: seller.id,
        nickname: seller.nickname,
        reputation: seller.seller_reputation,
        permalink: seller.permalink,
      },
      orders: {
        total: orders.paging?.total || 0,
        recent: (orders.results || []).slice(0, 10).map(o => ({
          id: o.id,
          status: o.status,
          total: o.total_amount,
          currency: o.currency_id,
          date: o.date_created,
          items: o.order_items?.map(i => ({ title: i.item.title, quantity: i.quantity, price: i.unit_price })),
          buyer: o.buyer?.nickname,
        })),
      },
      listings: {
        total: items.paging?.total || 0,
        items: listings.map(l => ({
          id: l.id,
          title: l.title,
          price: l.price,
          currency: l.currency_id,
          status: l.status,
          available_quantity: l.available_quantity,
          sold_quantity: l.sold_quantity,
          permalink: l.permalink,
          thumbnail: l.thumbnail,
          condition: l.condition,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Orders
app.get('/api/orders', async (req, res) => {
  try {
    const { offset = 0, limit = 50, status } = req.query;
    let path = `/orders/search?seller=me&sort=date_desc&offset=${offset}&limit=${limit}`;
    if (status) path += `&order.status=${status}`;
    res.json(await mlFetch(path));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Items
app.get('/api/items', async (req, res) => {
  try {
    const { offset = 0, limit = 50 } = req.query;
    const search = await mlFetch(`/users/me/items/search?offset=${offset}&limit=${limit}`);
    if (search.results?.length) {
      const ids = search.results.join(',');
      const details = await mlFetch(`/items?ids=${ids}`);
      res.json({ paging: search.paging, items: details.map(d => d.body).filter(Boolean) });
    } else {
      res.json({ paging: search.paging, items: [] });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Questions
app.get('/api/questions', async (req, res) => {
  try {
    res.json(await mlFetch('/my/received_questions/search?sort_fields=date_created&sort_types=DESC&limit=20'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ML Dashboard running on port ${PORT}`);
  // Init tokens from env on first run
  if (!getTokens() && process.env.ML_ACCESS_TOKEN) {
    saveTokens({
      access_token: process.env.ML_ACCESS_TOKEN,
      refresh_token: process.env.ML_REFRESH_TOKEN,
      expires_at: Date.now() + 21600000,
    });
    console.log('Tokens initialized from env');
  }
});
