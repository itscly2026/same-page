CREATE INDEX rate_limits_expiry_key_idx
  ON rate_limits(window_expires_at, key);
