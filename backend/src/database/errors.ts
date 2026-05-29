// Helpers for narrowing pg driver errors. On integrity violations pg populates
// `code` (SQLSTATE) and `constraint` (the violated constraint's name); matching
// both distinguishes one UNIQUE collision from another when a path can race on
// several (e.g. events.idempotency_key vs enames.name_part_number_part_key).

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}
