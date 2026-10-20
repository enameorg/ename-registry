---
status: accepted
date: 2026-10-20
---

# Thread the database connection explicitly

## Context

Every data-access primitive runs on a connection: the pool outside a transaction, one checked-out client inside it. Once every primitive took that connection as its first argument, the same handle carried three names by capability — pool, client, or either — and the counter allocation, whose retry needs a savepoint, could not take the pool at all. An alternative was on the table: an ambient connection, resolved from Node's async context (`AsyncLocalStorage`), set by the transaction helper and read by the query helper, so that primitives and use cases carry no connection argument, cannot escape the transaction by mistake, and a nested transaction helper becomes a savepoint on its own.

## Decision

The connection is an explicit argument, `Pool | PoolClient`, first on every primitive. The transaction helper takes it too, and nests by its type: a transaction on the pool, a savepoint on a client, whose existence already means "inside a transaction". A nested block that fails rolls back to its savepoint and rethrows its own error; the enclosing transaction stays usable and its caller decides. The helper is the only place that knows the words `BEGIN`, `COMMIT` and `SAVEPOINT`; the counter allocation runs each attempt in a nested block and so accepts the pool like every other primitive.

## Considered options

- **An ambient connection via async context.** Rejected. The write protocol's idempotency rests on its preliminary lookup and its reconciliation running _outside_ the transaction; with an ambient connection that guarantee holds only while nobody calls the protocol from a transaction of their own, and the breach is silent. The propagation model admits no hidden channel. The ergonomic gain is real; these two costs outweigh it.
- **A client-only signature for the allocation.** Rejected: nesting in the helper makes the exception unnecessary.

## Consequences

- A projection writer can pass the pool by mistake inside its transaction; the type does not forbid it. The import of the pool singleton is the thing to watch in review.
- Nesting by savepoint constrains callers — no parallel statements inside one transaction, one release per loop turn; the internals state those rules.
