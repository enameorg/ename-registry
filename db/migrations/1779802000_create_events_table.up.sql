-- 1779802000_create_events_table (up)
-- events: append-only log of registry mutations, source of truth for the
-- subjects and enames projections (and future projections).
--
-- Conventions:
--   - Exception to the "UUIDv7 PK on every entity table" doctrine: the PK is
--     `sequence`, a BIGINT IDENTITY assigned by PostgreSQL. Events are positions
--     in a log, not entities with surrogate identity. UUIDv7 millisecond
--     precision is insufficient for ordering across concurrent backends;
--     IDENTITY guarantees a strictly increasing order at the database level.
--     This `sequence` is the precursor of the future transparency-log leaf
--     index — same column, same semantics, additional cryptographic structure
--     added later.
--   - `request_id` is the client-provided UUIDv7 used for idempotency. UNIQUE
--     ensures retries of the same operation produce the same event. Scope is
--     global in v1 (single operator); will become (operator_id, request_id)
--     when operator identification is introduced.
--   - `kind` rather than `type` to avoid reserved-word collisions across SQL
--     dialects and target languages (notably Rust where `type` is a strict
--     keyword). Same convention as `subjects.kind`.
--   - `payload` is JSONB shaped by domain entities (subject, ename), not by
--     the projection tables. Excludes `request_id` (transport metadata, lives
--     in its own column) and `created_at` (event-level metadata, lives in its
--     own column).
--   - `created_at` follows the same rule as on projection tables: supplied by
--     the application, not `DEFAULT now()`, so the projection remains
--     deterministically reconstructible by replay.
--   - Allowed kinds enumerated in the CHECK; new event kinds are added via
--     ALTER on the constraint.

CREATE TABLE events (
  sequence    BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id  UUID        NOT NULL UNIQUE,
  kind        TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,

  CONSTRAINT events_kind_allowed CHECK (kind IN ('subject.register', 'ename.create'))
);
