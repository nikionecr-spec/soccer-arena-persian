-- Soccer Arena Persian — PostgreSQL schema (idempotent, safe to re-run)
CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  username    VARCHAR(40) NOT NULL,
  pass_hash   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

CREATE TABLE IF NOT EXISTS profiles (
  user_id         BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name            VARCHAR(40) NOT NULL,
  rating          INT NOT NULL DEFAULT 1000,
  coins           INT NOT NULL DEFAULT 500,
  wins            INT NOT NULL DEFAULT 0,
  losses          INT NOT NULL DEFAULT 0,
  draws           INT NOT NULL DEFAULT 0,
  goals_for       INT NOT NULL DEFAULT 0,
  goals_against   INT NOT NULL DEFAULT 0,
  selected_piece  VARCHAR(40) NOT NULL DEFAULT 'piece_classic',
  selected_field  VARCHAR(40) NOT NULL DEFAULT 'field_classic',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS profiles_rating_idx ON profiles (rating DESC);

CREATE TABLE IF NOT EXISTS matches (
  id              TEXT PRIMARY KEY,           -- 'm_xxxxxx'
  mode            VARCHAR(16) NOT NULL,       -- ranked | friendly
  target_goals    INT NOT NULL,
  turn_seconds    INT NOT NULL,
  status          VARCHAR(16) NOT NULL,       -- finished
  score_a         INT NOT NULL DEFAULT 0,
  score_b         INT NOT NULL DEFAULT 0,
  winner_user_id  BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_finished_idx ON matches (finished_at DESC);

CREATE TABLE IF NOT EXISTS match_players (
  match_id       TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team           INT NOT NULL,                -- 0 | 1
  rating_before  INT NOT NULL,
  rating_after   INT NOT NULL,
  elo_delta      INT NOT NULL,
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS match_players_user_idx ON match_players (user_id);

CREATE TABLE IF NOT EXISTS friendships (
  user_id_a BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id_b BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status    VARCHAR(12) NOT NULL,              -- pending | accepted | none
  req_by    BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id_a, user_id_b)
);

CREATE TABLE IF NOT EXISTS inventory (
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id  VARCHAR(40) NOT NULL,
  bought_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      BIGSERIAL PRIMARY KEY,
  event   VARCHAR(40) NOT NULL,
  data    JSONB,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_event_idx ON audit_log (event, at DESC);
