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
 * The DSH engine bridge: a Cordis plugin that turns a mounted DSH composition
 * into the `libreDshEngine` contract.
 *
 * This is the only Libre WebUI module that names concrete `@deepseek-ai/dsh-*`
 * packages, and it does so for types alone. Everything it publishes is defined
 * in `cordis/contracts.ts`, so routes, the WebSocket bridge, and the frontend
 * client never learn that DSH exists.
 *
 * The plugin is mounted as a Loader row, which means Cordis owns it. Its
 * dependency injector, its `session/event` subscription, every agent handle it
 * creates, and the service it publishes all belong to that row's fiber.
 * Removing the row disposes the fiber, and all of it goes away together — that
 * single ownership edge is the rollback guarantee.
 *
 * @module cordis/dsh/engine-plugin
 */

import { randomUUID } from 'node:crypto';
import { Service, type Context } from '@deepseek-ai/cordis';
import type {
  DshEngine,
  EngineAgentSummary,
  EngineCreateSessionOptions,
  EngineMessage,
  EngineMessageRole,
  EngineServiceStatus,
  EngineSession,
  EngineSessionSummary,
  EngineStreamChunk,
  EngineStreamHandle,
  EngineToolSummary,
} from '../contracts.js';
import { DSH_ENGINE_SERVICE } from '../contracts.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('cordis-dsh-engine');

/** Plugin name reported to Cordis diagnostics. */
export const name = 'libre-webui-dsh-engine';

/**
 * Services this plugin waits for.
 *
 * Declaring them is what makes the bridge start only once the engine is
 * usable, and — just as importantly — refuse to start at all when the engine
 * is absent. A bridge that published itself against a missing engine would
 * turn a configuration mistake into silently empty session lists.
 */
export const inject = ['sessions', 'agents', 'tools', 'llm'] as const;

/** Configuration accepted by the bridge row. */
export interface Config {
  /** Absolute directory used as the default workspace for new sessions. */
  readonly workspacePath?: string;
  /** Whether `sendMessage` may start model work. */
  readonly streaming?: boolean;
  /** Provider route pinned on agents this bridge creates. */
  readonly defaultProvider?: string;
  /** Model pinned on agents this bridge creates. */
  readonly defaultModel?: string;
}

/** The subset of a DSH session this bridge reads. */
interface DshSessionLike {
  readonly id: string;
  readonly header?: { readonly createdAt?: number };
  readonly seq?: number;
  deriveMessages(): readonly unknown[];
}

/** The subset of a DSH agent this bridge reads. */
interface DshAgentLike {
  readonly id: string;
  followup?(input: { role: 'user'; content: unknown }): void;
  cancel?(cause: string): void;
}

/** The subset of a DSH agent handle this bridge reads. */
interface DshAgentHandleLike {
  readonly agent: DshAgentLike;
  dispose(): Promise<void>;
}

/** The subset of the DSH session store this bridge reads. */
interface DshSessionsLike {
  list(): readonly DshSessionLike[];
  get(id: string): DshSessionLike | undefined;
}

/** The subset of the DSH agent registry this bridge reads. */
interface DshAgentsLike {
  list(): readonly DshAgentLike[];
  roots(): readonly DshAgentLike[];
  create(options: {
    readonly sessionId: string;
    readonly meta?: { readonly cwd?: string };
    readonly agentOptions?: Record<string, unknown>;
  }): Promise<DshAgentHandleLike>;
}

/** The subset of the DSH tool runtime this bridge reads. */
interface DshToolsLike {
  schemas(scope?: unknown): readonly {
    readonly name?: string;
    readonly description?: string;
  }[];
}

/**
 * One in-flight response for a session.
 *
 * Chunks are buffered until a subscriber attaches, because the HTTP handler
 * must await this handle before it can write response headers — a model that
 * answers faster than the round trip would otherwise lose its opening tokens.
 */
class ResponseStream implements EngineStreamHandle {
  private readonly buffer: EngineStreamChunk[] = [];
  private readonly listeners = new Set<(chunk: EngineStreamChunk) => void>();
  private closed = false;

  constructor(readonly sessionId: string) {}

