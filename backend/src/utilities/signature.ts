import { createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from 'node:crypto';

import canonicalize from 'canonicalize';
import { z } from 'zod';

// The signature mechanism every signer of the registry shares — the registry, the platforms, later
// the end users: a document canonicalized with JCS (RFC 8785), signed in ES256 (ECDSA P-256 with
// SHA-256) in the IEEE P1363 encoding (r‖s, 64 bytes), the public key an SPKI DER structure; bytes
// travel in base64url without padding. The public standard is docs/ename-signature.md.

// The algorithms a key may declare, as a pure schema.
export const KeyAlgorithmSchema = z.enum(['ecdsa-p256-sha256']);

export type KeyAlgorithm = z.infer<typeof KeyAlgorithmSchema>;

// No regex flags, so the API can carry it as an OpenAPI `pattern`.
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

const BASE64URL_MESSAGE = 'must be base64url without padding';

// Bytes as text: unpadded base64url, in its canonical form only. Node's decoder ignores the unused
// low bits of the last character, so several strings decode to the same bytes; accepting only the
// one the encoder emits gives each byte string a single spelling.
export const Base64URLSchema = z
  .string()
  .regex(BASE64URL_REGEX, { message: BASE64URL_MESSAGE, abort: true })
  .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value, {
    message: BASE64URL_MESSAGE,
  });

// A public key as the registry records it: the algorithm and the SPKI DER structure in base64url.
export type PublicKey = { algorithm: KeyAlgorithm; value: string };

// An ES256 signature in P1363: r and s, 32 bytes each.
const P1363_SIGNATURE_BYTES = 64;

// ---------------------------------------------------------------------------
// Signing and verification
// ---------------------------------------------------------------------------

// Sign the JCS form of a document; the signature in base64url. ECDSA is randomized: signing the
// same document twice yields two valid signatures, so a signature's bytes never identify what it
// signs.
export function signDocument(privateKey: KeyObject, document: unknown): string {
  return sign('sha256', canonicalBytes(document), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
}

// Whether `signature` is a valid signature of the document's JCS form by the key. A malformed key
// or signature is not an error, only an invalid signature: the caller learns no more than the
// verdict.
export function verifyDocumentSignature(
  publicKey: PublicKey,
  document: unknown,
  signature: string,
): boolean {
  const keyObject = importPublicKey(publicKey);
  if (keyObject === undefined) return false;
  const signatureBytes = Buffer.from(signature, 'base64url');
  if (
    signatureBytes.length !== P1363_SIGNATURE_BYTES ||
    signatureBytes.toString('base64url') !== signature
  ) {
    return false;
  }
  return verify(
    'sha256',
    canonicalBytes(document),
    { key: keyObject, dsaEncoding: 'ieee-p1363' },
    signatureBytes,
  );
}

// The JCS form of a document: RFC 8785 as the canonicalize package implements it, its conformance
// pinned by signature.test.ts against the reference vectors. Throws on what JCS excludes (a lone
// surrogate, a non-finite number) and on a value with no JSON representation.
export function canonicalizeDocument(document: unknown): string {
  const canonical = canonicalize(document);
  if (canonical === undefined) {
    throw new Error('the document has no JSON representation');
  }
  return canonical;
}

function canonicalBytes(document: unknown): Buffer {
  return Buffer.from(canonicalizeDocument(document), 'utf8');
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

// Whether the value is a key of the declared algorithm: a P-256 SPKI DER structure, in the exact
// bytes Node exports for it (no second encoding of the same key, such as a compressed point).
export function isValidPublicKey(publicKey: PublicKey): boolean {
  return importPublicKey(publicKey) !== undefined;
}

function importPublicKey(publicKey: PublicKey): KeyObject | undefined {
  let keyObject: KeyObject;
  try {
    keyObject = createPublicKey({
      key: Buffer.from(publicKey.value, 'base64url'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return undefined;
  }
  if (
    keyObject.asymmetricKeyType !== 'ec' ||
    keyObject.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
    encodePublicKey(keyObject) !== publicKey.value
  ) {
    return undefined;
  }
  return keyObject;
}

// A new key pair for the one algorithm: what the scripts and the tests sign with. The registry
// itself never holds a private key.
export function generateKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

// The public half as the registry records it: SPKI DER in base64url.
export function encodePublicKey(publicKey: KeyObject): string {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
}
