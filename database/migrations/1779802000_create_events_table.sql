-- 1779802000_create_events_table
-- events: the append-only log from which the subjects and enames projections
-- are derived. Column semantics (sequence as log position, the request/outcome
-- split, the application-supplied created_at, the idempotency key) follow
-- ename-internals.md. Allowed kinds are enumerated in the CHECK; a new kind
-- is an ALTER on the constraint.

CREATE TABLE events (
  sequence        BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key UUID        NOT NULL UNIQUE,
  kind            TEXT        NOT NULL,
  request         JSONB       NOT NULL,
  outcome         JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,

  CONSTRAINT events_kind_allowed CHECK (kind IN ('subject.registered', 'subject.ename-added'))
);
