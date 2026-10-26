import type { ZodError } from 'zod';

// Domain errors raised by the Service layer, which knows nothing about HTTP; the
// API layer's error module maps each to a Problem Details response (see api/errors.ts).
// Discriminated classes (not a tagged union) so instanceof works in the handler.

export class DomainError extends Error {
  public override readonly name: string = 'DomainError';
}

export class ValidationError extends DomainError {
  public override readonly name = 'ValidationError';
  public readonly errors: ValidationIssue[];

  constructor(detail: string, errors: ValidationIssue[] = []) {
    super(detail);
    this.errors = errors;
  }
}

export type ValidationIssue = {
  path: Array<string | number>;
  message: string;
};

// The one translation of a Zod failure into the domain's vocabulary. The write
// protocol raises it when a request fails its kind's strict parse, and the
// API's validation hook builds its 422 from it, so a malformed request yields
// the same detail and issues whatever the caller (cf. ename-internals.md).
export function validationErrorFromZodError(error: ZodError): ValidationError {
  const issues = error.issues.map((issue) => ({
    // Cast: Zod types issue.path as PropertyKey[] (includes symbol), but a
    // parsed JSON structure only ever has string/number paths. Narrowing
    // keeps ValidationIssue JSON-safe.
    path: [...issue.path] as Array<string | number>,
    message: issue.message,
  }));
  const issueCount = issues.length;
  return new ValidationError(
    `${issueCount} validation error${issueCount === 1 ? '' : 's'}.`,
    issues,
  );
}

export class NotFoundError extends DomainError {
  public override readonly name = 'NotFoundError';

  constructor(detail: string) {
    super(detail);
  }
}

export class ConflictError extends DomainError {
  public override readonly name = 'ConflictError';

  constructor(detail: string) {
    super(detail);
  }
}

export class IdempotencyConflictError extends DomainError {
  public override readonly name = 'IdempotencyConflictError';

  constructor(detail: string) {
    super(detail);
  }
}

// Raised when an optimistic-retry budget is exhausted under contention
// (currently number_part allocation on a hot name_part). Transient and the
// request is valid — it succeeds on retry. The API maps it to 503 + Retry-After,
// not 500: a capacity signal, not a server fault (matters for client retries
// and 5xx alerting).
export class ContentionError extends DomainError {
  public override readonly name = 'ContentionError';

  constructor(detail: string) {
    super(detail);
  }
}
