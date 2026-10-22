CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  redirect_uri TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  credential TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  credential TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires INTEGER NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  refresh_expires INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  code_hash TEXT,
  prev_refresh_hash TEXT
);
CREATE TABLE IF NOT EXISTS oauth_rate_limits (
  rate_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_form_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_codes_expiry ON oauth_codes(expires_at);
CREATE INDEX IF NOT EXISTS oauth_rate_expiry ON oauth_rate_limits(expires_at);
CREATE INDEX IF NOT EXISTS oauth_form_expiry ON oauth_form_nonces(expires_at);
CREATE INDEX IF NOT EXISTS oauth_grants_expiry ON oauth_grants(refresh_expires);
CREATE INDEX IF NOT EXISTS oauth_grants_revoked ON oauth_grants(revoked);
CREATE INDEX IF NOT EXISTS oauth_grants_client ON oauth_grants(client_id);
CREATE INDEX IF NOT EXISTS oauth_clients_created ON oauth_clients(created_at);
CREATE INDEX IF NOT EXISTS oauth_grants_code ON oauth_grants(code_hash);
CREATE INDEX IF NOT EXISTS oauth_grants_prev_refresh ON oauth_grants(prev_refresh_hash);
