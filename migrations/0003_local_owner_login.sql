CREATE TABLE IF NOT EXISTS local_owner (
  id TEXT PRIMARY KEY CHECK(id = 'default'),
  user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_digest TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS dashboard_sessions_user_expiry_idx ON dashboard_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS dashboard_login_attempts (
  key_digest TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_started_at TEXT NOT NULL,
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS dashboard_login_attempts_updated_idx ON dashboard_login_attempts(updated_at);

CREATE TABLE IF NOT EXISTS webhook_endpoint_verification (
  id TEXT PRIMARY KEY CHECK(id = 'default'),
  verified_at TEXT NOT NULL
);
