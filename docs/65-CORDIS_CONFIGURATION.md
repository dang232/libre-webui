---
sidebar_position: 65
title: 'Cordis Configuration'
description: 'Configuration reference for the embedded Cordis/DSH engine: settings document, composition document, and environment variables.'
slug: /CORDIS_CONFIGURATION
keywords:
  [
    cordis configuration,
    cordis.patch.yml,
    cordis.config.yml,
    dsh engine config,
    model provider routes,
    libre cordis env,
  ]
---

# Cordis Configuration

The embedded Cordis/DSH engine is configured by two documents and a set of
environment variables. Both documents live next to the backend by default;
`LIBRE_CORDIS_CONFIG` and `LIBRE_CORDIS_SETTINGS` relocate them.

| Document            | Owner            | Shape                    | Purpose                                     |
| ------------------- | ---------------- | ------------------------ | ------------------------------------------- |
| `cordis.patch.yml`  | Cordis Loader    | Top-level YAML **array** | The plugin rows that mount the engine       |
| `cordis.config.yml` | Libre WebUI host | YAML **mapping**         | Provider, credentials source, feature flags |

Two documents rather than one because the Cordis `Include` tree carrier reads
the composition itself and rejects any file that is not a top-level array. Host
settings therefore cannot share that file.

Start from the shipped examples:

```bash
cd backend
cp cordis.patch.example.yml cordis.patch.yml
cp cordis.config.example.yml cordis.config.yml
# then set features.enabled: true in cordis.config.yml
```

The host reads `cordis.patch.yml`, merges its own defaults into the bridge row,
and writes the result to `<DATA_DIR>/cordis-runtime/cordis.composed.yml`. That
generated file is disposable and must not be edited: the authoritative document
is the operator's `cordis.patch.yml`.

## `cordis.config.yml`

```yaml
trace: false

model:
  provider: pi-ai
  apiKeyEnv: OPENAI_API_KEY
  route: ollama
  model: ''
  baseUrl: ''
  providers:
    ollama:
      displayName: Ollama (local)
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      apiKeyEnv: OLLAMA_API_KEY
      models:
        - id: llama3.2
          contextWindow: 131072
          maxTokens: 4096

features:
  enabled: false
  streaming: true
  tools: true
  persistence: true
```

### Top-level keys

| Key        | Type    | Default | Meaning                                |
| ---------- | ------- | ------- | -------------------------------------- |
| `trace`    | boolean | `false` | Log every Cordis activation transition |
| `model`    | mapping | –       | Model adapter selection; see below     |
| `features` | mapping | –       | Capability switches; see below         |

### `features`

| Key           | Type    | Default | Meaning                                                     |
| ------------- | ------- | ------- | ----------------------------------------------------------- |
| `enabled`     | boolean | `false` | Mount the engine. While false every route returns `503`.    |
| `streaming`   | boolean | `true`  | Accept turns that stream model output                       |
| `tools`       | boolean | `true`  | Expose the engine's tool registry                           |
| `persistence` | boolean | `true`  | Require a session-persistence row; sessions survive restart |

`features.enabled` is the only switch that must be set to turn the bridge on. A
top-level `enabled` key is not read; keeping every capability switch inside
`features` means there is one place to look for what is turned on.

### `model`

| Key         | Type    | Default             | Meaning                                                 |
| ----------- | ------- | ------------------- | ------------------------------------------------------- |
| `provider`  | string  | `pi-ai`             | `deepseek`, `pi-ai`, or `none`                          |
| `apiKeyEnv` | string  | `OPENAI_API_KEY`    | **Name** of the environment variable holding the key    |
| `route`     | string  | `openai-compatible` | Provider route the engine names in requests             |
| `model`     | string  | `''`                | Default model id; empty lets the adapter choose         |
| `baseUrl`   | string  | `''`                | Endpoint override; empty uses the adapter's own default |
| `providers` | mapping | `{}`                | Hand-declared provider routes, keyed by route name      |

