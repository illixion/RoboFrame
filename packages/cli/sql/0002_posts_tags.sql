-- Inverted tag index: one row per (tag, post). imagemirror routes tag
-- queries through it (id-list probes) instead of scanning the posts.tags
-- arrays, and treats its presence as the marker that query-time
-- alias/implication expansion applies. The table is rebuilt from posts
-- after every ingest (see refreshPostsTags in src/db.mjs) — clustered by
-- tag so DuckDB's zone maps prune per-tag probes.

CREATE TABLE IF NOT EXISTS posts_tags (
    tag VARCHAR,
    _id INTEGER
);
