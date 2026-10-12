-- Moderation for public profiles (issues #3 and #26).
-- suspended_at: set by a super admin. While non-NULL the account's public profile is hidden
--   everywhere (/u/:username and /api/profiles/:username answer 404, the sitemap skips it)
--   and the owner cannot turn profile_public back on. The owner can still sign in and use
--   their private library. NULL = not suspended.
-- suspended_by: users.id of the admin who suspended the account (kept on the row because
--   the auth_events log is pruned after 30 days).
-- auth_events.actor_user_id: the admin who performed a moderation action logged there.
-- Code checks for these columns via PRAGMA before using them, so a Worker deployed ahead
-- of this migration treats every account as not suspended and the suspend endpoint 503s.
ALTER TABLE users ADD COLUMN suspended_at DATETIME;
ALTER TABLE users ADD COLUMN suspended_by INTEGER;
ALTER TABLE auth_events ADD COLUMN actor_user_id INTEGER;
