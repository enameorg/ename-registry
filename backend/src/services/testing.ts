import { type KeyObject, randomInt } from 'node:crypto';

import { pino } from 'pino';

import type { Database } from '../database/query.ts';
import { encodePublicKey, generateKeyPair } from '../utilities/signature.ts';
import { generateUUIDv7 } from '../utilities/uuid.ts';

import { createSignature, type Signature } from './common/index.ts';
import {
  type Event,
  type EventKindDefinition,
  type EventRequest,
  rebuildEvent,
} from './event/index.ts';
import { insertKey } from './key/index.ts';
import {
  accreditPlatform,
  insertPlatform,
  type Platform,
  platformAccreditedEventKindDefinition,
} from './platform/index.ts';
import { anchorRegistry, registryAnchoredEventKindDefinition } from './registry/index.ts';

// The signing side of the Service tests: the keys a test signs with, the
// registry anchored and a platform accredited through the real use cases, and
// the signature of a request. Test-only, like src/database/testing.ts; a test
// of a higher layer reaches it for its setup. Test doctrine:
// ename-internals.md.

const context = { logger: pino({ level: 'silent' }) };

// A key a test signs with: its id in the registry and its private half, which
// the registry never holds.
export type TestSigner = {
  keyId: string;
  privateKey: KeyObject;
};

export type TestPlatformSigner = TestSigner & { platformId: string };

// The signature of a request of this kind by this signer.
export function signRequest<Definition extends EventKindDefinition>(
  definition: Definition,
  signer: TestSigner,
  params: { idempotencyKey: string; request: EventRequest<Definition> },
): Signature {
  return createSignature(signer.privateKey, {
    operation: definition.operation,
    keyId: signer.keyId,
    idempotencyKey: params.idempotencyKey,
    request: params.request,
  });
}

// A use case's input, its signature added: the input less its idempotency key
// is the request, as every write use case builds it.
export function signInput<
  Definition extends EventKindDefinition,
  Input extends { idempotencyKey: string } & EventRequest<Definition>,
>(definition: Definition, signer: TestSigner, input: Input): Input & { signature: Signature } {
  const { idempotencyKey, ...request } = input;
  return {
    ...input,
    signature: signRequest(definition, signer, {
      idempotencyKey,
      // Cast: TypeScript cannot follow that the rest of Input, less the
      // idempotency key, is the kind's request.
      request: request as EventRequest<Definition>,
    }),
  };
}

// A new P-256 key pair: the public half as the registry records it, the
// private half to sign with.
export function generateTestKey(): { publicKey: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey: encodePublicKey(publicKey), privateKey };
}

// Anchor the registry of the test database, as the initialization command
// does, and return the registry key to sign with.
export async function anchorTestRegistry(): Promise<TestSigner> {
  const { publicKey, privateKey } = generateTestKey();
  const registry = { keyId: generateUUIDv7(), privateKey };
  await anchorRegistry(
    signInput(registryAnchoredEventKindDefinition, registry, {
      idempotencyKey: generateUUIDv7(),
      key: { algorithm: 'ecdsa-p256-sha256', value: publicKey },
    }),
    context,
  );
  return registry;
}

// Accredit a platform with a key of its own, signed by the registry key, and
// return that key to sign with. Each call accredits another legal entity.
export async function accreditTestPlatform(registry: TestSigner): Promise<TestPlatformSigner> {
  const { publicKey, privateKey } = generateTestKey();
  const { platform, key } = await accreditPlatform(
    signInput(platformAccreditedEventKindDefinition, registry, {
      idempotencyKey: generateUUIDv7(),
      platform: makePlatformInput(),
      key: { algorithm: 'ecdsa-p256-sha256', value: publicKey },
    }),
    context,
  );
  return { keyId: key.id, privateKey, platformId: platform.id };
}

// The registry anchored and one platform accredited: the setup of a test that
// writes subjects. The database is reset before each test, so each test sets
// up its own.
export async function setUpTestPlatform(): Promise<{
  registry: TestSigner;
  platform: TestPlatformSigner;
}> {
  const registry = await anchorTestRegistry();
  const platform = await accreditTestPlatform(registry);
  return { registry, platform };
}

// A platform row written directly, for a test of a primitive that needs one
// to reference, with no event behind it.
export async function insertTestPlatform(db: Database): Promise<Platform> {
  return await insertPlatform(db, {
    id: generateUUIDv7(),
    ...makePlatformInput(),
    createdAt: new Date(),
  });
}

// A key row written directly, with no event behind it, and the private half
// that signs with it: for a test of an authentication, which needs a key the
// log would hold. With no platform, a registry key.
export async function insertTestKey(db: Database, platformId: string | null): Promise<TestSigner> {
  const { publicKey, privateKey } = generateTestKey();
  const key = await insertKey(db, {
    id: generateUUIDv7(),
    platformId,
    algorithm: 'ecdsa-p256-sha256',
    value: publicKey,
    createdAt: new Date(),
  });
  return { keyId: key.id, privateKey };
}

// A legal identity of its own: the registration identifier is what makes two
// platforms two legal entities. A random nine-digit SIREN, the identifier the
// authority RA000189 issues; two calls of a test draw the same one about once
// in a billion.
export function makePlatformInput() {
  return {
    legalName: 'TEST PLATFORM',
    jurisdiction: 'FR',
    registrationAuthorityCode: 'RA000189',
    registrationIdentifier: String(randomInt(1, 1_000_000_000)).padStart(9, '0'),
  };
}

// Rebuild these events, in the order given, each through the definition of its
// kind among those listed: a kind's rebuild test passes the setup's events
// with its own, since the rows it writes reference the platform the setup
// accredited. An event of a kind not listed is a mistake of the test.
export async function rebuildEvents(
  db: Database,
  events: readonly Event[],
  definitions: readonly EventKindDefinition[],
): Promise<void> {
  for (const event of events) {
    const definition = definitions.find((candidate) => candidate.kind === event.kind);
    if (definition === undefined) {
      throw new Error(`no definition listed for ${event.kind}`);
    }
    await rebuildEvent(db, definition, event);
  }
}

// The definitions of the setup's events, for rebuildEvents.
export const setUpEventKindDefinitions: readonly EventKindDefinition[] = [
  registryAnchoredEventKindDefinition,
  platformAccreditedEventKindDefinition,
];
