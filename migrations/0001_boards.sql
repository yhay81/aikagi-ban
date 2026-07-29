PRAGMA foreign_keys = ON;

CREATE TABLE boards (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 64),
  description TEXT NOT NULL CHECK(length(description) <= 240),
  access_token_hash TEXT NOT NULL CHECK(length(access_token_hash) = 64),
  organizer_token_hash TEXT NOT NULL CHECK(length(organizer_token_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  post_count INTEGER NOT NULL DEFAULT 0 CHECK(post_count BETWEEN 0 AND 200),
  comment_count INTEGER NOT NULL DEFAULT 0 CHECK(comment_count BETWEEN 0 AND 500)
);

CREATE INDEX boards_expiry_idx ON boards(expires_at);

CREATE TABLE posts (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 24),
  kind TEXT NOT NULL CHECK(kind IN ('notice', 'question', 'note')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 1000),
  photo_key TEXT UNIQUE,
  is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX posts_board_idx ON posts(board_id, is_pinned DESC, created_at DESC);

CREATE TABLE comments (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 24),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 300),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX comments_post_idx ON comments(post_id, created_at);

CREATE TABLE acknowledgements (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 24),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(post_id, session_id)
);

CREATE INDEX acknowledgements_board_idx ON acknowledgements(board_id, post_id);

CREATE TABLE creation_limits (
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  day TEXT NOT NULL CHECK(length(day) = 10),
  count INTEGER NOT NULL DEFAULT 0 CHECK(count BETWEEN 0 AND 3),
  PRIMARY KEY(session_id, day)
);

CREATE TABLE write_limits (
  board_id TEXT NOT NULL,
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  day TEXT NOT NULL CHECK(length(day) = 10),
  kind TEXT NOT NULL CHECK(kind IN ('post', 'comment')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(board_id, session_id, day, kind)
);

CREATE TABLE product_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
    CHECK(name IN (
      'visited',
      'board_created',
      'board_opened',
      'post_created',
      'comment_created',
      'acknowledged',
      'photo_added',
      'board_exported',
      'returned'
    )),
  session_id TEXT NOT NULL CHECK(length(session_id) = 36),
  board_id TEXT CHECK(board_id IS NULL OR length(board_id) = 32),
  day TEXT NOT NULL CHECK(length(day) = 10),
  created_at INTEGER NOT NULL,
  is_qa INTEGER NOT NULL DEFAULT 0 CHECK(is_qa IN (0, 1))
);

CREATE INDEX product_events_day_idx ON product_events(day, name, is_qa);
