# Ename — Registry Internals

## Preamble

This document is the source of truth for the **internal architecture, conventions and code guidelines** of the Ename registry. It sits one level above the code: the code is the spec and its implementation; this document captures what the code cannot state about itself — cross-cutting invariants, conventions that constrain future code, committed-but-unbuilt design, and the rare rationale that prevents a plausible regression. It does not repeat what a reader can infer from the code, and it carries no setup or command reference (those live in each package's `README.md`).

Primary reader: the AI assistant that maintains the codebase. Secondary: the human team. Updates are delegated to the AI and land in the same change as the code decision they record (cf. `AGENTS.md`).

Scope: internal implementation decisions, **unilaterally revisable** by the registry's technical team. Out of scope: the public technical standards the registry publishes (ename format, signature algorithms, inter-operator transfers — see `ename-format-*`, modifiable only through public consultation per `ename-synthesis.md`), and the mission, governance and institutional model (`ename-synthesis.md`).

Status markers: unmarked text is **implemented and current**; `(working hypothesis)` is current and relied on by the code but may be revised; `(target)` is decided and shapes current code but is not yet built. Unresolved questions live in § Open questions under stable `[Q-XXX]` ids shared across the corpus.

## Architecture overview

The registry is an **append-only event log**, the single source of truth for every registry mutation. The SQL database is a reconstructible projection of the log, serving fast reads. The log is public and auditable: this is what lets a commons survive centuries without resting on institutional trust alone.

The backend has two implementation phases: **Node.js + TypeScript** now, **Rust + axum + sqlx** later, ported by a dedicated team rather than migrated gradually. The versioned OpenAPI contract is the language-independent pivot the two phases share. Node code is shaped to map cleanly onto the Rust target; concretely this fixes a few choices repo-wide: raw parameterized SQL (no ORM), pure `function`s and module singletons (no DI framework, no classes with hidden state), snake_case in SQL, and the two-layer split below.

Code organization favors **global symmetry across the codebase** over per-module optimization. No size threshold triggers an isolated restructuring; a structural change lands everywhere at once. Current layout: one folder per concept within each layer.

## Event log and data model

**Event sourcing.** Every mutation (today: subject registration; later: key rotation, revocation, recovery, deactivation) is recorded as an immutable event. No retroactive modification or deletion. The SQL database is fully reconstructible by replaying the log.

**Registry scope** `(working hypothesis)`. The registry stores only what binding and verification require — the ename and its subject today; the subject's public key, key-transition history, home operator and lifecycle status are `(target)`. Profile data (display name, contacts, anything richer) is the operators' responsibility, never the registry's. This keeps the auditable surface minimal and erasure structurally bounded.

**The `events` table.** The v1 embodiment of the log — an append-only journal from which the `subjects` and `enames` projections are derived. Column types and the per-kind JSON shapes live in the migration and the service code; the invariants are:

- `sequence` (PK, `BIGINT` IDENTITY) — position in the log. Strictly monotonic but not gap-free (an aborted transaction burns a value, e.g. the idempotency race path). It guarantees only a total order over committed events, so it is *not* a Merkle leaf index: the contiguous leaf index is assigned at tree-construction time `(target)`.
- `idempotency_key` (UUIDv7, UNIQUE) — client-provided, transport metadata. Distinct from the server-generated `requestId` (observability, never persisted).
- `kind` (CHECK-enumerated) — convention `<entity>.<verb_past_tense>`. `subject.registered` and `subject.ename_added` are emitted today.
- `request` / `outcome` (two JSONB columns) — `request` is what the actor submitted, nested by entity block; `outcome` is what the server allocated (UUIDv7s, sequenced counters). The split keeps two cryptographic scopes apart: `request` is the scope the future layer-1 signature will cover `(target)`, `outcome` is covered by the layer-2 signed tree head `(target)`. Both exclude `idempotency_key` and `created_at`, which have their own columns.
- `created_at` (TIMESTAMPTZ) — the single timestamp of the event; projection rows inherit it at replay.

**Schema discipline (projections).** Consequences of "the log is the source of truth":

- `created_at` is supplied by the application, never `DEFAULT now()` — a default would make replay non-deterministic. A use case that writes several rows for one event captures `createdAt` once and propagates the same value to every INSERT, so all rows of an event share a byte-identical timestamp.
- No `DEFAULT` on `id` — UUIDv7 is application-generated; a missing id must fail loudly.
- No `updated_at` — the model is append-only; change is a new row in a history table, never an UPDATE.
- Validation boundary: invariants that may evolve with the public format live in Zod; PostgreSQL `CHECK` encodes only invariants that survive every anticipable format change (length, absolute bounds, the broadest character class). This keeps a minor format change from forcing a DDL migration.
- Ensure every foreign-key column is indexed by effective coverage, not mechanically. A composite PRIMARY KEY, UNIQUE constraint or index whose leftmost column is the foreign key satisfies this; do not keep a narrower duplicate index unless a measured query plan needs it.
- `CHECK` constraints are named explicitly (auto-names are illegible in logs); PK/FK/UNIQUE keep PostgreSQL's predictable auto-names.

**Primary keys.** UUIDv7 (RFC 9562), application-generated, stored in the native 16-byte `uuid` type, for every entity table — time-prefixed for B-tree locality and aligned with the ratified standard. Exception: log tables use `BIGINT` IDENTITY (a log entry is a position, not an entity). `subject_id` is exposed publicly as a stable cross-operator reference that survives renames, and is validated by a strict lowercase pattern at every boundary (defined in `src/uuid.ts`).

**SQL naming.** snake_case for every identifier (tables, columns, indexes, constraints). Table names are plural, column names singular; a foreign key is `<singular_table>_id` referencing `<plural_table>.id` (e.g. `subject_id` → `subjects.id`). Avoid SQL reserved words even where PostgreSQL accepts them (`account` not `user`, `kind` not `type`).

**Idempotency.** Every write endpoint takes a mandatory `idempotencyKey` (UUIDv7) in the body — not a header, so the future event signature can cover it alongside `request` `(target)`. The server runs the same algorithm for every write use case: a preliminary lookup outside the transaction; the entity INSERTs; a final `INSERT events` whose UNIQUE violation signals a concurrent winner to reconcile against; reconciliation by structural deep-equality between the submitted operation request and the stored `request`. A replay returns the prior result; the same key with a different body or path returns 409. If a projection UNIQUE conflict can happen before the event insert, the use case checks for an idempotency winner before surfacing the conflict. Uniqueness is global in v1 and becomes `(operator_id, idempotency_key)` `(target)` — needed for security isolation between operators, not only collision avoidance.

**Group-scoped counters.** A counter unique within a group (today `enames.number_part` per `name_part`) is allocated inside the INSERT via `COALESCE(MAX(...), 0) + 1`, guarded by a `UNIQUE (group, counter)` and retried under a SAVEPOINT on collision. The retry budget bounds the concurrent burst a single group can absorb; exhaustion raises a retryable `ContentionError` (→ 503), never an opaque 500. The escalation lever for a hot group is a dedicated counter table `(target)`; advisory locks are unavailable (see Serverless SQL constraints).

**Subject-scoped name uniqueness.** A subject can hold several enames, but only one per `name_part`. The database enforces this with `UNIQUE (subject_id, name_part)`. The public `number_part` remains allocated globally per `name_part`, so the same `name_part` can belong to different subjects as different full enames.

**Cryptographic model** `(target)`. The cryptographic layer is not built yet; it shapes the current schema (the `request`/`outcome` split, the in-body idempotency key), and the commitments it will publish bind the registry long-term — so the scheme must be conservative, portable and crypto-agile (cf. `[Q-LOG-STRUCT]`, `[Q-CRYPTO-AGILITY]`, and `[Q-CRYPTO-IMPL]` in `ename-synthesis.md`).

- *Verifiability.* Events are chained in a Merkle structure; the registry periodically publishes signed tree heads so any third party can verify that an event is in the log and that history has not been rewritten. The whole log is public and downloadable.
- *Signature taxonomy.* Any event that transfers or modifies **control** of an ename is cryptographically chained to the previous user key, or explicitly labeled a recovery; everything else is log mechanics signed by the operator alone.

  | Event | Signed by |
  |---|---|
  | Initial registration | Operator alone (no prior user key; mis-registration stays detectable by the user) |
  | Key rotation, user-declared revocation, deactivation | Current user key |
  | Key recovery | Operator alone, explicitly labeled and publicly visible |
  | Log mechanics (operator key rotation, checkpoints) | Operator alone |

- *Recovery.* A key transition not chained to a valid user key is encoded as a labeled, publicly visible recovery event. How the user proved their recovery right is operator-side and external to the registry (`[Q-KEYREC]` in `ename-synthesis.md`). The registry refuses the pure-lockout model (lost key = lost ename), which is untenable at the scale of a universal human identity.
- *Initial registration.* The operator submits the user's public key with no proof-of-possession required by the registry; a mis-registered key is a visible attack (the user cannot sign under their ename), not a silent one. Proof-of-possession may be added later.
- *Transition monitoring.* A home operator must watch the log for the enames it serves and alert users on any unsolicited transition; without it the chaining protects only retroactively (cf. `[Q-ACCRED-CRITERES]` in `ename-synthesis.md`).

## Application architecture

**Two layers, no Repository.** The **API layer** (`src/api/`) is the HTTP surface — routing, input/output validation, serialization, status codes — and holds no business logic. The **Service layer** (`src/services/`) holds all business logic and accesses the database directly. Low-level DB plumbing (the pool, the query and transaction helpers) lives in `src/database/` and is consumed only by the Service layer. The Service layer holds three kinds of function, kept distinct: **data-access primitives** (single-table reads and writes in raw parameterized SQL, mapped through Zod), **pure business-rule functions** (testable without a database), and **use cases** (orchestration across primitives — transactions, idempotency).

**Data-access primitives and information hiding.** Each concept's primitives are the sole holder of its schema knowledge — table and column names, SQL text, constraint names, expected PostgreSQL error codes — and they translate expected DB errors into domain errors, so nothing above them branches on a SQLSTATE or a constraint name. This is *information hiding*, not an abstraction layer: no indirection, no substitutability, the SQL owned and visible, merely confined. Three concerns, three homes: schema → primitives; transactions → use cases; generic pg mechanics → `src/database/`. A use case does not pre-check an invariant already enforced by the database when the write primitive can translate the expected constraint violation into a domain error. For write paths, prefer the write plus constraint translation over read-before-write; a pre-check is justified only when it enforces a rule the database cannot express, avoids expensive work before a known failure, or improves semantics without replacing the database constraint.

**Concept folders and naming.** Each layer holds one folder per concept, exposing its public surface through an `index.ts` barrel — the encapsulation boundary. Intra-folder code imports files directly; other folders import through the barrel. Within a Service concept, the concept-named file (`subject.ts`) carries the domain type/schema, the primitives, and its pure rules; each use case is its own operation-named file (`register-subject.ts`). API endpoints are one file per route, registered in `api/index.ts`. Grouping mirrors across layers — the API by URL root, the Service by aggregate: a nested write such as `POST /subjects/:id/enames` becomes an API file under `subject/` and a use case under `subject/`. Concept folders are singular at every layer (`subject`, `ename`), so a concept carries one name across the whole codebase — chosen for cross-layer symmetry over echoing the plural REST URLs and SQL tables (the route path stays explicit in each `createRoute`).

**Per-layer visibility.** A resource appears only at the layer that consumes it: the pool, the SQL helpers and transactions stay in the Service layer; the API layer's `ApiContext` (Hono's request context) carries only what it needs at request time.

