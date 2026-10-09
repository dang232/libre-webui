---
sidebar_position: 2
title: 'Quick Start'
description: 'Get Alcore running with provider plugins'
slug: /QUICK_START
keywords:
  [Alcore, quick start, installation, setup, providers, hardware requirements]
---

# Quick Start

## Requirements

| Requirement | Minimum  | Recommended             |
| ----------- | -------- | ----------------------- |
| Node.js     | 22.22+   | Latest LTS              |
| RAM         | 8 GB     | 16 GB+                  |
| Disk        | 5 GB     | 20 GB+                  |
| Docker      | Optional | Required for Work tasks |

Connect a provider (see Add Cloud Providers below) to start chatting; you only need the relevant API key.

Chat, documents, artifacts, and provider-backed features do not require Docker.
Work does: Docker must be installed on the machine running the Alcore
backend, and the backend process must be allowed to invoke it. The
`npx libre-webui` command does not install Docker. If Docker is unavailable, the
rest of Alcore continues to run while Work reports **Runtime unavailable**;
model commands are never run directly on the host as a fallback.

## Start Alcore

```bash
npx libre-webui@latest
```

Open [http://localhost:8080](http://localhost:8080). Create the first account;
that account becomes the administrator. Later public registration remains
disabled unless you explicitly set `ENABLE_SIGNUP=true`.

The packaged launcher keeps persistent state in `~/.libre-webui`. Set an
absolute `DATA_DIR` to choose another location; relative values are resolved
from the directory where you run `npx`.

## Add Cloud Providers

Cloud providers are optional. Add keys per user in **Settings → API keys**, or
server-wide in `backend/.env` (restart the backend afterwards), then enable the
provider in Settings:

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=sk-or-...
KIMI_API_KEY=...
DEEPSEEK_API_KEY=sk-...
AWS_BEARER_TOKEN_BEDROCK=...
```

Provider model lists are refreshed by the app when supported. You do not need to keep the docs open to find the latest model names.

## Start Your First Work Task

Work gives each task a persistent conversation and a separate container-backed
filesystem. It is available to authenticated administrators.

1. Install and start Docker on the machine running the Alcore backend.
2. Start a task from the **Work** button in the sidebar header, the tab bar's
   `+` menu, the Home page, or `Cmd/Ctrl + Shift + U`.
3. Choose a model that supports tool calling.
4. Describe what you want to build or change, then select **Run**.
5. Follow the result in the workspace pane's **Files**, **Activity**, **Git**,
   **Terminal**, and **Preview** tabs.

The task remains in the sidebar so you can return to the same conversation and
files later. Stopping a run or preview preserves the workspace. Deleting the
task permanently deletes its workspace.

Work runs on configured chat or completion-provider plugins. When you select a remote provider, Alcore
shows a disclosure before the run: the provider receives the
conversation, tool definitions, and any tool results requested by the model.
An autonomous run can make multiple paid provider calls.

See [Work: Isolated Workspaces](./WORKSPACES) for the runtime, persistence,
network, preview, and security details.

## Docker

```bash
git clone https://github.com/libre-webui/libre-webui
cd libre-webui
docker compose up -d
```

Create the first administrator in the browser. No registration flag or restart
is required; subsequent public registration is closed by default.

For NVIDIA GPU acceleration, use the GPU compose file provided by the repository.

Repository Compose files mount the host Docker socket so Work is available when
Docker is installed. This grants the application root-equivalent control of the
host, so read [Work: Isolated Workspaces](./WORKSPACES) first. On Linux, set
`DOCKER_GID` in `.env` to the group that owns the socket. Remove the mount if
Work is not wanted.

## Find Your Way Around

The **Home** tab has three sections: **Start** (new chat, incognito chat, new
Work task), **Continue** (your recent conversations and tasks), and **Explore**
(Notes, Calendar, Automations, Models, Personas, Imagine). The same
destinations sit in the sidebar's navigation row and in the command palette
(`Cmd/Ctrl + K`), which fuzzy-searches your chats, Work tasks, and app
actions, and full-text searches your message, note, and document contents.

- [Calendar](./CALENDAR) — a per-user calendar with recurring events.
- [Automations](./AUTOMATIONS) — scheduled AI runs delivered as chat sessions.

## Keyboard Shortcuts

| Shortcut               | Action                               |
| ---------------------- | ------------------------------------ |
| `Cmd/Ctrl + K`         | Command palette (works while typing) |
| `Cmd/Ctrl + Shift + O` | New chat                             |
| `Cmd/Ctrl + Shift + U` | New Work task                        |
| `Cmd/Ctrl + B`         | Toggle sidebar                       |
| `Cmd/Ctrl + ,`         | Settings                             |
| `Cmd/Ctrl + D`         | Toggle theme                         |
| `?`                    | Open Settings on the Shortcuts tab   |
| `Esc`                  | Close the settings modal             |
| `Enter`                | Send message                         |
| `Shift + Enter`        | New line                             |

## Next Steps

- [Working with Models](./WORKING_WITH_MODELS)
- [Work: Isolated Workspaces](./WORKSPACES)
- [Calendar](./CALENDAR)
- [Automations](./AUTOMATIONS)
- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Document Chat](./RAG_FEATURE)
- [Artifacts](./ARTIFACTS_FEATURE)
- [Docker](./DOCKER)
