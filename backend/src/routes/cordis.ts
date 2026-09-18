/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * HTTP surface for the embedded Cordis/DSH engine.
 *
 * Everything here consumes the `libreDshEngine` contract only; no handler knows
 * that DSH exists. That is what allows the whole engine to be swapped or
 * removed through the composition document without touching a route.
 *
 * Authentication is not optional: the engine can run tools with real
 * filesystem access, so an unauthenticated endpoint would be a remote code
 * execution surface. Every route requires an authenticated session.
 *
 * @module routes/cordis
 */

import express from 'express';

import { authenticate } from '../middleware/auth.js';
import { getCordisEngine, isCordisBridgeEnabled } from '../cordis/runtime.js';
const router = express.Router();

/** Status code and payload for a bridge that cannot serve a request. */
function unavailable(
  status: 'disabled' | 'starting' | 'failed',
  detail?: string
) {
  if (status === 'disabled') {
    return {
      status: 503,
      body: {
        success: false,
        error: 'The Cordis bridge is not enabled.',
        code: 'CORDIS_DISABLED',
      },
    };
  }
  if (status === 'starting') {
    return {
      status: 503,
      body: {
        success: false,
        error: 'The Cordis bridge is still starting.',
        code: 'CORDIS_STARTING',
      },
    };
  }
  return {
    status: 503,
    body: {
      success: false,
      error: detail ?? 'The Cordis bridge failed to start.',
      code: 'CORDIS_UNAVAILABLE',
    },
  };
}

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Health is reachable without a session so an operator can tell "disabled"
// from "broken" before they have credentials to hand.
router.get('/health', async (_req, res) => {
  if (!isCordisBridgeEnabled()) {
    res.json({ success: true, enabled: false, ready: false });
    return;
  }
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json({ enabled: true, ready: false, ...body });
    return;
  }
  res.json({
    success: true,
    enabled: true,
    ready: true,
    services: result.engine.status(),
  });
});

router.use(authenticate);

router.get('/sessions', async (_req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  res.json({ success: true, sessions: await result.engine.listSessions() });
});

router.post('/sessions', async (req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  const cwd =
    typeof req.body?.cwd === 'string' && req.body.cwd.trim() !== ''
      ? req.body.cwd
      : undefined;
  const title =
    typeof req.body?.title === 'string' && req.body.title.trim() !== ''
      ? req.body.title
      : undefined;
  try {
    // The engine resolves an omitted cwd to its configured workspace, so the
    // route never invents one.
    const session = await result.engine.createSession({
      cwd: cwd ?? '',
      ...(title === undefined ? {} : { title }),
    });
    res.status(201).json({ success: true, session });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/sessions/:id', async (req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  const session = await result.engine.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }
  res.json({ success: true, session });
});

router.delete('/sessions/:id', async (req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  const deleted = await result.engine.deleteSession(req.params.id);
  res.status(deleted ? 200 : 404).json({ success: deleted });
});

router.get('/agents', async (_req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  res.json({ success: true, agents: await result.engine.listAgents() });
});

router.get('/tools', async (_req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  res.json({ success: true, tools: await result.engine.listTools() });
});

/**
 * Send a chat message and stream the agent response as newline-delimited JSON.
 *
 * NDJSON is chosen over WebSocket deliberately: an agent turn is a single
 * server-to-client sequence with no client-to-server frames after the request,
 * so a streaming POST keeps the whole turn inside one authenticated request and
 * needs no separate handshake, ticket, or reconnect protocol.
 */
router.post('/sessions/:id/messages', async (req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (text.trim() === '') {
    res
      .status(400)
      .json({ success: false, error: 'A message text is required.' });
    return;
  }

  let stream;
  try {
    stream = await result.engine.sendMessage(req.params.id, text);
  } catch (error) {
    // A failure here is caller-visible (unknown session, a turn already in
    // flight, streaming disabled), so it is a request error rather than a
    // bridge outage.
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  // The response must not be buffered by an intermediary: the point of the
  // endpoint is that chunks reach the client as the model produces them.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  let subscription: { unsubscribe(): void } | undefined;

  const finish = () => {
    if (closed) return;
    closed = true;
    subscription?.unsubscribe();
    res.end();
  };

  // Subscribing replays whatever the model already produced, so a fast first
  // token cannot be lost between the engine starting the turn and this handler
  // attaching its listener.
  subscription = stream.subscribe(chunk => {
    if (closed) return;
    res.write(`${JSON.stringify(chunk)}\n`);
    // `done` is the terminal chunk of one turn, so the response ends here
    // rather than waiting for the client to close it.
    if (chunk.type === 'done') finish();
  });

  // A client that disconnects mid-turn releases the subscription; the engine
  // keeps the turn durable, so the transcript is still readable afterwards.
  res.on('close', () => {
    if (closed) return;
    closed = true;
    subscription?.unsubscribe();
  });
});

router.post('/sessions/:id/cancel', async (req, res) => {
  const result = await getCordisEngine();
  if (!result.ok) {
    const { status, body } = unavailable(result.reason, result.detail);
    res.status(status).json(body);
    return;
  }
  res.json({ success: await result.engine.cancel(req.params.id) });
});

export default router;
