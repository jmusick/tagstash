-- Private notes on bookmarks (issue #60). A Markdown note only the owner sees: it is never part of
-- the public profile API, the /u/:username snapshot or the sitemap (those select named columns).
-- NULL = no note. At most INPUT_LIMITS.note characters (functions/api/[[path]].js).
-- Code deployed ahead of this migration fails safe: without the column a write carrying a note
-- answers 503 and everything else behaves as before (bookmarksHaveNotes).
ALTER TABLE bookmarks ADD COLUMN note TEXT;
