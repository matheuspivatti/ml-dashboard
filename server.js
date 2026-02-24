import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Banco SQLite - opcional (não funciona em Vercel serverless)
let db = null;
try {
  const dbModule = await import('./database.js');
  db = dbModule.default;
} catch (err) {
  console.warn('SQLite não disponível (ambiente serverless)');
}

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
  // Priorizar variáveis de ambiente (serverless)
  if (process.env.ML_ACCESS_TOKEN && process.env.ML_REFRESH_TOKEN) {
    return {
      access_token: process.env.ML_ACCESS_TOKEN,
      refresh_token: process.env.ML_REFRESH_TOKEN,
      expires_at: Date.now() + 21600000, // 6 horas
    };
  }
  // Fallback para arquivo local
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
      mlFetch('/orders/search?seller=2199171685&sort=date_desc&limit=50'),
      mlFetch('/users/2199171685/items/search?limit=50'),
    ]);

    let listings = [];
    if (items.results?.length) {
      // Buscar primeiros 20 itens em paralelo
      const itemPromises = items.results.slice(0, 20).map(id => 
        mlFetch(`/items/${id}`).catch(e => null)
      );
      const itemsData = await Promise.all(itemPromises);
      listings = itemsData.filter(item => item && !item.error);
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
    let path = `/orders/search?seller=2199171685&sort=date_desc&offset=${offset}&limit=${limit}`;
    if (status) path += `&order.status=${status}`;
    res.json(await mlFetch(path));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Items
app.get('/api/items', async (req, res) => {
  try {
    const { offset = 0, limit = 20 } = req.query; // Reduzido para 20 por performance
    const search = await mlFetch(`/users/2199171685/items/search?offset=${offset}&limit=${limit}`);
    if (search.results?.length) {
      // Buscar itens em paralelo (mais rápido)
      const itemPromises = search.results.slice(0, 20).map(id => 
        mlFetch(`/items/${id}`).catch(e => null)
      );
      const itemsData = await Promise.all(itemPromises);
      const items = itemsData.filter(item => item && !item.error);
      res.json({ paging: search.paging, items });
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

// API: History - Snapshots
app.get('/api/history/snapshots', (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available in serverless environment' });
  const snapshots = db.prepare('SELECT * FROM snapshots ORDER BY captured_at DESC LIMIT 30').all();
  res.json(snapshots);
});

// API: History - Changes
app.get('/api/history/changes', (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available in serverless environment' });
  const { days = 7 } = req.query;
  const changes = db.prepare(`
    SELECT a.*, s.captured_at as snapshot_date
    FROM alteracoes a
    LEFT JOIN anuncios an ON a.ml_item_id = an.ml_item_id
    LEFT JOIN snapshots s ON an.snapshot_id = s.id
    WHERE a.detectado_em >= datetime('now', '-${days} days')
    ORDER BY a.detectado_em DESC
    LIMIT 100
  `).all();
  res.json(changes);
});

// API: History - Capture snapshot
app.post('/api/history/capture', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database not available in serverless environment' });
  try {
    const items = await mlFetch('/users/2199171685/items/search?limit=50');
    let listings = [];
    if (items.results?.length) {
      const ids = items.results.join(',');
      const details = await mlFetch(`/items?ids=${ids}`);
      listings = details.map(d => d.body).filter(Boolean);
    }
    
    const totalVendas = listings.reduce((sum, i) => sum + (i.sold_quantity || 0), 0);
    const seller = await mlFetch('/users/me');
    
    const result = db.prepare(`
      INSERT INTO snapshots (seller_id, total_anuncios, total_vendas, data)
      VALUES (?, ?, ?, ?)
    `).run(seller.id, listings.length, totalVendas, JSON.stringify(listings));
    
    const snapshotId = result.lastInsertRowid;
    
    for (const item of listings) {
      db.prepare(`
        INSERT INTO anuncios (snapshot_id, ml_item_id, titulo, preco, estoque, vendidos, categoria, status, thumbnail_url, data_completa)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotId, item.id, item.title, item.price, item.available_quantity,
        item.sold_quantity, item.category_id, item.status, item.thumbnail, JSON.stringify(item)
      );
    }
    
    // Detect changes
    const prevSnapshot = db.prepare('SELECT id FROM snapshots WHERE id < ? ORDER BY id DESC LIMIT 1').get(snapshotId);
    if (prevSnapshot) {
      const currentItems = db.prepare('SELECT * FROM anuncios WHERE snapshot_id = ?').all(snapshotId);
      const prevItems = db.prepare('SELECT * FROM anuncios WHERE snapshot_id = ?').all(prevSnapshot.id);
      const prevMap = new Map(prevItems.map(i => [i.ml_item_id, i]));
      
      for (const current of currentItems) {
        const prev = prevMap.get(current.ml_item_id);
        if (!prev) {
          db.prepare('INSERT INTO alteracoes (ml_item_id, tipo, valor_novo) VALUES (?, ?, ?)').run(current.ml_item_id, 'novo', current.titulo);
        } else {
          if (Math.abs(current.preco - prev.preco) > 0.01) {
            const variacao = ((current.preco - prev.preco) / prev.preco * 100).toFixed(2);
            db.prepare('INSERT INTO alteracoes (ml_item_id, tipo, valor_anterior, valor_novo, variacao_pct, vendas_antes, vendas_depois) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
              current.ml_item_id, 'preco', prev.preco, current.preco, variacao, prev.vendidos, current.vendidos
            );
          }
          if (current.titulo !== prev.titulo) {
            db.prepare('INSERT INTO alteracoes (ml_item_id, tipo, valor_anterior, valor_novo) VALUES (?, ?, ?, ?)').run(current.ml_item_id, 'titulo', prev.titulo, current.titulo);
          }
        }
      }
    }
    
    res.json({ success: true, snapshotId, itemCount: listings.length });
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