`provider` selects which adapter package is mounted:

- `deepseek` mounts `@deepseek-ai/dsh-llm-deepseek`, the first-party adapter.
- `pi-ai` mounts `@deepseek-ai/dsh-llm-pi-ai`, a generic adapter. A route key
  that names a provider pi-ai ships inherits that provider's endpoint, protocol,
  and model catalog; any other key is a complete declaration. This is what
  covers Ollama and OpenAI-compatible gateways.
- `none` mounts no adapter. The engine starts and lists tools but cannot answer
  a message. This is useful for exercising the composition without a provider.

A provider route is described by:

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `displayName` | Human-readable name                                                     |
| `api`         | Wire protocol, e.g. `openai-completions`                                |
| `baseURL`     | Endpoint base                                                           |
| `apiKeyEnv`   | Environment variable holding the key                                    |
| `models`      | Model list; each entry takes `id`, `name`, `contextWindow`, `maxTokens` |

**Credentials are never written into either document.** `apiKeyEnv` names an
environment variable, and the adapter resolves it per request, so rotating a key
needs no restart.

## `cordis.patch.yml`

A top-level array of Cordis loader entries. The shipped example mounts nine
rows and is the recommended starting point.

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm'

- id: session
  name: '@deepseek-ai/dsh-session'

- id: session-projection
  name: '@deepseek-ai/dsh-session-projection'

- id: session-persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.LIBRE_CORDIS_SESSION_STORE ?? 'cordis-sessions'

- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    personaPrefix: ''

- id: tools
  name: '@deepseek-ai/dsh-tools'

- id: agent
  name: '@deepseek-ai/dsh-agent'

- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents: []

- id: libre-webui-bridge
  name: './dist/cordis/dsh/engine-plugin.js'
