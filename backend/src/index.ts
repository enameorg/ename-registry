import { OpenAPIHono } from '@hono/zod-openapi';

import { api } from './api/index.ts';

export const app = new OpenAPIHono();

app.route('/api/v1', api);