**Dependency propagation.**

- Stateless functions: direct import, `(input) → output`.
- Process-lifetime resources (config, root logger, pool): module singletons, frozen after init, imported by their consumers; the pool lives in a Service-layer module and is invisible to the API layer.
- Request-scoped values (requestId, child logger): carried on the API layer's `ApiContext` via `context.var.*`, populated by middleware.

A request-scoped value the Service layer needs is read from the `ApiContext` by the handler and passed as an explicit argument (`ServiceContext`); the Service layer never touches the `ApiContext`. A `PoolClient` opened for a transaction flows the same way — an explicit argument between service functions, never up to the `ApiContext`.

**Domain errors and HTTP mapping.** The Service layer throws semantic errors (`DomainError` and its subclasses `ValidationError`, `NotFoundError`, `ConflictError`, `IdempotencyConflictError`, `ContentionError`) and knows nothing about HTTP. The single mapping lives in the API's `onError`: `ValidationError` → 422, `NotFoundError` → 404, `ConflictError` and `IdempotencyConflictError` → 409, `ContentionError` → 503 + `Retry-After`, a framework-raised Hono `HTTPException` (today only a malformed JSON body, which the json validator reports as 400) → its carried status, anything else → 500. Error messages are written for the client (generic, no internal vocabulary); the specifics go to the logs, correlatable by `requestId`. A shared lower-level function emits operation-neutral client messages: if the same primitive serves registration, ename addition, imports or future tools, its errors name the shared operation (`ename creation`, `request`) rather than one caller (`registration`, `body`).

