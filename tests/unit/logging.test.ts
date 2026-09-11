import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { ActorType } from '@prisma/client';
import { requestLogger, type Logger } from '../../src/http/logger.js';
import { requestContext } from '../../src/http/security.js';
import { withServer } from '../helpers/http.js';

test('structured request logging includes safe request and actor fields', async () => {
  const entries: Record<string, unknown>[] = [];
  const logger: Logger = { log(entry) { entries.push(entry); } };
  const app = express();
  app.use(requestContext);
  app.use((req, _res, next) => {
    req.actor = { type: ActorType.ADMIN, email: 'admin@example.com' };
    next();
  });
  app.use(requestLogger(logger));
  app.get('/logged', (_req, res) => res.status(200).json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/logged`, {
      headers: { authorization: 'Bearer must-not-be-logged', cookie: 'secret=value' },
    });
    assert.equal(response.status, 200);
  });

  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.level, 'info');
  assert.equal(entry.method, 'GET');
  assert.equal(entry.statusCode, 200);
  assert.equal(entry.actorType, ActorType.ADMIN);
  assert.equal(entry.actorEmail, 'admin@example.com');
  assert.equal(typeof entry.requestId, 'string');
  assert.equal(typeof entry.durationMs, 'number');
  assert.equal('authorization' in entry, false);
  assert.equal('cookie' in entry, false);
});
