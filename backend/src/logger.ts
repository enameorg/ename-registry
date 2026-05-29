import { pino } from 'pino';

import { config } from './config.ts';

// JSON output in every environment, including local dev — same format as
// production, so the first incident holds no surprises.
export const logger = pino({
  level: config.logLevel,
});
