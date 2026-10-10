import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-provider-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const persistenceModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'persistence', 'index.js')
  ).href
);
const providerModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'services',
      'workModelProviderService.js'
    )
  ).href
);

test.after(async () => {
  await persistenceModule.closePersistence();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});
const validationModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'pluginValidation.js')
  ).href
);

const {
  buildPluginWorkPayload,
  normalizePluginWorkResponse,
  toOpenAIWorkMessages,
  WorkModelProviderService,
} = providerModule;
const { pluginRequiresApiKey } = validationModule;

const tool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a workspace file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};

const messages = [
  { role: 'system', content: 'Work only in /workspace.' },
  { role: 'user', content: 'Read the plan.' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call-read',
        function: {
          name: 'read_file',
          arguments: { path: 'plan.txt' },
        },
      },
    ],
  },
  {
    role: 'tool',
    content: 'local plan contents',
    tool_name: 'read_file',
  },
];

const plugin = id => ({
  id,
  name: id,
  type: 'completion',
  endpoint: 'https://example.invalid/chat',
  auth: {
    header: 'Authorization',
    prefix: 'Bearer ',
    key_env: 'TEST_KEY',
  },
  model_map: ['test-model'],
});

const streamingService = remotePlugin =>
  new WorkModelProviderService({
    plugins: {
      getActivePlugins: () => [remotePlugin],
      getPlugin: id => (id === remotePlugin.id ? remotePlugin : null),
      getApiKey: () => 'test-key',
      getPluginVariables: () => ({ max_tokens: 4096 }),
    },
    post: async () => {
      throw new Error('Streaming should use fetch');
    },
    strandsAccess: async () => true,
  });

test('auth-free local plugins are available without a fake API key', async () => {
  const localPlugin = {
    ...plugin('local-chat-provider'),
    active: true,
    endpoint: 'http://127.0.0.1:8081/v1/chat/completions',
    auth: {
      header: '',
      prefix: '',
      key_env: '',
    },
  };
  const requests = [];
  const usageEvents = [];
  const service = new WorkModelProviderService({
    plugins: {
      getActivePlugins: () => [localPlugin],
      getPlugin: id => (id === localPlugin.id ? localPlugin : null),
      getApiKey: () => null,
      getPluginVariables: () => ({ max_tokens: 262144 }),
    },
    post: async (endpoint, payload, config) => {
      requests.push({ endpoint, payload, config });
      return {
        data: {
          usage: {
            prompt_tokens: 24,
            completion_tokens: 8,
            total_tokens: 32,
          },
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Local provider response',
              },
            },
          ],
        },
      };
    },
    recordPluginUsage: usage => usageEvents.push(usage),
  });

  assert.equal(pluginRequiresApiKey(localPlugin), false);
  assert.equal(pluginRequiresApiKey(plugin('alcore')), true);
  assert.deepEqual(await service.availability('test-user'), {
    pluginAvailable: true,
  });
  await service.assertModelSupportsTools(
    'test-model',
    { providerType: 'plugin', providerId: localPlugin.id },
    'test-user'
  );
  const response = await service.generateChatResponse(
    {
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello locally.' }],
      stream: false,
    },
    { providerType: 'plugin', providerId: localPlugin.id },
    'test-user'
  );

  assert.equal(response.message.content, 'Local provider response');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].config.headers.Authorization, undefined);
  assert.equal(requests[0].config.headers['Content-Type'], 'application/json');
  assert.deepEqual(usageEvents, [
    {
      userId: 'test-user',
      pluginId: 'local-chat-provider',
      pluginName: 'local-chat-provider',
      capability: 'chat',
      model: 'test-model',
      status: 'success',
      durationMs: usageEvents[0].durationMs,
      tokens: {
        promptTokens: 24,
        completionTokens: 8,
        totalTokens: 32,
      },
    },
  ]);
});

test('OpenAI-compatible Work payload preserves tool-call correlation', () => {
  const converted = toOpenAIWorkMessages(messages);
  assert.equal(converted[2].tool_calls[0].id, 'call-read');
  assert.equal(
    converted[2].tool_calls[0].function.arguments,
    '{"path":"plan.txt"}'
  );
  assert.equal(converted[3].tool_call_id, 'call-read');

  const { payload } = buildPluginWorkPayload(
    plugin('alcore'),
    {
      model: 'test-model',
      messages,
      tools: [tool],
      stream: false,
    },
    { max_tokens: 2048 }
  );
  assert.deepEqual(payload.tools, [tool]);
  assert.equal(payload.tool_choice, 'auto');
  assert.equal(payload.stream, false);

  const response = normalizePluginWorkResponse(
    plugin('alcore'),
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Reading now.',
            tool_calls: [
              {
                id: 'remote-call',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"remote.txt"}',
                },
              },
            ],
          },
        },
      ],
    },
    'test-model'
  );
  assert.equal(response.message.content, 'Reading now.');
  assert.equal(response.message.tool_calls[0].id, 'remote-call');
  assert.equal(
    response.message.tool_calls[0].function.arguments,
    '{"path":"remote.txt"}'
  );

  const { payload: streamingPayload } = buildPluginWorkPayload(
    plugin('alcore'),
    {
      model: 'test-model',
      messages,
      tools: [tool],
      stream: true,
    },
    { max_tokens: 2048 }
  );
  assert.equal(streamingPayload.stream, true);
});

