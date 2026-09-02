CREATE TABLE IF NOT EXISTS dashboard_users (
  id TEXT PRIMARY KEY,
  access_subject TEXT NOT NULL UNIQUE,
  email TEXT,
  role TEXT NOT NULL CHECK(role IN ('super_admin', 'admin', 'viewer')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dashboard_installation (
  id TEXT PRIMARY KEY CHECK(id = 'default'),
  owner_access_subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id TEXT PRIMARY KEY,
  waba_id TEXT NOT NULL,
  phone_number_id TEXT NOT NULL UNIQUE,
  display_phone_number TEXT,
  credentials_ciphertext TEXT NOT NULL,
  credentials_nonce TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'validated', 'connected', 'error')) DEFAULT 'draft',
  last_validated_at TEXT,
  webhook_verified_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS whatsapp_connections_status_idx ON whatsapp_connections(status, updated_at DESC);