```

### Entry fields

| Field      | Required | Meaning                                                          |
| ---------- | -------- | ---------------------------------------------------------------- |
| `id`       | no       | Stable id used to target the row. Derived from `name` if omitted |
| `name`     | **yes**  | Module specifier the loader imports. Must be a literal string    |
| `config`   | no       | Config for the plugin; `!!js` expressions allowed                |
| `disabled` | no       | Skip the row without deleting it; `!!js` allowed                 |
| `inject`   | no       | Extra required services or intercept config for the row          |

`name` is imported directly by the loader and is never evaluated, so it cannot
be a `!!js` expression. `config` values can use `!!js`; those expressions are
evaluated later, in the owning row's fiber, with the loader context in scope —
`process.env` and `ctx.get(...)` work, `import.meta` does not.

Relative specifiers resolve against the **composition file's own directory**.
Bare specifiers resolve through the backend package, so
`@deepseek-ai/dsh-tools` finds the copy in `backend/node_modules`.

Row order carries no load semantics. Cordis activates a row once the services it
declares are available, so the grouping above is for readers only.

### Required rows

An engine that answers chat needs all of:

| Row                      | Provides             | Needed by          |
| ------------------------ | -------------------- | ------------------ |
| `dsh-llm`                | `llm`                | agent loop         |
| `dsh-session`            | `sessions`           | agent loop, bridge |
| `dsh-session-projection` | `sessionProjections` | agent loop         |
| `dsh-system-prompt`      | `systemPrompt`       | tools, agent loop  |
| `dsh-tools`              | `tools`              | agent loop, bridge |
| `dsh-agent`              | `agents`             | bridge             |
| `dsh-agent-loop`         | agent driver         | answers turns      |
| the bridge row           | `libreDshEngine`     | every route        |

Mounting a tool plugin row as well (for example `@deepseek-ai/dsh-fs-sandbox`
plus `@deepseek-ai/dsh-tool-fs`) is what makes `GET /api/cordis/tools` return
anything; a tool registry with no tool plugins is legitimately empty.

## Environment variables

Every settings value has an environment override. The variable wins over the
document, which wins over the built-in default.

| Variable                      | Overrides                   | Default                         |
| ----------------------------- | --------------------------- | ------------------------------- |
| `LIBRE_CORDIS_ENABLED`        | `features.enabled`          | `false`                         |
| `LIBRE_CORDIS_STREAMING`      | `features.streaming`        | `true`                          |
| `LIBRE_CORDIS_TOOLS`          | `features.tools`            | `true`                          |
| `LIBRE_CORDIS_PERSISTENCE`    | `features.persistence`      | `true`                          |
| `LIBRE_CORDIS_TRACE`          | `trace`                     | `false`                         |
| `LIBRE_CORDIS_MODEL_PROVIDER` | `model.provider`            | `pi-ai`                         |
| `LIBRE_CORDIS_MODEL_ROUTE`    | `model.route`               | `openai-compatible`             |
| `LIBRE_CORDIS_MODEL`          | `model.model`               | `''`                            |
| `LIBRE_CORDIS_API_KEY_ENV`    | `model.apiKeyEnv`           | `OPENAI_API_KEY`                |
| `LIBRE_CORDIS_BASE_URL`       | `model.baseUrl`             | `''`                            |
| `LIBRE_CORDIS_CONFIG`         | Composition document path   | `<cwd>/cordis.patch.yml`        |
| `LIBRE_CORDIS_SETTINGS`       | Settings document path      | beside the composition document |
| `LIBRE_CORDIS_WORKSPACE`      | Engine default workspace    | `<DATA_DIR>/cordis-workspace`   |
| `LIBRE_CORDIS_SESSION_STORE`  | Persisted session directory | `<DATA_DIR>/cordis-sessions`    |

Boolean variables accept `1/true/yes/on` and `0/false/no/off`. An unreadable
value falls back to the document rather than guessing.

`LIBRE_CORDIS_SESSION_STORE` and `LIBRE_CORDIS_WORKSPACE` are also read by the
shipped composition's `!!js` expressions, which is why the host exports them
before the tree is mounted.

## Worked examples

### Local Ollama, fully offline

```yaml
features:
  enabled: true
model:
  provider: pi-ai
  route: ollama
  model: llama3.2
  apiKeyEnv: OLLAMA_API_KEY
  providers:
    ollama:
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      apiKeyEnv: OLLAMA_API_KEY
      models:
        - id: llama3.2
          contextWindow: 131072
          maxTokens: 4096
```

Ollama ignores the key, but the OpenAI client requires one to be set. Export
`OLLAMA_API_KEY=ollama` to satisfy it without inventing a secret. Nothing leaves
the machine.

### An OpenAI-compatible gateway

```yaml
features:
  enabled: true
model:
  provider: pi-ai
  route: gateway
  model: acme-large
  apiKeyEnv: ACME_GATEWAY_API_KEY
  providers:
    gateway:
      displayName: Acme Gateway
      api: openai-completions
      baseURL: https://gateway.acme.example/v1
      apiKeyEnv: ACME_GATEWAY_API_KEY
      models:
        - id: acme-large
          contextWindow: 65536
          maxTokens: 4096
```

### First-party DeepSeek

```yaml
features:
  enabled: true
model:
  provider: deepseek
  route: deepseek
  apiKeyEnv: DEEPSEEK_API_KEY
```

Set `DEEPSEEK_API_KEY` in the backend's environment.

### No provider, tools only

```yaml
features:
  enabled: true
model:
  provider: none