test('Work streams OpenAI-compatible reasoning, text, usage, and tools', async () => {
  const remotePlugin = {
    ...plugin('alcore'),
    active: true,
  };
  const service = streamingService(remotePlugin);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(payload.stream, true);
    const body = [
      'data: {"choices":[{"delta":{"reasoning_content":"Inspecting "}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"Done."}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-live","function":{"name":"read_file","arguments":"{\\"path\\":\\"live"}}]}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".txt\\"}"}}]}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const content = [];
  const reasoning = [];
  const usage = [];
  try {
    const response = await service.generateChatStreamResponse(
      {
        model: 'test-model',
        messages: messages.slice(0, 2),
        tools: [tool],
        stream: true,
      },
      { providerType: 'plugin', providerId: remotePlugin.id },
      'test-user',
      {
        onContent: chunk => content.push(chunk),
        onReasoning: chunk => reasoning.push(chunk),
        onUsage: value => usage.push(value),
      }
    );
    assert.equal(content.join(''), 'Done.');
    assert.equal(reasoning.join(''), 'Inspecting ');
    assert.equal(response.message.content, 'Done.');
    assert.equal(response.message.thinking, 'Inspecting ');
    assert.deepEqual(response.message.tool_calls[0], {
      id: 'call-live',
      providerMetadata: {
        openAIReasoningContent: 'Inspecting ',
      },
      function: {
        name: 'read_file',
        arguments: { path: 'live.txt' },
      },
    });
    assert.deepEqual(usage.at(-1), {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Work marks truncated OpenAI-compatible tool arguments for safe recovery', async () => {
  const remotePlugin = {
    ...plugin('alcore'),
    active: true,
  };
  const service = streamingService(remotePlugin);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const body = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-truncated","function":{"name":"write_file","arguments":"{\\\"path\\\":\\\"app.js\\\",\\\"content\\\":\\\"unterminated"}}]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    const response = await service.generateChatStreamResponse(
      {
        model: 'test-model',
        messages: messages.slice(0, 2),
        tools: [tool],
        stream: true,
      },
      { providerType: 'plugin', providerId: remotePlugin.id },
      'test-user',
      {}
    );
    const call = response.message.tool_calls[0];
    assert.deepEqual(call.function.arguments, {});
    assert.match(
      call.providerMetadata.libreToolArgumentsError,
      /incomplete or invalid JSON/
    );
    assert.match(
      call.providerMetadata.libreToolArgumentsError,
      /smaller payload/
    );
    assert.equal(
      'unterminated' in call.providerMetadata,
      false,
      'raw provider arguments must not be retained'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Work rejects HTTP-200 OpenAI-compatible SSE error events', async () => {
  const remotePlugin = {
    ...plugin('alcore'),
    active: true,
  };
  const service = streamingService(remotePlugin);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      'data: {"error":{"message":"quota exhausted"}}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );

  try {
    await assert.rejects(
      service.generateChatStreamResponse(
        {
          model: 'test-model',
          messages: messages.slice(0, 2),
          tools: [tool],
          stream: true,
        },
        { providerType: 'plugin', providerId: remotePlugin.id },
        'test-user',
        {}
      ),
      /quota exhausted/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider identity keeps plugin routes separate and rejects removed providers', async () => {
  const collidingPlugin = {
    ...plugin('remote-collision'),
    active: true,
    model_map: ['shared-model'],
  };
  const pluginRequests = [];
  const service = new WorkModelProviderService({
    plugins: {
      getActivePlugins: () => [collidingPlugin],
      getPlugin: id => (id === collidingPlugin.id ? collidingPlugin : null),
      getApiKey: candidate =>
        candidate.id === collidingPlugin.id ? 'test-key' : null,
      getPluginVariables: () => ({}),
    },
    post: async (endpoint, payload) => {
      pluginRequests.push({ endpoint, payload });
      return {
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'plugin route',
              },
            },
          ],
        },
      };
    },
  });
  const request = {
    model: 'shared-model',
    messages: [{ role: 'user', content: 'Which route?' }],
    tools: [tool],
    stream: false,
  };

  await assert.rejects(
    service.assertModelSupportsTools(
      request.model,
      { providerType: 'ollama' },
      'test-user'
    ),
    /removed/
  );
  await assert.rejects(
    service.generateChatResponse(
      request,
      { providerType: 'ollama' },
      'test-user'
    ),
    /removed/
  );
  assert.equal(pluginRequests.length, 0);

  await service.assertModelSupportsTools(
    request.model,
    { providerType: 'plugin', providerId: collidingPlugin.id },
    'test-user'
  );
  const remote = await service.generateChatResponse(
    request,
    { providerType: 'plugin', providerId: collidingPlugin.id },
    'test-user'
  );
  assert.equal(remote.message.content, 'plugin route');
  assert.equal(pluginRequests.length, 1);

  await assert.rejects(
    service.generateChatResponse(
      request,
      { providerType: 'plugin', providerId: 'different-plugin' },
      'test-user'
    ),
    error =>
      error?.code === 'WORK_PLUGIN_UNAVAILABLE' &&
      /different-plugin/.test(error.message)
  );
});


test('unparseable or non-object tool arguments degrade to an empty object', async () => {
  const { parseToolArguments } = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'services', 'workModelProviderService.js')
    ).href
  );
  assert.deepEqual(parseToolArguments('{"broken":'), {});
  assert.deepEqual(parseToolArguments('"just a string"'), {});
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments({ already: 'object' }), {
    already: 'object',
  });
});

