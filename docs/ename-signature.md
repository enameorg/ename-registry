# Ename — Signature

> This document describes only how a **registry event is signed and verified**: the keys, the signable document, its canonical form, the signature, and how a signature travels and is checked. Section 2 lists which signer each operation admits; how the registry enforces it is described in [Ename — Registry Internals](./ename-internals.md); the mission and governance of Ename in [Ename — Reference Synthesis](./ename-synthesis.md).
>
> Status: `[working hypothesis]`. This standard is implemented by the registry and relied on by its code, and has not yet been submitted to public consultation. Until then, it may still change.

## Overview

```
signable document ::= { "operation", "keyId", "idempotencyKey", "request" }
signed bytes      ::= UTF-8( JCS( signable document ) )        ; RFC 8785
signature         ::= ECDSA-P256-SHA256( private key, signed bytes ), as r ‖ s (64 bytes)
on the wire       ::= "signature": { "keyId", "value": base64url( signature ) }
```

Every event of the registry log is signed: by the registry, by an accredited platform, or later by an end user. All three use the mechanism described here, so a signature can be verified by anyone holding the log, with any language and any serious cryptographic library.

## 1. Keys

A key is recorded in the registry as an object of two fields:

```
"key": { "algorithm": "ecdsa-p256-sha256", "value": "<SPKI DER, base64url>" }
```

- **`algorithm`** names the signature algorithm. One value exists today: `ecdsa-p256-sha256`, ECDSA over the NIST P-256 curve with SHA-256, known as ES256 in the JOSE and COSE registries. A new algorithm will be a new value.
- **`value`** is the public key as an X.509 SubjectPublicKeyInfo structure, DER-encoded, then encoded in base64url without padding. The point is uncompressed: one key has one spelling.

A key is identified by a **`keyId`**, a UUIDv7 the registry assigns when it records the key and returns in the event's outcome. The one exception is the anchor (section 6), whose identifier is chosen by its holder.

## 2. The Signable Document

The signer signs the **signable document**, a JSON object of exactly four members:

| Member           | Content                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `operation`      | The operation requested, in the imperative (table below).                                                                    |
| `keyId`          | The identifier of the signing key. It names the signer, and through the key its owner.                                       |
| `idempotencyKey` | The idempotency key of the request.                                                                                          |
| `request`        | The request of the event, exactly as submitted: the members of the body that the registry records, path parameters included. |

The outcome of an event, what the registry allocates when it performs the operation, is never signed by the signer: it does not exist yet when the request is signed.

The operations, and the event kind each one produces in the log:

| Operation           | Event kind            | Request                      | Signed by                        |
| ------------------- | --------------------- | ---------------------------- | -------------------------------- |
| `registry.anchor`   | `registry.anchored`   | `{ key }`                    | The key it records (section 6)   |
| `platform.accredit` | `platform.accredited` | `{ platform, key }`          | The registry                     |
| `platform.add-key`  | `platform.key-added`  | `{ platform: { id }, key }`  | The registry                     |
| `subject.register`  | `subject.registered`  | `{ subject, ename }`         | An accredited platform           |
| `subject.add-ename` | `subject.ename-added` | `{ subject: { id }, ename }` | The home platform of the subject |

The operation keeps a signature from serving another operation whose request would have the same shape. The registry API also declares each write route's operation, in the `x-ename-operation` extension of its OpenAPI description.

**No non-integer number.** A signable document carries no number with a fractional part or an exponent. JCS defines their serialization exactly, but the decimal value a language reads from such a number is the first place two implementations disagree; a value that needs one travels as a string.

## 3. Canonical Form

The signed bytes are the UTF-8 encoding of the document canonicalized with the **JSON Canonicalization Scheme**, [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), applied as the RFC defines it. In short: members sorted by the UTF-16 code units of their names, no whitespace, strings and numbers serialized as ECMAScript does. A document that JCS refuses (a string holding a lone surrogate, a non-finite number) cannot be signed.

## 4. Signature

The signature is ECDSA over P-256 with SHA-256, computed on the signed bytes and encoded in the **IEEE P1363** form: the two integers `r` and `s`, each on 32 bytes, concatenated, 64 bytes in all (not the DER form some libraries produce by default). It travels in base64url without padding, 86 characters.

ECDSA is randomized: two signatures of the same document differ, and both are valid. The bytes of a signature therefore never identify what it signs: the registry recognizes a request sent again by its idempotency key and the key that signed it, not by its signature. A request sent again must be signed by the same key; the same idempotency key under another key, even one of the same owner, is answered with `409`.

## 5. Transmission and Verification

A signed request carries its signature in the JSON body, beside the members it signs:

