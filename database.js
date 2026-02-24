import Database from 'better-sqlite3';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const DB_FILE = join(DATA_DIR, 'ml-history.db');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

// Criar tabelas
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id TEXT NOT NULL,
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_anuncios INTEGER,
    total_vendas INTEGER,
    ticket_medio REAL,
    data JSON
  );

  CREATE TABLE IF NOT EXISTS anuncios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER,
    ml_item_id TEXT NOT NULL,
    titulo TEXT,
    preco REAL,
    estoque INTEGER,
    vendidos INTEGER,
    categoria TEXT,
    status TEXT,
    thumbnail_url TEXT,
    data_completa JSON,
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
  );

  CREATE INDEX IF NOT EXISTS idx_item ON anuncios(ml_item_id);
  CREATE INDEX IF NOT EXISTS idx_snapshot ON anuncios(snapshot_id);

  CREATE TABLE IF NOT EXISTS alteracoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ml_item_id TEXT NOT NULL,
    tipo TEXT NOT NULL, -- 'preco', 'titulo', 'categoria', 'novo', 'pausado'
    valor_anterior TEXT,
    valor_novo TEXT,
    variacao_pct REAL,
    detectado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    vendas_antes INTEGER,
    vendas_depois INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_alteracoes_item ON alteracoes(ml_item_id);
  CREATE INDEX IF NOT EXISTS idx_alteracoes_data ON alteracoes(detectado_em);
`);

export default db;
