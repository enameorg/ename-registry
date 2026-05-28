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
--   - `idempotency_key` is the client-provided UUIDv7 used for idempotency.
--     UNIQUE ensures retries of the same operation produce the same event.
--     Scope is global in v1 (single operator); will become
--     (operator_id, idempotency_key) when operator identification is introduced.
--     Name aligned with the industry convention (Stripe, AWS, IETF draft
--     "Idempotency-Key HTTP Header Field"); distinct from the per-HTTP-request
--     `requestId` carried in logs and the `X-Request-Id` response header,
--     which is a separate observability concern.
--   - `kind` rather than `type` to avoid reserved-word collisions across SQL
--     dialects and target languages (notably Rust where `type` is a strict
--     keyword). Same convention as `subjects.kind`.
--   - `request` and `outcome` are two distinct JSONB columns, both shaped by
--     domain entities (subject, ename), not by the projection tables.
--       - `request` carries the input the actor submitted — the fields the
--         signer controls and can see at submission time (e.g. `subject.kind`,
--         `ename.namePart`, and for endpoints addressing an existing subject
--         the `subject.id` taken from the URL). This is the scope the future
--         layer-1 event signature will cover: a signer can only commit to
--         what they have under their eyes when they sign, not to identifiers
--         the server is about to allocate.
--       - `outcome` carries the server-allocated fields produced by the
--         operation (UUIDv7s, sequenced counters such as `ename.numberPart`).
--         These are covered separately by the layer-2 signed tree head, which
--         binds each event — including its outcome — to its position in the
--         log. The two layers are complementary, not redundant.
--     Both columns exclude `idempotency_key` (transport metadata, its own
--     column) and `created_at` (event-level metadata, its own column).
--   - `created_at` follows the same rule as on projection tables: supplied by
--     the application, not `DEFAULT now()`, so the projection remains
--     deterministically reconstructible by replay.
--   - Allowed kinds enumerated in the CHECK; new event kinds are added via
--     ALTER on the constraint.
--   - Kind naming convention: `<entity>.<verb_past_tense>`, dot-separated,
--     lowercase, snake_case inside each segment. Subject is the canonical
--     namespace for everything that happens to a registered identity
--     (registration, additional enames, future key rotations, recoveries,
--     revocations, deactivations). Past tense follows event-sourcing
--     practice: an event describes a fact that has happened.
--       - `subject.registered`: a new subject is registered together with
--         its first ename (atomically — a subject without an ename has no
--         meaning in the registry).
--       - `subject.ename_added`: an additional ename is added to a subject
--         already registered (e.g. name change).

CREATE TABLE events (
  sequence        BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key UUID        NOT NULL UNIQUE,
  kind            TEXT        NOT NULL,
  request         JSONB       NOT NULL,
  outcome         JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,

  CONSTRAINT events_kind_allowed CHECK (kind IN ('subject.registered', 'subject.ename_added'))
);
