-- RAKUDA CostCut LP - D1 Schema

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  company TEXT,
  name TEXT,
  phone TEXT,
  size TEXT,
  message TEXT,
  source_page TEXT,
  type TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  name TEXT,
  email TEXT,
  company TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ab_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT NOT NULL,
  page TEXT NOT NULL,
  event TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source_page);
CREATE INDEX IF NOT EXISTS idx_ab_events_page ON ab_events(page);
CREATE INDEX IF NOT EXISTS idx_ab_events_visitor ON ab_events(visitor_id);