**Transactions.** Multi-table transactions are managed explicitly by the use case that needs them (via the `withTransaction` helper); no transparent transactional middleware.

**Concurrency.** Concurrent writes are made safe by UNIQUE constraints plus bounded optimistic retry — the idempotency key and the group-scoped counter both race, hit the constraint, then reconcile or retry. The registry relies on neither SERIALIZABLE isolation nor advisory locks; a new concurrent-write path follows the same constraint-plus-retry shape.

**Error cleanup.** A cleanup action in a `catch` — `ROLLBACK`, `ROLLBACK TO SAVEPOINT`, a release — must never mask the original error: wrap it so the original propagates, and log the cleanup failure separately. Applies to all current and future manual-transaction or SAVEPOINT code.

**Assembly vs runtime.** The module that assembles the app (`src/index.ts`) has no side effects and is importable by tests that drive it via `app.fetch(request)` without opening a port. The module that runs it (`src/server.ts`) adds the listener, signal handling and graceful shutdown.

## API and HTTP contract

**OpenAPI 3.1, code-first.** Two representations from the same generator call: the canonical versioned file `backend/openapi.json` (committed, the audit trail, consumed off-runtime by SDK generators and CI) and the runtime spec at `/api/v{N}/openapi.json` (generated per request, always in sync with the running code). A CI `oasdiff` check will fail the build on any drift between the two `(target)`.

