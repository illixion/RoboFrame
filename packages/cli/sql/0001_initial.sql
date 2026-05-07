-- RoboFrame canonical posts schema, applied by `roboframe-cli bootstrap`.
-- imagemirror opens the resulting DB read-only, so this CLI is the sole writer.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
    _id INTEGER PRIMARY KEY,
    tags VARCHAR[] DEFAULT [],
    file_ext VARCHAR,
    score INTEGER DEFAULT 0,
    fav_count INTEGER DEFAULT 0,
    rating VARCHAR DEFAULT 's',
    image_width INTEGER,
    image_height INTEGER,
    ratio DOUBLE,
    duration DOUBLE DEFAULT 0,
    change_seq INTEGER DEFAULT 0,
    parent_id INTEGER
);

CREATE TABLE IF NOT EXISTS posts_paths (
    _id INTEGER,
    path VARCHAR
);

CREATE INDEX IF NOT EXISTS idx_posts_paths_id ON posts_paths (_id);
