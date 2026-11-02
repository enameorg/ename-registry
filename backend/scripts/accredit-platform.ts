import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createSignature } from '../src/services/common/index.ts';
import { platformAccreditedEventKindDefinition } from '../src/services/platform/index.ts';
import { encodePublicKey, generateKeyPair } from '../src/utilities/signature.ts';
import { generateUUIDv7 } from '../src/utilities/uuid.ts';

// Accredit a platform on a running registry: build the request, sign it with
// the registry key that init-registry.ts wrote to backend/.keys/, and submit it
// to POST /api/v1/platforms, the path every registry event but the anchor
// takes. The platform's public key comes from the platform, as a PEM file: it
// keeps its private key. For local development only, the script generates the
// platform's key pair when none is given and writes the private key beside
// the registry's.
//
//   npm run platform:accredit -- --legal-name 1PLACE --jurisdiction FR \
//     --registration-authority-code RA000189 \
//     --registration-identifier 951595875 \
//     [--public-key path/to/public.pem] [--url http://localhost:3000]

const keysDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.keys');

const { values } = parseArgs({
  options: {
    'legal-name': { type: 'string' },
    jurisdiction: { type: 'string' },
    'registration-authority-code': { type: 'string' },
    'registration-identifier': { type: 'string' },
    'public-key': { type: 'string' },
    url: { type: 'string', default: `http://localhost:${process.env['PORT'] ?? '3000'}` },
  },
});

const platform = {
  legalName: requireOption('legal-name'),
  jurisdiction: requireOption('jurisdiction'),
  registrationAuthorityCode: requireOption('registration-authority-code'),
  registrationIdentifier: requireOption('registration-identifier'),
};

const registryPrivateKey = createPrivateKey(
  await readFile(resolve(keysDirectory, 'registry.pem'), 'utf8'),
);
const registryKeyId = (await readFile(resolve(keysDirectory, 'registry.key-id'), 'utf8')).trim();

const publicKeyPath = values['public-key'];
let generated: { publicKey: KeyObject; privateKey: KeyObject } | undefined;
let platformPublicKey: KeyObject;
if (publicKeyPath === undefined) {
  generated = generateKeyPair();
  platformPublicKey = generated.publicKey;
} else {
  platformPublicKey = createPublicKey(await readFile(publicKeyPath, 'utf8'));
}

const idempotencyKey = generateUUIDv7();
const request = {
  platform,
  key: { algorithm: 'ecdsa-p256-sha256' as const, value: encodePublicKey(platformPublicKey) },
};
const signature = createSignature(registryPrivateKey, {
  operation: platformAccreditedEventKindDefinition.operation,
  keyId: registryKeyId,
  idempotencyKey,
  request,
});

const response = await fetch(new URL('/api/v1/platforms', values.url), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    idempotencyKey,
    signature,
    ...request,
  }),
});
const body = (await response.json()) as { key?: { id?: string } };
console.log(JSON.stringify(body, null, 2));
if (response.status !== 201) {
  process.exit(1);
}

if (generated !== undefined && body.key?.id !== undefined) {
  const privateKeyPath = resolve(keysDirectory, `platform-${body.key.id}.pem`);
  await writeFile(privateKeyPath, generated.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(`Platform private key written to ${privateKeyPath}`);
}

function requireOption(name: string): string {
  const value = (values as Record<string, string | undefined>)[name];
  if (value === undefined) {
    console.error(`Missing --${name}`);
    process.exit(1);
  }
  return value;
}