```json
{
  "idempotencyKey": "01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f",
  "signature": { "keyId": "01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e4c", "value": "qTkPH6h7…" },
  "subject": { "kind": "person" },
  "ename": { "namePart": "jean-dupont" }
}
```

The document itself is not sent: the registry rebuilds it from the route (the operation), the path and the body, then verifies the signature with the key `keyId` names. A signature that does not verify, or names an unknown key, is answered with `401` and the header `WWW-Authenticate: EnameSignature`; a valid signature by a key whose owner may not submit this request is answered with `403`. A request that cannot be signed (a string that is not well-formed Unicode, a number with a fraction or an exponent) is answered with `422`, before its signature is checked.

The log stores, for every event, its kind, the signing `keyId`, the idempotency key, the request and the signature. Anyone holding the log rebuilds the signable document from them, the operation being the one that produces the event's kind, and verifies the signature with the key an earlier event of the log recorded.

## 6. The Anchor

The first event of the log is the **anchor**, of kind `registry.anchored`: it records the first registry key and is signed by that key itself, under the `keyId` its holder chose for it. It is the only self-signed event, and the log holds only one; every other event is signed by a key an earlier event recorded, so the anchor comes first. A verifier can trust it only through a channel outside the log: Ename publishes the key's fingerprint, the SHA-256 of its SPKI DER bytes, in hexadecimal, on channels it controls independently of the registry.

## 7. Test Vector

A signer must produce the canonical bytes below from the document; a verifier must accept the signature. This key exists for testing only.

Private key (PKCS #8, PEM):

```
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0u7P2KpW4OGTdGhD
qdhL6gWZEaaMRt3hbg/ibmHU3tahRANCAARW3Z43W+7lfagp0wtHSHkAz58EzElm
LD++zNu0dkkXIU7zPAMVUAVv2fUr4VFLB/xc0mcSGYaf/2nnV5u/gg2o
-----END PRIVATE KEY-----
```

Public key `value`:

```
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVt2eN1vu5X2oKdMLR0h5AM-fBMxJZiw_vszbtHZJFyFO8zwDFVAFb9n1K-FRSwf8XNJnEhmGn_9p51ebv4INqA
```

Fingerprint (SHA-256 of the SPKI DER bytes): `2d8066fabd9af7124886fd3f184a0b5c50b33d79571613cd81435b6953b298ee`

Signable document, canonical form (its SHA-256: `890322738fbd29fb200719fc83b0e7ca93dd93a91935e6f9a3f2c3c1934b476b`):

```
{"idempotencyKey":"01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e0f","keyId":"01927e8f-9b2a-7c3d-8e4f-5a6b7c8d9e4c","operation":"subject.register","request":{"ename":{"namePart":"jean-dupont"},"subject":{"kind":"person"}}}
```

Signature `value`:

```
qTkPH6h79mbRd9_R9DTCf7G_twazfHsA6sK2NfCMWBH1iBPuaO8qINNAwD43cuXdPMn1efkprJ22LxJ8zi6QXw
```

For the canonical form itself, the reference vectors of RFC 8785 are those of [cyberphone/json-canonicalization](https://github.com/cyberphone/json-canonicalization/tree/master/testdata), against which the registry's implementation is tested.

## 8. Rationale

- **A canonical document rather than an envelope.** The log stores the request as structured data, the primary record a verifier reads. Signing its canonical form keeps one copy of what was submitted; an envelope (JWS, COSE) would store a second, opaque one beside it, or replace the data with bytes a reader must decode. JCS is the canonicalization standardized for JSON, and its exactness is checked by public vectors rather than assumed of each library.
- **ES256 rather than Ed25519.** The keys of end users will live in secure enclaves, and the hardware of phones and computers supports P-256 (Apple Secure Enclave, Android StrongBox) where it does not support Ed25519. One algorithm serves the three kinds of signer.
- **P1363 rather than DER** for the signature: a fixed length, one encoding, the form WebCrypto and JOSE use.
- **SPKI for the key:** the standard structure every library imports, which names its algorithm and curve itself.

## 9. Planned Evolutions

- **End-user signatures.** Key rotation, revocation and deactivation will be signed by the end user's current key, with this same document. A passkey (WebAuthn) does not sign arbitrary bytes: it will need a proof format that wraps the same signable document (`[Q-CRYPTO-IMPL]`).
- **New algorithms.** The algorithms of today will not last for centuries; a new one will be a new `algorithm` value, and the re-anchoring of existing commitments is `[Q-CRYPTO-AGILITY]`.
- **Operation and event kind.** Each operation produces exactly one event kind, by the table of section 2; whether the log should record the operation itself, and under which name, is `[Q-OPERATION-KIND]`.
