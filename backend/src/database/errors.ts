// Helpers for narrowing `pg` driver errors.
//
// The `pg` driver throws errors with `code` (5-char SQLSTATE) and `constraint`
// (the violated constraint's name) populated on integrity violations. Matching
// both is the canonical pattern for distinguishing one UNIQUE collision from
// another in code paths that race on multiple constraints (e.g. a service
// that catches a 23505 on `events.idempotency_key` separately from a 23505
// on `enames.name_part_number_part_key`).

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}
