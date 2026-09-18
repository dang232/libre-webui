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
 * Browser client for the embedded Cordis/DSH engine.
 *
 * This module talks to `/api/cordis` and nothing else. It deliberately does not
 * import a backend type or a `@deepseek-ai/*` package: the engine is reachable
 * only through the HTTP contract, which is what keeps the engine swappable
 * without a frontend change.
 *
 * The shapes below mirror `backend/src/cordis/contracts.ts`. They are
 * restated rather than imported because the frontend and backend are separate
 * TypeScript projects with separate build outputs; an import would couple the
 * browser bundle to backend source.
 *
 * @module utils/api/cordisApi
 */

import type { ApiResponse } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { API_BASE_URL } from '@/utils/config';
import api from './client';

/** Lifecycle state of one engine service, mirroring Cordis fibre states. */
export type CordisServiceState = 'pending' | 'ready' | 'failed';

/** One engine service as observed through the contract. */
export interface CordisServiceStatus {
  name: string;
  state: CordisServiceState;
  detail?: string;
}

/** Summary of one engine session. */
export interface CordisSessionSummary {
  id: string;
  title?: string;
  createdAt?: number;
  eventCount: number;
}

/** Role of one projected message. */
export type CordisMessageRole =
  'user' | 'assistant' | 'system' | 'tool' | 'unknown';

/** One message projected from an engine session log. */
export interface CordisMessage {
  id: string;
  role: CordisMessageRole;
  text: string;
  seq?: number;
}

/** A session with its projected messages. */
export interface CordisSession extends CordisSessionSummary {
  messages: CordisMessage[];
}

/** One live agent. */
export interface CordisAgent {
  id: string;
  root: boolean;
}

/** One tool the engine can expose to a model. */
export interface CordisTool {
  name: string;
  description: string;
}

/** One increment of a streaming agent response. */
export type CordisStreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; callId: string; name: string }
  | { type: 'tool-result'; callId: string; name: string; isError: boolean }
  | { type: 'done'; reason: string; interrupted?: boolean };

/** Engine health, including why the bridge cannot serve requests. */
export interface CordisHealth {
  enabled: boolean;
  ready: boolean;
  services?: CordisServiceStatus[];
  /** Machine-readable reason when the bridge is unavailable. */
  code?: 'CORDIS_DISABLED' | 'CORDIS_STARTING' | 'CORDIS_UNAVAILABLE';
  error?: string;
}

/** Options accepted when sending a chat turn. */
export interface SendCordisMessageOptions {
  /** Called for every streamed chunk, in order. */
  onChunk?: (chunk: CordisStreamChunk) => void;
  /** Abort the request; the turn stays durable on the server. */
  signal?: AbortSignal;
}

const authHeader = (): Record<string, string> => {
  const token = localStorage.getItem('auth-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const cordisApi = {
  /**
   * Read bridge health.
   *
   * This route is unauthenticated by design, so the call succeeds even when no
   * session exists — which is what lets a settings page show "disabled" rather
   * than an error.
   */
  getHealth: async (): Promise<CordisHealth> => {
    const response = await api.get<CordisHealth>('/cordis/health');
    return response.data;
  },

  /** List engine sessions, newest first. */
  listSessions: async (): Promise<CordisSessionSummary[]> => {
    if (isDemoMode()) return [];
    const response = await api.get<{ sessions: CordisSessionSummary[] }>(
      '/cordis/sessions'
    );
    return response.data.sessions ?? [];
  },

  /** Read one session with its projected messages. */
  getSession: async (sessionId: string): Promise<CordisSession> => {
    const response = await api.get<{ session: CordisSession }>(
      `/cordis/sessions/${encodeURIComponent(sessionId)}`
    );
    return response.data.session;
  },

  /** Create a session. The id is reserved until the first message. */
  createSession: async (
    options: {
      cwd?: string;
      title?: string;
    } = {}
  ): Promise<CordisSession> => {
    const response = await api.post<{ session: CordisSession }>(
      '/cordis/sessions',
      options
    );
    return response.data.session;
  },

  /** Delete a session and dispose any agent bound to it. */
  deleteSession: async (sessionId: string): Promise<boolean> => {
    const response = await api.delete<ApiResponse>(
      `/cordis/sessions/${encodeURIComponent(sessionId)}`
    );
    return response.data.success;
  },

  /** List live agents. */
  listAgents: async (): Promise<CordisAgent[]> => {
    if (isDemoMode()) return [];
    const response = await api.get<{ agents: CordisAgent[] }>('/cordis/agents');
    return response.data.agents ?? [];
  },

  /** List the tools the engine registered. */
  listTools: async (): Promise<CordisTool[]> => {
    if (isDemoMode()) return [];
    const response = await api.get<{ tools: CordisTool[] }>('/cordis/tools');
    return response.data.tools ?? [];
  },

  /** Cancel the in-flight turn for a session. */
  cancel: async (sessionId: string): Promise<boolean> => {
    const response = await api.post<ApiResponse>(
      `/cordis/sessions/${encodeURIComponent(sessionId)}/cancel`
    );
    return response.data.success;
  },

  /**
   * Send a chat turn and stream the response.
   *
   * The response is newline-delimited JSON: one `CordisStreamChunk` per line,
   * ending with a `done` chunk. `fetch` is used directly rather than the shared
   * client because the shared client buffers whole responses, and buffering
   * would defeat the point of a stream.
   *
   * @param sessionId - the session the turn belongs to.
   * @param text - the user's message.
   * @param options - chunk callback and abort signal.
   * @returns every chunk in order, after the stream closes.
   */
  sendMessage: async (
    sessionId: string,
    text: string,
    options: SendCordisMessageOptions = {}
  ): Promise<CordisStreamChunk[]> => {
    if (isDemoMode()) {
      const chunks: CordisStreamChunk[] = [
        { type: 'text', text: 'Demo mode has no engine attached.' },
        { type: 'done', reason: 'demo' },
      ];
      chunks.forEach(chunk => options.onChunk?.(chunk));
      return chunks;
    }

    const response = await fetch(
      `${API_BASE_URL}/cordis/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ text }),
        signal: options.signal,
      }
    );

    if (!response.ok) {
      // The route reports caller errors (unknown session, turn already in
      // flight, streaming disabled) as JSON, so surface that message rather
      // than a bare status.
      const detail = await response
        .json()
        .then((body: { error?: string }) => body.error)
        .catch(() => undefined);
      throw new Error(detail ?? `HTTP error! status: ${response.status}`);
    }
    if (!response.body) throw new Error('No response body reader available');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: CordisStreamChunk[] = [];
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // A chunk can be split across reads, so only complete lines are parsed
      // and the remainder stays buffered until its newline arrives.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        const chunk = JSON.parse(line) as CordisStreamChunk;
        chunks.push(chunk);
        options.onChunk?.(chunk);
      }
    }

    // A final line without a trailing newline still carries a chunk.
    if (buffer.trim() !== '') {
      const chunk = JSON.parse(buffer) as CordisStreamChunk;
      chunks.push(chunk);
      options.onChunk?.(chunk);
    }
    return chunks;
  },
};

export default cordisApi;