  /** Deliver a chunk to the buffer, or straight to attached listeners. */
  push(chunk: EngineStreamChunk): void {
    if (this.closed) return;
    if (this.listeners.size === 0) {
      this.buffer.push(chunk);
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(chunk);
      } catch (error) {
        // A misbehaving consumer must not abort the model stream for other
        // consumers, nor for the engine that is publishing it.
        logger.warn('stream listener threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Mark the response finished and release every listener. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
  }

  /** Whether the response has already terminated. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Chunks buffered but not yet delivered. */
  get pending(): number {
    return this.buffer.length;
  }

  subscribe(listener: (chunk: EngineStreamChunk) => void): {
    unsubscribe(): void;
  } {
    // Replay first, so a subscriber attaching after a fast model answer still
    // sees the complete response instead of an empty stream.
    for (const chunk of this.buffer) listener(chunk);
    this.buffer.length = 0;
    if (this.closed) return { unsubscribe: () => undefined };
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }
}

/** Extract readable text from one DSH message content value. */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block === null || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    // Content blocks are a union of text, image, and tool shapes. Only text is
    // projectable into a chat transcript; the rest is deliberately dropped
    // rather than stringified into something misleading.
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    }
  }
  return parts.join('');
}

/** Normalize a DSH message role into the contract's role vocabulary. */
export function normalizeRole(role: unknown): EngineMessageRole {
  if (
    role === 'user' ||
    role === 'assistant' ||
    role === 'system' ||
    role === 'tool'
  ) {
    return role;
  }
  return 'unknown';
}

