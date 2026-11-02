import type { KeyObject } from 'node:crypto';

import { z } from 'zod';

import {
  Base64URLSchema,
  type PublicKey,
  signDocument,
  verifyDocumentSignature,
} from '../../utilities/signature.ts';
import { UUIDv7Schema } from '../../utilities/uuid.ts';
import { type ValidationIssue, validationErrorFromIssues } from '../errors.ts';

// ---------------------------------------------------------------------------
// The signature of a request
// ---------------------------------------------------------------------------

// What a signer submits beside a request: the key it signed with and the
// signature, strict like every input. The document it signs is not sent: the
// registry rebuilds it (see docs/ename-signature.md).
export const SignatureSchema = z.strictObject({
  keyId: UUIDv7Schema,
  value: Base64URLSchema,
});

export type Signature = z.infer<typeof SignatureSchema>;

// What a signer signs, before its JCS form: the operation, which keeps a
// signature from serving another operation; the key, which names the signer;
// the idempotency key; and the request exactly as submitted. Never the
// outcome, which the registry allocates after the signature.
export type SignableDocument = {
  operation: string;
  keyId: string;
  idempotencyKey: string;
  request: unknown;
};

// The signature of a document by the private key its keyId names.
export function createSignature(privateKey: KeyObject, document: SignableDocument): Signature {
  return { keyId: document.keyId, value: signDocument(privateKey, document) };
}

// Whether `value` is a signature of the document by the key. That the key is
// the one the document's keyId names is the caller's to establish.
export function isSignatureValid(
  key: PublicKey,
  document: SignableDocument,
  value: string,
): boolean {
  return verifyDocumentSignature(key, document, value);
}

// ---------------------------------------------------------------------------
// What a request must be to be signed
// ---------------------------------------------------------------------------

// Refuse, as the caller's fault, a request holding a value that two
// implementations would not read or canonicalize alike, so that no signature
// can cover it: a string that is not well-formed Unicode, which JCS refuses,
// or a number JCS writes with a fraction or an exponent, which the standard
// excludes (docs/ename-signature.md). The first such value found is the issue,
// at its path. Run after the request's own parse, before its signature is
// checked: without it, verifying would throw instead of answering.
export function assertPortableValues(request: unknown): void {
  const issue = findNonPortableValue(request, []);
  if (issue !== undefined) throw validationErrorFromIssues([issue]);
}

function findNonPortableValue(
  value: unknown,
  path: Array<string | number>,
): ValidationIssue | undefined {
  if (typeof value === 'string') {
    return value.isWellFormed() ? undefined : { path, message: 'must be well-formed Unicode text' };
  }
  if (typeof value === 'number') {
    // From 10^21, JCS writes an integer in exponent form.
    return Number.isInteger(value) && Math.abs(value) < 1e21
      ? undefined
      : { path, message: 'must be an integer' };
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const issue = findNonPortableValue(item, [...path, index]);
      if (issue !== undefined) return issue;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (!key.isWellFormed()) {
        return { path: [...path, key], message: 'must be a well-formed Unicode name' };
      }
      const issue = findNonPortableValue(item, [...path, key]);
      if (issue !== undefined) return issue;
    }
  }
  return undefined;
}