**Versioning.** Each major version is a sub-app mounted under its prefix (`/api/v1`); routes are defined without the prefix (applied at mount). v1 and v2 cohabit as two mounts.

**Endpoints.** Registration is `POST /api/v1/subjects` — it creates a subject and its first ename atomically and emits one `subject.registered` event (a subject without an ename has no meaning). Adding an ename to an existing subject is `POST /api/v1/subjects/:id/enames`, emitting `subject.ename_added`. Two single-purpose endpoints rather than one polymorphic body; request and response are nested by entity block (`subject`, `ename`), mirroring the event `request`/`outcome` shape — one mental model from wire body to log entry. (The live endpoint list is in `backend/README.md`.)

**Problem Details (RFC 9457).** Every 4xx and 5xx response is `application/problem+json` with `{ type, title, status, detail, requestId, errors? }`. `type` is `about:blank` until error-type URIs are published at `https://ename.ngo/errors/<slug>` `(target)`. `requestId` is the server-generated UUIDv7 also returned in the `X-Request-Id` header; `errors` is the field-level array for validation failures. Text casing follows the field's grammatical role: `title` is a short capitalized label with no terminal period (`Bad request`); `detail` is a complete sentence, capitalized and period-terminated (`The request body is not valid JSON.`); each `errors[].message` is a field-attached fragment, lowercase and unpunctuated. Client-facing strings carry no framework-internal vocabulary — a framework message (e.g. Hono's malformed-JSON text) is replaced by our own before it reaches the client. A route's OpenAPI response `description` stays generic and stable per status code (`Request body failed validation`, not an enumeration of every cause); the cause specific to one occurrence lives in the response body (`detail`, and `type` once error-type URIs exist), not in the static contract text. This keeps the description from needing an edit each time a new cause maps to an existing status.

**Serialization.** camelCase JSON keys. A `BIGINT` field whose value is unbounded over the multi-century horizon (log positions, leaf indexes) is serialized as a `string` to preserve precision beyond 2^53 `(target)`; a bounded domain counter (`number_part`, at most 12 digits) stays a JSON `integer`.

## Code conventions

**Language and runtime.** TypeScript in strict mode plus the extra safety flags in `backend/tsconfig.json`. Node 26, ESM, run build-less via native type stripping (`node src/server.ts` — no `tsc` emit, no bundler, no loader); `tsc` is typecheck-only, and `erasableSyntaxOnly` forbids any TS construct that needs a runtime transform.

**Naming.** Explicit, fully-spelled names, no abbreviations (`context` not `c`, `error` not `err`, `request` not `req`), even where a framework's examples abbreviate. Exceptions: `id`, acronyms (`url`, `http`), the loop variable `i`, and a key a library acts on by name (pino's `err`).

