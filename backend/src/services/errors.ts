// Domain-level errors raised by the Service Layer.
// The Service Layer throws these without knowing anything about HTTP; the API
// Layer catches them in its onError handler and maps each to a Problem Details
// response (cf. src/api/problem.ts).
//
// Kept as discriminated classes (not a tagged union) so `instanceof` works in
// the handler — direct port to Rust enums later, where the same mapping lives
// on the axum error handler.

export class DomainError extends Error {
  public override readonly name: string = 'DomainError';
}

export type ValidationIssue = {
  path: Array<string | number>;
  message: string;
};

export class ValidationError extends DomainError {
  public override readonly name = 'ValidationError';
  public readonly errors: ValidationIssue[];

  constructor(detail: string, errors: ValidationIssue[] = []) {
    super(detail);
    this.errors = errors;
  }
}

export class IdempotencyConflictError extends DomainError {
  public override readonly name = 'IdempotencyConflictError';

  constructor(detail: string) {
    super(detail);
  }
}
