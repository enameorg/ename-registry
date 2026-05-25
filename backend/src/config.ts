import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  databaseUrl: z.url(),
});

// Pick the right database URL for the current NODE_ENV. The two are kept as
// separate env vars (rather than one) so that a test runner that forgets to set
// NODE_ENV=test fails loudly on missing TEST_DATABASE_URL instead of corrupting
// dev data.
const rawNodeEnv = process.env['NODE_ENV'] ?? 'development';
const rawDatabaseUrl =
  rawNodeEnv === 'test' ? process.env['TEST_DATABASE_URL'] : process.env['DATABASE_URL'];

const parsed = ConfigSchema.safeParse({
  port: process.env['PORT'],
  nodeEnv: rawNodeEnv,
  logLevel: process.env['LOG_LEVEL'],
  databaseUrl: rawDatabaseUrl,
});

if (!parsed.success) {
  console.error('Invalid configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