**Function form.** `function` declaration for top-level exported functions; the arrow form only for handlers and callbacks whose type lives on the binding via a framework helper.

**Avoid over-DRY.** Keep code direct when the shared part is only argument forwarding, a one-line expression, or a tiny branch that makes each caller less readable. Duplication is cheaper than indirection when two functions name distinct operations but happen to share mechanics. Extract only when the helper owns real shared behavior, such as parsing, transaction handling, retry logic, error translation, or a rule that must change in one place.

**File layout.** High-level functions come before the lower-level ones they call (stepdown order), so a reader meets a module's purpose before its mechanics; this works because `function` declarations hoist. Types follow the same order — they hoist too, so a type that is the private detail of one declaration sits just after it, the way a helper function sits after its caller. Load-time declarations — constants, Zod schemas, and (in the API layer) the route's `createRoute` definition — cannot follow their consumers, so they form a short dependency-ordered preamble above the functions; a type shared across the module (a `z.infer` twin of its schema, a shape several functions use) belongs in that preamble, not trailing one consumer.

**Comments.** A comment explains what the code cannot state itself: a non-obvious *why*, a trap, or an invariant spanning several lines. It does not restate the code, and it does not re-explain cross-cutting design this document owns — it points to `ename-internals.md` by name (never a section heading, which churns). Implementation-local rationale lives in the comment next to the code, not in this document. Keep comments short and plain.

**Zod.** v4 at every boundary (HTTP input, HTTP output, DB rows). Schemas are declared at module top level — never rebuilt per request, since Zod's JIT cache keys on schema identity. They live with their consumer, and a shared schema is exported from the module that owns the concept. The Service-layer schemas (domain objects, native types) and the API-layer schemas (`.openapi()` annotations, serialized formats) are two separate sets with no cross-imports; crossing between them goes through an explicit mapping function, not a chained `.transform()`.

**Configuration.** Environment variables are read and validated once, in `src/config.ts` (Zod schema, fail-fast on invalid config); the rest of the code imports the typed `config` singleton and never reads `process.env` directly.

**Logging.** `pino`, emitting JSON in every environment including local dev, so the production log format is familiar from day one.

**Lint and format.** Prettier owns formatting; ESLint complements it without overlap and runs no opaque preset — each rule is individually justified (type-aware promise hygiene, import ordering and hygiene, unused-import removal). Prettier is left at its defaults except `singleQuote`, `printWidth: 100`, `endOfLine: 'lf'`.

## Tooling and supply chain

**Package manager** `(working hypothesis)`. npm 11.10+ with a versioned `.npmrc`: `min-release-age=3` (days), `ignore-scripts=true`, `engine-strict=true`. Packages allowed to run lifecycle scripts are listed in the `rebuild:trusted` script and reviewed through its diff. `lockfile-lint` and a CI check that `.npmrc` still disables scripts are `(target)` (no CI yet). The bet is reassessed at the npm 12 release; if its security defaults do not land, switch to pnpm.

**Dependencies.** Prefer the platform (`node:` built-ins, native runtime features) over a third-party package; weigh a dependency's maintenance health and supply-chain surface before adding one.

**SQL access.** `pg` with parameterized raw SQL; rows are parsed through Zod at the boundary. All SQL goes through two helpers — `queryRows` (parse plus snake_case-to-camelCase conversion) and `withTransaction`. Cases outside this pair (`LISTEN`/`NOTIFY`, `COPY`, streamed cursors) get their own helpers when they appear.

**Database package.** Schema, migrations, the migration runner and the local PostgreSQL cluster live in the `database/` package, sibling to `backend/` and shared by every consumer of the registry's database — the Node backend today, the Rust phase via `sqlx-cli`, future tooling. Migrations are pure SQL in the `<unix_ts>_<name>.up.sql`/`.down.sql` layout `sqlx-cli` reads directly. The runner is forward-only and enforces an advisory lock, a content hash that detects edits to already-applied migrations, a transaction per migration, and lexicographic ordering.