/** Project one DSH message into the contract's message shape. */
export function projectMessage(raw: unknown, index: number): EngineMessage {
  if (raw === null || typeof raw !== 'object') {
    return { id: `message-${index}`, role: 'unknown', text: '' };
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : `message-${index}`;
  const seq = typeof record.seq === 'number' ? record.seq : undefined;
  return {
    id,
    role: normalizeRole(record.role),
    text: extractText(record.content),
    ...(seq === undefined ? {} : { seq }),
  };
}

/**
 * Map one DSH session event onto a contract stream chunk.
 *
 * A durable session event is an envelope: `type` and `seq` sit beside a `data`
 * object that carries the payload for that type. Reading the payload off the
 * envelope instead of `data` yields no chunk at all rather than an error, so
 * each branch unwraps `data` explicitly.
 * @param event - the session event envelope.
 * @returns the projected chunk, or undefined for an event the transcript omits.
 */
export function projectStreamEvent(
  event: Record<string, unknown>
): EngineStreamChunk | undefined {
  const type = event.type;
  const data =
    event.data !== null &&
    typeof event.data === 'object' &&
    !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : {};
  if (type === 'assistant/message') {
    const message = data.message;
    const text =
      message !== null && typeof message === 'object'
        ? extractText((message as Record<string, unknown>).content)
        : '';
    return text.length > 0 ? { type: 'text', text } : undefined;
  }
  if (type === 'tool/call') {
    return {
      type: 'tool-call',
      callId: typeof data.callId === 'string' ? data.callId : '',
      name: typeof data.name === 'string' ? data.name : '',
    };
  }
  if (type === 'tool/result') {
    return {
      type: 'tool-result',
      callId: typeof data.callId === 'string' ? data.callId : '',
      name: typeof data.name === 'string' ? data.name : '',
      isError: data.error !== undefined,
    };
  }
  if (type === 'turn/end') {
    return {
      type: 'done',
      reason: typeof data.reason === 'string' ? data.reason : 'unknown',
      ...(data.interrupted === true ? { interrupted: true } : {}),
    };
  }
  return undefined;
}

/**
 * Build the session-id minter for one engine instance.
 *
 * A shared counter is not enough. `dsh-session-persistence-jsonl` indexes live
 * sessions process-wide, so two engine instances in one process that both mint
 * `session-1` collide, and the second fails with `SessionAlreadyExistsError`
 * even though the two hosts use different store directories. Prefixing with a
 * per-instance random component keeps ids unique across every host in the
 * process while staying readable in a session list.
 *
 * @returns a function minting an id no other engine instance will produce.
 */
function createSessionIdMinter(): () => string {
  const prefix = randomUUID().slice(0, 8);
  let counter = 0;
  return () => {
    counter += 1;
    return `session-${prefix}-${counter}`;
  };
}

/** Read a session's event count without depending on a concrete class. */
function eventCountOf(session: DshSessionLike): number {
  return typeof session.seq === 'number' && Number.isFinite(session.seq)
    ? session.seq
    : 0;
}

/** Project a session into its summary shape. */
export function projectSummary(session: DshSessionLike): EngineSessionSummary {
  const createdAt = session.header?.createdAt;
  return {
    id: session.id,
    eventCount: eventCountOf(session),
    ...(typeof createdAt === 'number' ? { createdAt } : {}),
  };
}

/**
 * The engine contract, published as the `libreDshEngine` Cordis service.
 *
 * It is a `Service` rather than a plain object so that Cordis owns its
 * lifecycle: the name is declared once, `ctx.get('libreDshEngine')` resolves it
 * for every consumer, and removing the bridge row withdraws it automatically.
 */
export class LibreDshEngineService extends Service implements DshEngine {
  /** Contract name under which this service is registered. */
  static readonly provide = DSH_ENGINE_SERVICE;

  private readonly streams = new Map<string, ResponseStream>();
  private readonly handles = new Map<string, DshAgentHandleLike>();
  /**
   * Sessions created by the UI that no agent owns yet.
   *
   * They are deliberately absent from the DSH store until the first message,
   * because the agent that will own one must be the component that enters it.
   */
  private readonly pending = new Map<string, EngineSessionSummary>();
  /** Working directory requested for each not-yet-owned session. */
  private readonly pendingCwd = new Map<string, string>();
  private readonly workspacePath: string;
  private readonly allowStreaming: boolean;
  private readonly defaultProvider: string | undefined;
  private readonly defaultModel: string | undefined;
  /** Mints session ids unique across every engine in this process. */
  private readonly mintSessionId = createSessionIdMinter();

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, DSH_ENGINE_SERVICE);
    this.workspacePath = config.workspacePath ?? process.cwd();
    this.allowStreaming = config.streaming !== false;
    this.defaultProvider = config.defaultProvider;
    this.defaultModel = config.defaultModel;

    // `session/event` is declared by the DSH session package through a
    // `declare module '@deepseek-ai/cordis'` augmentation. This bridge
    // deliberately imports DSH for types only, so that augmentation is not in
    // scope and the event name is asserted here instead of pulling the whole
    // engine into the type graph.
    // `session/event` dispatches `(session, event)` — the session first. Every
    // cursor is keyed by session id, so swapping the two silently yields an
    // empty stream rather than an error.
    ctx.on(
      'session/event' as never,
      ((session: unknown, event: unknown) => {
        if (event === null || typeof event !== 'object') return;
        const sessionId = (session as DshSessionLike | undefined)?.id;
        if (typeof sessionId !== 'string') return;
        const stream = this.streams.get(sessionId);
        if (!stream || stream.isClosed) return;
        const projected = projectStreamEvent(event as Record<string, unknown>);
        if (!projected) return;
        stream.push(projected);
      }) as never
    );

    // Every in-flight response and agent handle is owned by this fiber.
    // Disposing the bridge row releases all of them, so removing the plugin
    // cannot leave a model stream or a live agent behind.
    ctx.effect(
      () => () => {
        for (const stream of this.streams.values()) stream.close();
        this.streams.clear();
        for (const [sessionId, handle] of this.handles) {
          void handle.dispose().catch((error: unknown) => {
            logger.warn('agent disposal during bridge teardown failed', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        this.handles.clear();
        this.pending.clear();
        this.pendingCwd.clear();
        logger.info('libreDshEngine service withdrawn');
      },
      'libre-webui-dsh-engine.teardown'
    );
  }

  /** The DSH session store this bridge reads through. */
  private get sessions(): DshSessionsLike {
    return this.ctx.get('sessions') as unknown as DshSessionsLike;
  }

  /** The DSH agent registry this bridge drives. */
  private get agents(): DshAgentsLike {
    return this.ctx.get('agents') as unknown as DshAgentsLike;
  }

  /** The DSH tool runtime this bridge reads through. */
  private get tools(): DshToolsLike {
    return this.ctx.get('tools') as unknown as DshToolsLike;
  }

  status(): readonly EngineServiceStatus[] {
    const names = [
      'llm',
      'systemPrompt',
      'sessions',
      'tools',
      'agents',
    ] as const;
    return names.map(serviceName => ({
      name: serviceName,
      state: this.ctx.get(serviceName) === undefined ? 'pending' : 'ready',
    }));
  }

  async listSessions(): Promise<readonly EngineSessionSummary[]> {
    // Pending sessions have no store entry yet, so they are projected
    // separately and merged; both sources are ordered newest first because
    // operators read this list top-down.
    const live = this.sessions.list().map(projectSummary);
    const pending = [...this.pending.values()];
    return [...live, ...pending].sort(
      (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0)
    );
  }

  async getSession(sessionId: string): Promise<EngineSession | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const pending = this.pending.get(sessionId);
      return pending ? { ...pending, messages: [] } : undefined;
    }
    return {
      ...projectSummary(session),
      messages: session.deriveMessages().map(projectMessage),
    };
  }

  async createSession(
    options: EngineCreateSessionOptions
  ): Promise<EngineSession> {
    const cwd = options.cwd || this.workspacePath;
    // The session is deliberately NOT entered into the DSH store yet. The agent
    // that will own it must be the component that enters it: the agent's
    // creation transaction calls `prepare` for this same id and fails with
    // "already exists" if the store already holds it. Deferring entry until the
    // first message is therefore what lets one session id flow from "created by
    // the UI" to "owned by a running agent" without a second identity.
    const summary: EngineSessionSummary = {
      id: this.mintSessionId(),
      eventCount: 0,
      createdAt: Date.now(),
      ...(options.title === undefined ? {} : { title: options.title }),
    };
    this.pending.set(summary.id, summary);
    // The agent that eventually owns this session is created later, on the
    // first message, so the caller's working directory has to be retained here
    // rather than read from the options at that point.
    this.pendingCwd.set(summary.id, cwd);
    return { ...summary, messages: [] };
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const stream = this.streams.get(sessionId);
    if (stream) {
      stream.close();
      this.streams.delete(sessionId);
    }
    // A session that never received a message exists only here.
    if (this.pending.delete(sessionId)) {
      this.pendingCwd.delete(sessionId);
      return true;
    }
    // A session an agent owns is scoped to that agent's fiber, and the session
    // store exposes no delete of its own. Disposing the handle is the supported
    // way to end it, so that is what deletion does for a live session.
    const handle = this.handles.get(sessionId);
    if (handle) {
      this.handles.delete(sessionId);
      await handle.dispose();
      return true;
    }
    return false;
  }

  async listAgents(): Promise<readonly EngineAgentSummary[]> {
    const roots = new Set(this.agents.roots().map(agent => agent.id));
    return this.agents
      .list()
      .map(agent => ({ id: agent.id, root: roots.has(agent.id) }));
  }

  async listTools(): Promise<readonly EngineToolSummary[]> {
    // No scope yields the deployment-wide registry; per-agent restrictions are
    // applied by the tool runtime at dispatch time, not at listing time.
    return this.tools
      .schemas()
      .filter(
        (schema): schema is { name: string; description?: string } =>
          typeof schema.name === 'string'
      )
      .map(schema => ({
        name: schema.name,
        description:
          typeof schema.description === 'string' ? schema.description : '',
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async sendMessage(
    sessionId: string,
    text: string,
    options?: { readonly cwd?: string }
  ): Promise<EngineStreamHandle> {
    if (!this.allowStreaming) {
      throw new Error(
        'cordis dsh engine: streaming is disabled by configuration'
      );
    }
    const existing = this.streams.get(sessionId);
    if (existing && !existing.isClosed) {
      throw new Error(
        `cordis dsh engine: session "${sessionId}" already has a response in flight`
      );
    }

    const stream = new ResponseStream(sessionId);
    this.streams.set(sessionId, stream);

    // The session must exist, either as a UI-created pending session or as one
    // an agent already owns. Creating it here would race the agent's own
    // creation transaction, which prepares the same id and fails when the store
    // already holds it.
    const pending = this.pending.get(sessionId);
    if (pending === undefined && this.sessions.get(sessionId) === undefined) {
      this.streams.delete(sessionId);
      stream.close();
      throw new Error(
        `cordis dsh engine: session "${sessionId}" does not exist; create it first`
      );
    }

    const cwd =
      options?.cwd ?? this.pendingCwd.get(sessionId) ?? this.workspacePath;
    let handle = this.handles.get(sessionId);
    if (!handle) {
      const agentOptions: Record<string, unknown> = {};
      if (this.defaultProvider) agentOptions.provider = this.defaultProvider;
      if (this.defaultModel) agentOptions.model = this.defaultModel;
      handle = await this.agents.create({
        sessionId,
        meta: { cwd },
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      });
      this.handles.set(sessionId, handle);
      // Ownership moved to the agent, which has now entered the real session
      // with the retained working directory.
      this.pending.delete(sessionId);
      this.pendingCwd.delete(sessionId);
    }

    const agent = handle.agent;
    if (typeof agent.followup !== 'function') {
      throw new Error(
        'cordis dsh engine: the mounted engine has no agent driver that accepts messages'
      );
    }
    // `followup` queues the message for the next turn and wakes the loop; it is
    // the documented path for a user turn that should start work.
    agent.followup({ role: 'user', content: [{ type: 'text', text }] });
    return stream;
  }

  async cancel(sessionId: string): Promise<boolean> {
    const handle = this.handles.get(sessionId);
    if (!handle) return false;
    const cancel = handle.agent.cancel;
    if (typeof cancel !== 'function') return false;
    cancel.call(handle.agent, 'user');
    return true;
  }
}

/**
 * Mount the bridge on a context that already provides the engine services.
 * @param ctx - context carrying `sessions`, `agents`, and `tools`.
 * @param config - bridge configuration from the composition row.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(LibreDshEngineService, config);
}
