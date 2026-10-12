-- Per-account budgets for expensive bookmark endpoints (metadata fetches, imports) are counted
-- from auth_events by user_id (USER_RATE_LIMITS in functions/api/[[path]].js). This index
-- keeps those counts to one user's recent rows. Optional for correctness: before it exists
-- the counts still work, only slower, and before 0012 the budgets fail open.
CREATE INDEX IF NOT EXISTS idx_auth_events_type_user ON auth_events(event_type, user_id, created_at);
