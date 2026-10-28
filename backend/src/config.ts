import { z } from 'zod';

// No environment is named here: a local script loads its environment's file,
// the deployment sets production's (cf. ename-internals.md).
const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  databaseURL: z.url(),
  // Connections one process may hold at once. Follows the deployment, not the
  // code (cf. ename-internals.md); the default is a local size.
  databasePoolSize: z.coerce.number().int().min(1).default(10),
});

const parsed = ConfigSchema.safeParse({
  port: process.env['PORT'],
  logLevel: process.env['LOG_LEVEL'],
  databaseURL: process.env['DATABASE_URL'],
  databasePoolSize: process.env['DATABASE_POOL_SIZE'],
});

if (!parsed.success) {
  console.error('Invalid configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