test('Work screenshots reach every provider payload as image parts', () => {
  const screenshot = Buffer.from('screenshot-bytes').toString('base64');
  const screenshotMessages = [
    { role: 'system', content: 'Work only in /workspace.' },
    { role: 'user', content: 'Open the dashboard.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-observe',
          function: { name: 'computer_observe', arguments: {} },
        },
        {
          id: 'call-list',
          function: { name: 'list_files', arguments: { path: '.' } },
        },
      ],
    },
    {
      role: 'tool',
      content: 'Screen 1280x800, cursor at 10,20.',
      tool_name: 'computer_observe',
      tool_call_id: 'call-observe',
      images: [screenshot],
    },
    {
      role: 'tool',
      content: '[]',
      tool_name: 'list_files',
      tool_call_id: 'call-list',
    },
  ];
  const request = {
    model: 'test-model',
    messages: screenshotMessages,
    tools: [tool],
    stream: false,
  };
  const dataUrl = `data:image/png;base64,${screenshot}`;

  // OpenAI-compatible chat: tool messages stay text-only and the screenshot
  // follows the whole tool-result run as one user message.
  const converted = toOpenAIWorkMessages(screenshotMessages);
  assert.equal(converted.length, 6);
  assert.equal(converted[3].role, 'tool');
  assert.equal(typeof converted[3].content, 'string');
  assert.equal(converted[4].role, 'tool');
  const imageMessage = converted[5];
  assert.equal(imageMessage.role, 'user');
  assert.equal(imageMessage.content[0].type, 'text');
  assert.deepEqual(imageMessage.content[1], {
    type: 'image_url',
    image_url: { url: dataUrl },
  });

  // Responses mode: the screenshot lands as an input_image user item after
  // both function_call_output items.
  const { payload: responsesPayload } = buildPluginWorkPayload(
    plugin('alcore'),
    request,
    {},
    'responses'
  );
  const responseImage = responsesPayload.input.at(-1);
  assert.equal(responseImage.role, 'user');
  assert.equal(responseImage.content[0].type, 'input_text');
  assert.deepEqual(responseImage.content[1], {
    type: 'input_image',
    image_url: dataUrl,
  });

});

