-- Trash with restore (issue #61). Deleting a bookmark stamps deleted_at (UTC, same format as
-- created_at) instead of removing the row. NULL = a live bookmark. A trashed bookmark keeps its
-- bookmark_tags rows so a restore brings its tags back, and is purged for good once it has been
-- in the trash for TRASH_RETENTION_DAYS (src/utils/trash.js), by an opportunistic purge in the
-- bookmark routes (there is no cron).
-- Code deployed ahead of this migration fails safe: without the column, deletes stay permanent
-- and no query references it (functions/api/[[path]].js: bookmarksHaveTrash).
ALTER TABLE bookmarks ADD COLUMN deleted_at TEXT;

-- Live-bookmark counts and listings per user (user_id = ? AND deleted_at IS NULL), and the
-- owner's trash list.
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_deleted ON bookmarks(user_id, deleted_at);

-- The global expired-trash sweep only ever looks at trashed rows.
CREATE INDEX IF NOT EXISTS idx_bookmarks_trashed ON bookmarks(deleted_at) WHERE deleted_at IS NOT NULL;
