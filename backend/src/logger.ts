import { pino } from 'pino';

import { config } from './config.ts';

// Plain JSON output in all environments — including local dev. No pretty transport
// by default: forces familiarity with the production log format from day one and
// avoids surprises during the first incident.
export const logger = pino({
  level: config.logLevel,
});