**Tests.** `node:test`, run as integration tests against a real PostgreSQL — no DB mocks, no mocked services. A dedicated `ename_test` database is kept apart from `ename_dev` by two distinct URLs and a `NODE_ENV !== 'test'` guard in the test DB lifecycle helper. Isolation is `TRUNCATE ... RESTART IDENTITY CASCADE` per test; `BEGIN`/`ROLLBACK` per test is excluded because it nests a SAVEPOINT under the code's own `withTransaction` and would hide real transactional behavior. Test files run sequentially (shared database) and close the pool after each file. Each test asserts only its layer's public surface. **API contract tests** drive the app via `app.fetch(request)` and observe only what an HTTP client sees. **Service tests** come in two grains: each concept's **data-access primitives** are tested directly (insert-then-read round-trips), and **use cases** are tested by running them and inspecting persisted state through those same primitives (`findSubjects`, `findEnames`, `findEvents`, `getEventByIdempotencyKey`), never raw `pool.query`. Reading state back through the primitives is not circular: they carry their own round-trip tests. A test-only database helper outside `src/database/` is forbidden.

## Infrastructure

**Hosting.** Scaleway, serverless: a Serverless Container for the backend (language-agnostic across Node and Rust) and Serverless SQL for the database. Node's cold start is higher than Rust's — plan a minimum instance count above zero once traffic is regular.

**Serverless SQL constraints.** Serverless SQL fronts each database with a PgBouncer in transaction mode and disables a set of PostgreSQL features. These are not reproducible on the local PostgreSQL, so the discipline is to avoid them by construction:

- Session state via `SET`/`RESET`/`DISCARD` is unreliable (connections are multiplexed between transactions) — set `statement_timeout` and the like through the driver's startup parameters, never a post-connection `SET`.
- `LISTEN`/`NOTIFY` has no delivery guarantee — excluded as a reliable mechanism; asynchronous messaging will go through a dedicated broker if the need arises.
- Advisory locks have no guarantee — usable only by off-prod-path tools (the migration runner), forbidden as an application coordination primitive.
- No `PREPARE TRANSACTION`, session temporary tables, `REFRESH MATERIALIZED VIEW CONCURRENTLY` or security labels; DDL on roles and databases goes through the Scaleway API, not SQL.
- Queries are capped at 1 MB and transactions are expected to be short.
- About 40 extensions are supported — verify any dependency against the current list before committing to it.

This list ages with the product; reconfirm it periodically against the Scaleway documentation.

**Connection pool.** A single `pg.Pool` singleton in the Service layer, with hard-coded parameters identical in dev and prod. The 5 s `statement_timeout` is an implicit latency SLA that constrains index and query design: a query that exceeds it is a bug, or a legitimate batch that must opt out with a `SET LOCAL` in its own transaction. `application_name` is set so the service is findable in `pg_stat_activity` and Scaleway logs.

## Open questions

- **[Q-PORT-TRIGGER]** The explicit trigger for the Node → Rust port — calendar, event (second operator, security audit, traffic threshold), or first-of-both. Must be fixed and written down before the v1 release, or the port never self-triggers.
- **[Q-LOG-STRUCT]** The exact cryptographic structure of the public log (linear CT/Sigsum-style, sparse Merkle/CONIKS-style, or hybrid), the signed-tree-head scheme, publication frequency, bootstrap snapshots, and any external anchoring. To settle by prototyping during the Node phase; it conditions the log's public format and API surface.
- **[Q-CRYPTO-AGILITY]** The multi-century crypto-agility plan: SHA-256 and Ed25519 will not last. The format must carry explicit suite versioning from v1 and a re-anchoring mechanism that preserves the commitment chain across a hash or signature change. Joint with [Q-LOG-STRUCT] and [Q-CRYPTO-IMPL].
- **[Q-OPKEY-MGMT]** Management of the operator signing key (HSM vs cloud KMS, possible k-of-n multi-signature, rotation, succession on loss or jurisdictional transfer). Near-irreversible once the first tree head is signed — settle before the v1 release.
- **[Q-REVOC-REASONS]** Whether revocations carry a codified reason (compromise, retirement, death) or stay opaque — it changes what a verifier can conclude about a signature made before the revocation. Tie with [Q-REVOC] in `ename-synthesis.md`.
- **[Q-RECOVERY-PROC]** The institutional framing of operator-mediated recovery as seen from the registry: effectiveness delays, re-verification requirements, contestation channel, audit. Distinct from the user-side [Q-KEYREC]; mostly regulation, with log-encoding implications.
- **[Q-LEGAL-DEMANDS]** The registry's prepared stance on legal demands for erasure or rectification, given a public append-only log: some are structurally impossible to honor, others (a forced deactivation mark) remain possible. Prepare with legal counsel before the v1 release.
