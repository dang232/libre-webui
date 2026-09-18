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
 * Transport- and implementation-neutral contracts for the embedded DSH engine.
 *
 * Everything Libre WebUI consumes from the DSH engine crosses this file. The
 * route layer, the WebSocket bridge, and the frontend client all program
 * against these shapes, and the `dsh-engine` Cordis plugin is what satisfies
 * them. No Libre WebUI module outside `src/cordis/dsh/` may import a concrete
 * `@deepseek-ai/dsh-*` package: that restriction is what makes the engine
 * hot-swappable and what keeps the Cordis bridge a genuine seam rather than a
 * direct dependency in disguise.
 *
 * @module cordis/contracts
 */

/** Stable Cordis service name under which the engine contract is published. */
export const DSH_ENGINE_SERVICE = 'libreDshEngine' as const;

/** Lifecycle phase of one engine service, mirroring Cordis fiber states. */
export type EngineServiceState =
  /** The providing plugin has not been mounted yet. */
  | 'pending'
  /** The providing plugin is mounted and the service is usable. */
  | 'ready'
  /** The providing plugin is mounted but cannot serve requests. */
  | 'failed';

/** One engine service as observed through the contract. */
export interface EngineServiceStatus {
  /** Service name as registered on the Cordis context. */
  readonly name: string;
  /** Current lifecycle phase. */
  readonly state: EngineServiceState;
  /** Human-readable reason, present only when `state` is `failed`. */
  readonly detail?: string;
}

/** Role of one message projected from an engine session log. */
export type EngineMessageRole =
  'user' | 'assistant' | 'system' | 'tool' | 'unknown';

/** One message projected from an engine session log. */
export interface EngineMessage {
  /** Engine-assigned identifier, stable within a session. */
  readonly id: string;
  /** Projected author role. */
  readonly role: EngineMessageRole;
  /** Flattened text content; empty when the message carried none. */
  readonly text: string;
  /** Engine sequence number of the originating event, when known. */
  readonly seq?: number;
}

/** Summary of one engine session. */
export interface EngineSessionSummary {
  /** Opaque session identifier used by every other session operation. */
  readonly id: string;
  /** Engine-supplied title, absent until one is generated. */
  readonly title?: string;
  /** Epoch milliseconds when the session was created, when known. */
  readonly createdAt?: number;
  /** Number of events currently recorded for the session. */
  readonly eventCount: number;
}

/** A live or restored engine session. */
export interface EngineSession extends EngineSessionSummary {
  /** Messages projected from the session log, oldest first. */
  readonly messages: readonly EngineMessage[];
}

/** Identifies one live agent. */
export interface EngineAgentSummary {
  /** Agent identifier, equal to its backing session id. */
  readonly id: string;
  /** Whether this agent is a runtime root rather than a child of another. */
  readonly root: boolean;
}

/** One tool the engine can expose to a model. */
export interface EngineToolSummary {
  /** Model-facing tool name. */
  readonly name: string;
  /** Model-facing description, empty when the tool declared none. */
  readonly description: string;
}

/** Options accepted when creating an engine session. */
export interface EngineCreateSessionOptions {
  /** Absolute working directory recorded in the session header. */
  readonly cwd: string;
  /** Optional author-supplied title. */
  readonly title?: string;
}

/** Options accepted when creating an agent bound to a session. */
export interface EngineCreateAgentOptions {
  /** Session the agent should operate on. */
  readonly sessionId: string;
  /** Absolute working directory recorded in the session header. */
  readonly cwd: string;
  /** Provider route name, when the caller wants to pin one. */
  readonly provider?: string;
  /** Model identifier, when the caller wants to pin one. */
  readonly model?: string;
}

/** One increment of a streaming agent response. */
export type EngineStreamChunk =
  /** Incremental assistant text. */
  | { readonly type: 'text'; readonly text: string }
  /** A tool call the agent started. */
  | {
      readonly type: 'tool-call';
      readonly callId: string;
      readonly name: string;
    }
  /** A tool call that finished, successfully or not. */
  | {
      readonly type: 'tool-result';
      readonly callId: string;
      readonly name: string;
      readonly isError: boolean;
    }
  /** A turn boundary; the terminal chunk of one response. */
  | {
      readonly type: 'done';
      readonly reason: string;
      readonly interrupted?: boolean;
    };

/** Subscription handle returned by {@link EngineStreamHandle}. */
export interface EngineStreamSubscription {
  /** Stop receiving chunks. Safe to call more than once. */
  unsubscribe(): void;
}

/** Handle over one in-flight streaming response. */
export interface EngineStreamHandle {
  /** Session the response belongs to. */
  readonly sessionId: string;
  /** Register a chunk listener; replays nothing already emitted. */
  subscribe(
    listener: (chunk: EngineStreamChunk) => void
  ): EngineStreamSubscription;
}

/**
 * The engine contract published as the `libreDshEngine` Cordis service.
 *
 * Every method rejects rather than returning a partial result when the engine
 * is not ready, so callers never mistake an unmounted engine for an empty one.
 */
export interface DshEngine {
  /** Report the lifecycle state of each engine service. */
  status(): readonly EngineServiceStatus[];

  /** List live and restored sessions, newest first. */
  listSessions(): Promise<readonly EngineSessionSummary[]>;

  /** Read one session with its projected messages. */
  getSession(sessionId: string): Promise<EngineSession | undefined>;

  /** Create a session. */
  createSession(options: EngineCreateSessionOptions): Promise<EngineSession>;

  /** Delete a session and dispose any agent still bound to it. */
  deleteSession(sessionId: string): Promise<boolean>;

  /** List live agents. */
  listAgents(): Promise<readonly EngineAgentSummary[]>;

  /** List tools currently registered with the engine. */
  listTools(): Promise<readonly EngineToolSummary[]>;

  /**
   * Send a user message to a session and stream the agent response.
   *
   * The returned handle is usable immediately: chunks emitted before the first
   * subscriber attaches are buffered and replayed to that subscriber, so a
   * caller can await the HTTP response and then attach without losing text.
   */
  sendMessage(
    sessionId: string,
    text: string,
    options?: { readonly cwd?: string }
  ): Promise<EngineStreamHandle>;

  /** Cancel the in-flight response for a session, if any. */
  cancel(sessionId: string): Promise<boolean>;
}
