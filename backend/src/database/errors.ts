// Narrowing pg driver errors: the integrity violations a primitive translates
// into a domain error, and the unavailability the query helpers translate
// into an UnavailableError.

// ---------------------------------------------------------------------------
// Integrity violations
// ---------------------------------------------------------------------------

// On an integrity violation pg populates `code` (SQLSTATE) and `constraint`
// (the violated constraint's name); matching both distinguishes one violation
// from another when a path can hit several (e.g. events.idempotency_key vs
// enames.name_part_number_part_key).

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23503' && candidate.constraint === constraint;
}

export function isCheckViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23514' && candidate.constraint === constraint;
}

// ---------------------------------------------------------------------------
// Unavailability
// ---------------------------------------------------------------------------

// The database did not answer: unreachable, refusing connections, saturated or
// lost mid-statement. Transient, so the request may be retried as it is; the
// pg error that revealed it is the cause. Not a domain error: the Service
// layer re-exports it under the same name, and the query helpers raise it for
// every statement they run (cf. ename-internals.md).
export class UnavailableError extends Error {
  public override readonly name = 'UnavailableError';

  constructor(options: { cause: unknown }) {
    super('the database did not answer', options);
  }
}

// Whether a pg error means the database did not answer, as opposed to one
// that answered with a failure. A statement canceled by statement_timeout
// (57014) stays a failure, since a query that slow is a bug; so do the other
// resource exhaustions of class 53 (disk, memory), which a retry in a few
// seconds would not cure.
export function isUnavailability(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code } = error as { code?: unknown };
  if (typeof code === 'string') {
    if (NETWORK_ERROR_CODES.has(code) || UNAVAILABILITY_SQLSTATES.has(code)) return true;
    if (code.startsWith(CONNECTION_EXCEPTION_SQLSTATE_CLASS)) return true;
  }
  // Node reports a refused connection to a host of several addresses (an IPv4
  // and an IPv6 localhost) as an AggregateError of one error per address.
  if (error instanceof AggregateError) {
    return error.errors.some((inner) => isUnavailability(inner));
  }
  return DRIVER_UNAVAILABILITY_MESSAGES.has(error.message);
}

// System errors of the socket under the connection.
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

// SQLSTATEs of a server that refuses or drops the connection: class 08
// (connection exception), the server shutting down or starting up, and too
// many connections, the connection limit of a serverless database.
const CONNECTION_EXCEPTION_SQLSTATE_CLASS = '08';
const UNAVAILABILITY_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);

// The errors pg and pg-pool raise without a code, recognized by their message
// since the driver offers nothing else (pg 8.23, pg-pool 3.14). query.test.ts
// produces each one for real, so an upgrade that rewords one fails there; in
// production it would fall back to the opaque 500, still logged. A query read
// timeout means the server answered nothing for longer than the
// statement_timeout it would otherwise have enforced.
const DRIVER_UNAVAILABILITY_MESSAGES = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
  'Client has encountered a connection error and is not queryable',
  'Query read timeout',
]);
