import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = ConfigSchema.safeParse({
  port: process.env['PORT'],
  nodeEnv: process.env['NODE_ENV'],
  logLevel: process.env['LOG_LEVEL'],
});

if (!parsed.success) {
  console.error('Invalid configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
