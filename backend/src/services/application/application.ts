import { closePool, pool } from '../../database/pool.ts';
import { pingDatabase } from '../../database/query.ts';
import type { ServiceContext } from '../context.ts';

// Bound on the database probe, well under the pool's 5 s statement_timeout: a
// monitoring probe must answer fast, and a slow database counts as unhealthy.
const DATABASE_PROBE_TIMEOUT_MS = 1_000;

// Liveness: the process answers, nothing else is checked, by design (cf.
// ename-internals.md).
export function health(): boolean {
  return true;
}

// Deep check: the database answers a trivial query within the bound. The failure
// goes to the log; the caller only needs the verdict.
export async function checkDatabase(context: ServiceContext): Promise<boolean> {
  try {
    await pingDatabase(pool, DATABASE_PROBE_TIMEOUT_MS);
    return true;
  } catch (error) {
    context.logger.warn({ err: error }, 'database probe failed');
    return false;
  }
}

// Release the database at shutdown, once in-flight requests have drained. The
// runtime entry calls this, so the pool stays invisible outside the Service
// layer (cf. ename-internals.md).
export async function closeDatabase(): Promise<void> {
  await closePool();
}