```

The engine starts, sessions can be created, and
`GET /api/cordis/tools` lists the configured tool plugins. Sending a message
fails, because no adapter can serve the request.

## Migration notes

The Cordis bridge is additive. No existing behavior changes when it is off, and
it is off by default.

**Upgrading an existing deployment.** Nothing is required. The two example
documents ship as `cordis.patch.example.yml` and `cordis.config.example.yml`, so
neither is picked up until you copy it and enable the feature. No migration
runs, no table is created, and no existing data directory is touched.

**Enabling it for the first time.** Copy both example documents, set
`features.enabled: true`, and install nothing further: the engine packages are
already dependencies of the backend. On first request the engine creates
`<DATA_DIR>/cordis-workspace`, `<DATA_DIR>/cordis-sessions`, and
`<DATA_DIR>/cordis-runtime`. All three are new directories under the existing
data directory, so an existing backup or restore that covers that directory
covers them too.

**Upgrading the engine.** The engine packages are pinned to an exact alpha
version in `backend/package.json`. Upgrading means changing that pin and running
`npm install`. If a DSH package gains a peer dependency, npm reports it at
install time rather than at mount time. Model and session formats are owned by
DSH; a format change is a DSH release note, not a Libre WebUI migration.

**Rolling back.** Set `features.enabled: false` and restart, or remove the
bridge row from `cordis.patch.yml`. The `libreDshEngine` service is withdrawn,
its listener released, and the agents it created are disposed. Session files
stay on disk as data; delete the `sessionStorePath` directory to reclaim the
space. Uninstalling the packages is optional and does not affect any other
Libre WebUI feature.

**Enabling it on an existing chat deployment.** The bridge does not participate
in Libre WebUI's chat, provider, or tool-approval plumbing. It is a second,
separate engine with its own sessions and its own `/api/cordis` surface, so
enabling it does not alter how existing chats resolve providers or how existing
tools are approved.

## Known limitations

These are the current boundaries, not a roadmap.

- **Tool execution is not mediated by Libre WebUI's approval flow.** The engine
  runs its own tools. Approvals, allow/deny policy, and audit records from
  Libre WebUI's tool gateway do not apply to them. Treat the engine's workspace
  as the security boundary.
- **One engine per process.** The runtime owns a single host. Running two
  compositions in one process is not supported.
- **Streaming is per turn, not per token.** Chunks are projected from durable
  session events, so a client receives a turn's assistant text when the turn
  records it. The stream is not a token-by-token feed.
- **`deleteSession` cannot remove an already-persisted session.** The DSH session
  store exposes no delete, and a session entered by an agent is scoped to that
  agent's fiber. Deleting disposes the agent, which ends the session; the
  persisted file remains on disk.
- **No session titles.** The contract carries an optional `title`, and the engine
  does not currently supply one.
- **Provider credentials resolve per request from an environment variable.** A
  key cannot be supplied through the UI, and it is re-read on each request, so
  rotating it needs no restart but also means a revoked variable takes effect
  immediately.
- **The engine's own system prompt and runtime context are included verbatim.**
  A turn's transcript begins with the engine's system prompt, which is visible
  to anyone who reads the session.
- **The alpha pin.** The engine packages are published under npm's `alpha`
  dist-tag. Upgrading is a deliberate version change rather than an automatic
  range bump.
- **No engine page in the UI yet.** The `/api/cordis` surface is complete and
  covered by tests, and `frontend/src/utils/api/cordisApi.ts` is the typed
  browser client for it, but no Libre WebUI page renders sessions or chat for
  the engine. The client and the HTTP contract are the integration point.

## Verifying a configuration

```bash
curl -s http://127.0.0.1:3001/api/cordis/health | jq
```

```json
{
  "success": true,
  "enabled": true,
  "ready": true,
  "services": [
    { "name": "llm", "state": "ready" },
    { "name": "systemPrompt", "state": "ready" },
    { "name": "sessions", "state": "ready" },
    { "name": "tools", "state": "ready" },
    { "name": "agents", "state": "ready" }
  ]
}
```

A `503` with `code: CORDIS_UNAVAILABLE` means the composition did not mount.
The `error` field carries the reason, and `LIBRE_CORDIS_TRACE=true` adds the
Cordis activation log. See [Troubleshooting](./06-TROUBLESHOOTING.md) for the
common causes.
