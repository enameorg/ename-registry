import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../src/logger.ts';
import { closeDatabase } from '../src/services/application/index.ts';
import { createSignature } from '../src/services/common/index.ts';
import {
  anchorRegistry,
  registryAnchoredEventKindDefinition,
} from '../src/services/registry/index.ts';
import { encodePublicKey, generateKeyPair } from '../src/utilities/signature.ts';
import { generateUUIDv7 } from '../src/utilities/uuid.ts';

// Anchor the registry of the loaded environment: generate the first registry key, sign the anchor
// with it, write the anchor as the first event of the log, and keep the private key in
// backend/.keys/, git-ignored. The anchor is written through the Service, with direct database
// access, since no key yet exists to sign a request to the API. Refused when the registry is
// already anchored, and when a registry key file already exists. Local environments only: in
// production the custody of the registry key is [Q-REGKEY-MGMT].

const keysDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.keys');
const privateKeyPath = resolve(keysDirectory, 'registry.pem');
const keyIdPath = resolve(keysDirectory, 'registry.key-id');

const { publicKey, privateKey } = generateKeyPair();
const keyId = generateUUIDv7();
const idempotencyKey = generateUUIDv7();
const request = {
  key: { algorithm: 'ecdsa-p256-sha256' as const, value: encodePublicKey(publicKey) },
};
const signature = createSignature(privateKey, {
  operation: registryAnchoredEventKindDefinition.operation,
  keyId,
  idempotencyKey,
  request,
});

await mkdir(keysDirectory, { recursive: true });
// The key files first, `wx` refusing to overwrite: a registry key is never replaced by accident.
// Removed again if the anchor is refused.
await writeFile(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
  flag: 'wx',
  mode: 0o600,
});
await writeFile(keyIdPath, `${keyId}\n`, { flag: 'wx' });

try {
  await anchorRegistry({ idempotencyKey, signature, ...request }, { logger });
} catch (error) {
  await rm(privateKeyPath);
  await rm(keyIdPath);
  throw error;
} finally {
  await closeDatabase();
}

// The fingerprint to publish outside the log: SHA-256 of the SPKI DER bytes.
const fingerprint = createHash('sha256')
  .update(publicKey.export({ format: 'der', type: 'spki' }))
  .digest('hex');

console.log(`Registry anchored with key ${keyId}`);
console.log(`Public key fingerprint (SHA-256 of the SPKI DER): ${fingerprint}`);
console.log(`Private key written to ${privateKeyPath}`);
