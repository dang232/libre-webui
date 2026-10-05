---
sidebar_position: 3
title: 'Working with AI Models'
description: 'Model selection, Ollama management, cloud provider plugins, and performance guidance for Alcore.'
slug: /WORKING_WITH_MODELS
keywords:
  [
    Alcore ai models,
    ollama models,
    ai model management,
    gemma,
    llama,
    qwen,
    local ai models,
    hardware requirements,
  ]
image: /img/social/02.png
---

# Working with AI Models

Alcore runs chats, titles, summaries, and Work on provider models: plugin-backed chat and completion providers, agent CLI models, and personas. There is no bundled local inference — every model comes from a configured provider.

## Choosing a First Model

Start from your provider's model list, then switch based on your task:

| Need              | Direction                                |
| ----------------- | ---------------------------------------- |
| Fast general chat | Your provider's small current chat model |
| Coding            | Provider coding models                   |
| Reasoning         | Provider reasoning models                |
| Vision            | Provider multimodal models               |
| Document search   | An embedding-capable provider model      |
| Text-to-speech    | TTS plugins                              |

Provider model names change frequently. In Alcore, use the provider's model discovery where available, or paste the exact model ID from the provider dashboard.

## Model Catalog

The **Model Catalog** in **Settings → Defaults** lists every chat model you can
pick, with a provider badge and a search box.
Choose the default model above the catalog to set what new chats start with.

Administrators can star a model to pin it to the top of the catalog and the
default-model menu. Starring several models puts the most recently starred one
first; removing a star restores the model's manual or provider position.

Administrators get one more control per row: an eye toggle that hides a model from everyone else's model pickers. Hiding trims long catalogs down to the models a server actually wants people using — it is a listing refinement, not an authorization gate, so treat it as curation rather than a security boundary. Administrators always see the full list, with hidden models marked.

## Provider Models

| Source           | Notes                                                         |
| ---------------- | ------------------------------------------------------------- |
| Plugin providers | Chat and completion plugins with credentials configured       |
| Agent CLI models | Chat-only models that run on the host, outside Work sandboxes |
| Personas         | Reusable system prompts pinned to a backing provider model    |                                                               |
| Provider plugins | Access to managed models from multiple providers              | API keys, provider pricing, and provider privacy policy apply |

You can keep local models for private work and enable provider plugins for tasks that need larger hosted models.

## Default Vision Model

You can chat with a fast text model and still send images. Pick a vision model
under **Settings → Defaults → Specialized Models → Vision Model**; whenever the
outgoing chat context contains images — a new attachment, an image earlier in
the session, or history in an incognito chat — that turn is routed to the
configured vision model instead of the session model. Text-only turns keep the
session model.

The setting is per user, and the routing is automatic and silent. Leaving the
selection on **Use the current chat model** disables it. Note that the check is
for images, not for the session model's abilities: when a vision model is
configured, every image-bearing turn uses it, even if the session model could
handle images itself.

The selection stores the exact provider identity (Ollama or a specific plugin)
together with the model name, so a provider cannot capture an identically named
model. If the saved selection loses that identity — for example the model or
provider is no longer available — an image-bearing turn fails. Re-select the
model under **Settings → Defaults → Specialized Models → Vision Model** to
repair it. Failing loudly is deliberate; Alcore does not silently
substitute another provider.

## Models for Work

Work needs a chat model that can call tools. It can use:

- A model listed by an active chat or completion plugin with credentials
  configured for the current administrator.

Plugin-backed Work runs use the provider adapter appropriate to the configured
plugin: OpenAI-compatible, Anthropic, or Gemini. Alcore persists the exact
provider type and plugin identifier with the task and each run, so a plugin
cannot capture an identically named Ollama model. If the selected model or
provider rejects tool calling, the run fails instead of silently switching to
another provider.

With a remote model, the configured provider receives the Work system prompt,
conversation, tool definitions, and tool results. Tool results can include
source text, command output, or directory listings requested by the model.
Workspace volumes and provider credentials remain on the backend host, but a
file's contents can leave that host when they are included in a tool result.

One autonomous Work run can make multiple model calls. Check the remote
provider's pricing, retention, and training policies before using sensitive
projects. Alcore shows a remote-provider notice in Work with a per-user
dismiss control.

## Task-Based Recommendations

| Task            | Model direction           |
| --------------- | ------------------------- |
| Fast chat       | Small current models      |
| Coding          | Provider coding models    |
| Reasoning       | Provider reasoning models |
| Vision          | Provider vision models    |
| Document search | An embedding model        |
| Text-to-speech  | TTS plugins               |

Provider model names change frequently. In Alcore, use the provider's model discovery where available, or paste the exact model ID from the provider dashboard.

## Prompting and Settings

- Generation controls such as temperature, token limits, context length, and
  penalties are grouped under **Advanced generation settings** and remain
  closed by default.
- Lower temperature (`0.1-0.3`) for factual, repeatable answers.
- Medium temperature (`0.5-0.7`) for normal assistant work.
- Higher temperature (`0.8+`) for brainstorming and creative writing.
- Keep context length reasonable when you are close to memory limits.
- Use personas when you want persistent model parameters and a reusable system prompt.

## Troubleshooting

**No models listed**

- Connect a provider under Settings → Plugins with valid credentials.
- Confirm the plugin is active and its models are synced.
- An administrator may have hidden models from the catalog.

**Responses are slow**

- Try a smaller or faster provider model.
- Reduce context length.

**Provider errors**

- Check the provider's status page and your API key quota.
- Re-sync provider models after changing credentials.

## Related Docs

- [Work: Isolated Workspaces](./WORKSPACES)
- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Plugin Architecture](./PLUGIN_ARCHITECTURE)
- [Hugging Face Hub](./HUGGINGFACE_HUB)
- [Troubleshooting](./TROUBLESHOOTING)