test('Strands Work selections retain the exact underlying provider and require access', async () => {
  let strandsAllowed = true;
  const remotePlugin = {
    ...plugin('fixture-work'),
    active: true,
    model_map: ['fixture-model'],
  };
  const service = new WorkModelProviderService({
    plugins: {
      getActivePlugins: () => [remotePlugin],
      getPlugin: id => (id === remotePlugin.id ? remotePlugin : null),
      getApiKey: () => 'test-key',
      getPluginVariables: () => ({}),
    },
    post: async () => {
      throw new Error('Unexpected remote request');
    },
    strandsAccess: async () => strandsAllowed,
  });
  const selection = { providerType: 'plugin', providerId: remotePlugin.id };
  const originalFetch = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'fixture' } }],
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  };
  try {
    strandsAllowed = false;
    await assert.rejects(
      service.assertModelSupportsTools(
        'strands:fixture-model',
        selection,
        'user'
      ),
      error => error.code === 'WORK_STRANDS_DISABLED'
    );
    strandsAllowed = true;
    await service.assertModelSupportsTools(
      'strands:fixture-model',
      selection,
      'user'
    );
    await service.generateChatStreamResponse(
      {
        model: 'strands:fixture-model',
        messages: [],
        tools: [tool],
        stream: true,
      },
      selection,
      'user',
      {}
    );
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].model, 'fixture-model');
    assert.deepEqual(payloads[0].tools, [tool]);
    for (const model of ['strands:', 'dsh:', 'strands:strands:fixture-model']) {
      await assert.rejects(
        service.assertModelSupportsTools(model, selection, 'user'),
        error => error.code === 'WORK_MODEL_TOOLS_UNSUPPORTED'
      );
    }
  } finally {
    strandsAllowed = true;
    globalThis.fetch = originalFetch;
  }
});

test('Strands Work streams through the exact plugin using its unwrapped model id', async () => {
  const remotePlugin = { ...plugin('openai'), active: true };
  const service = streamingService(remotePlugin);
  const originalFetch = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return new Response(
      'data: {"choices":[{"delta":{"content":"sandbox reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );
  };
  try {
    const selection = { providerType: 'plugin', providerId: remotePlugin.id };
    await service.assertModelSupportsTools(
      'strands:test-model',
      selection,
      'test-user'
    );
    assert.equal(
      await service.getRoutingFingerprint(
        'strands:test-model',
        selection,
        'test-user'
      ),
      await service.getRoutingFingerprint('test-model', selection, 'test-user')
    );
    const result = await service.generateChatStreamResponse(
      {
        model: 'strands:test-model',
        messages: messages.slice(0, 2),
        tools: [tool],
        stream: true,
      },
      selection,
      'test-user',
      {}
    );
    assert.equal(result.message.content, 'sandbox reply');
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].model, 'test-model');
    assert.deepEqual(payloads[0].tools, [tool]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Work payloads carry the run reasoning level per provider', () => {
  const request = (model, think) => ({
    model,
    messages: messages.slice(0, 2),
    tools: [tool],
    stream: false,
    ...(think === undefined ? {} : { options: { think } }),
  });

  const openai = buildPluginWorkPayload(
    plugin('openai'),
    request('test-model', 'high')
  ).payload;
  assert.equal(openai.reasoning_effort, 'high');
  const openaiDefault = buildPluginWorkPayload(
    plugin('openai'),
    request('test-model')
  ).payload;
  assert.equal('reasoning_effort' in openaiDefault, false);

  const deepseek = buildPluginWorkPayload(
    plugin('deepseek'),
    request('test-model', false)
  ).payload;
  assert.deepEqual(deepseek.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in deepseek, false);

  const responses = buildPluginWorkPayload(
    plugin('openai'),
    request('test-model', 'low'),
    {},
    'responses'
  ).payload;
  assert.deepEqual(responses.reasoning, { effort: 'low', summary: 'auto' });

  const anthropic = buildPluginWorkPayload(
    plugin('anthropic'),
    request('claude-opus-4-1', 'medium')
  ).payload;
  assert.deepEqual(anthropic.thinking, {
    type: 'enabled',
    budget_tokens: 8192,
  });
  assert.equal(anthropic.max_tokens, 4096 + 8192);
  const anthropicDefault = buildPluginWorkPayload(
    plugin('anthropic'),
    request('claude-opus-4-1')
  ).payload;
  assert.equal(anthropicDefault.max_tokens, 4096);
  assert.equal('thinking' in anthropicDefault, false);

  const adaptive = buildPluginWorkPayload(
    plugin('anthropic'),
    request('claude-sonnet-5-5', 'high')
  ).payload;
  assert.deepEqual(adaptive.thinking, { type: 'adaptive' });
  assert.deepEqual(adaptive.output_config, { effort: 'high' });

  const gemini = buildPluginWorkPayload(
    plugin('gemini'),
    request('gemini-2.5-pro', 'low')
  ).payload;
  assert.deepEqual(gemini.generationConfig.thinkingConfig, {
    thinkingBudget: 2048,
    includeThoughts: true,
  });
  assert.equal(gemini.generationConfig.maxOutputTokens, 4096 + 2048);
  const geminiOff = buildPluginWorkPayload(
    plugin('gemini'),
    request('gemini-2.5-pro', false)
  ).payload;
  assert.equal(geminiOff.generationConfig.maxOutputTokens, 4096);
  assert.equal('thinkingConfig' in geminiOff.generationConfig, false);
});
