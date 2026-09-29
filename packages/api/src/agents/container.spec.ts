import { createHmac } from 'node:crypto';
import { GraphEvents, Providers, StandardGraph, initializeModel } from '@librechat/agents';
import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import type { OpenAIClientOptions } from '@librechat/agents';
import { prepareOpenAIContainer } from './container';
import { resolveConfigHeaders } from '~/utils/headers';

const clock = 1_800_000_000_000;
const scope = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  conversationId: 'conversation-1',
  messageId: 'reply-1',
};
const response = {
  id: 'resp_test',
  object: 'response',
  created_at: 1,
  model: 'gpt-4.1',
  status: 'completed',
  output: [
    {
      type: 'code_interpreter_call',
      id: 'ci_test',
      container_id: 'cntr_test',
      status: 'completed',
      code: 'value = 42',
      outputs: [{ type: 'logs', logs: '42' }],
    },
    {
      type: 'message',
      id: 'msg_test',
      role: 'assistant',
      content: [{ type: 'output_text', text: '42', annotations: [] }],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
};

interface SetupOptions {
  status?: string;
  httpStatus?: number;
  streaming?: boolean;
  container?: {
    type: 'auto';
    memory_limit?: '1g' | '4g' | '16g' | '64g';
    file_ids?: string[];
    [key: string]: unknown;
  };
}

function setup({
  status = 'running',
  httpStatus = 200,
  streaming = false,
  container = { type: 'auto' },
}: SetupOptions = {}) {
  const fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/containers') && init?.method?.toUpperCase() === 'POST') {
      return new Response(
        JSON.stringify({ id: 'cntr_explicit', status: 'active', name: 'librechat-conversation-1' }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (String(url).includes('/containers/')) {
      return new Response(
        JSON.stringify(
          httpStatus === 200
            ? { id: 'cntr_test', status }
            : { error: { message: 'Container unavailable', type: 'invalid_request_error' } },
        ),
        { status: httpStatus, headers: { 'content-type': 'application/json' } },
      );
    }
    const events = [
      { type: 'response.created', response: { ...response, output: [] } },
      { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
      { type: 'response.output_item.added', output_index: 1, item: response.output[1] },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '42' },
      { type: 'response.completed', response },
    ];
    return new Response(
      streaming
        ? events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
        : JSON.stringify(response),
      { headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' } },
    );
  });
  const options: OpenAIClientOptions = {
    apiKey: 'test-key',
    model: 'gpt-4.1',
    useResponsesApi: true,
    streaming,
    configuration: {
      fetch,
      baseURL: 'https://openai.example/v1',
      defaultHeaders: { 'X-Gateway': 'gateway-secret' },
    },
  };
  const agent = {
    id: 'primary',
    provider: Providers.OPENAI,
    additional_instructions: '',
    model_parameters: options,
    tools: [{ type: 'code_interpreter', container }, { type: 'web_search' }],
  };
  const graph = new StandardGraph({
    agents: [{ agentId: agent.id, provider: Providers.OPENAI, clientOptions: options }],
  });
  const claim = jest.fn(async () => true);
  const signal = new AbortController().signal;
  const params = { ...scope, history: [], claim, signal, now: () => clock };
  const capture = async (
    session: Awaited<ReturnType<typeof prepareOpenAIContainer>>,
    output = new AIMessage({
      content: '42',
      additional_kwargs: { tool_outputs: [response.output[0]] },
    }),
  ) => {
    const next = { handle: jest.fn() };
    await session
      .wrapHandler(next)
      .handle(
        GraphEvents.CHAT_MODEL_END,
        { output },
        { langgraph_node: `agent=${agent.id}` },
        graph,
      );
    expect(next.handle).toHaveBeenCalledTimes(1);
  };
  const history = async () => {
    const first = await prepareOpenAIContainer(agent, params);
    await capture(first);
    return [
      {
        messageId: scope.messageId,
        conversationId: scope.conversationId,
        isCreatedByUser: false,
        metadata: { openAIContainer: first.snapshot() },
      },
    ];
  };
  return { agent, options, graph, fetch, params, claim, capture, history };
}

describe('OpenAI container reuse', () => {
  it('creates and exposes an explicit container when files must be staged', async () => {
    const s = setup({
      container: {
        type: 'auto',
        memory_limit: '16g',
        file_ids: ['file_input_1', 'file_input_2'],
        unsupported_option: 'ignored',
      },
    });
    const session = await prepareOpenAIContainer(s.agent, {
      ...s.params,
      ensureExplicit: true,
    });

    expect(session.id()).toBe('cntr_explicit');
    expect(session.client()).toBeDefined();
    expect(session.snapshot()?.id).toBe('cntr_explicit');
    expect(session.agent.tools[0]).toEqual({
      type: 'code_interpreter',
      container: 'cntr_explicit',
    });
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(s.fetch.mock.calls[0][1]?.body))).toEqual({
      name: 'librechat-conversation-1',
      memory_limit: '16g',
      file_ids: ['file_input_1', 'file_input_2'],
    });
  });

  it('keeps the explicit create payload minimal when auto has no options', async () => {
    const s = setup();
    await prepareOpenAIContainer(s.agent, { ...s.params, ensureExplicit: true });

    expect(JSON.parse(String(s.fetch.mock.calls[0][1]?.body))).toEqual({
      name: 'librechat-conversation-1',
    });
  });

  it('exposes the verified prior container without creating another one', async () => {
    const s = setup({
      container: { type: 'auto', memory_limit: '4g', file_ids: ['file_existing'] },
    });
    const session = await prepareOpenAIContainer(s.agent, {
      ...s.params,
      history: await s.history(),
      messageId: 'reply-2',
      ensureExplicit: true,
    });

    expect(session.id()).toBe('cntr_test');
    expect(session.client()).toBeDefined();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(String(s.fetch.mock.calls[0][0])).toContain('/containers/cntr_test');
    expect(s.fetch.mock.calls[0][1]?.method).toBe('GET');
  });

  it.each([false, true])(
    'captures and reuses a container through the SDK, streaming=%s',
    async (streaming) => {
      const s = setup({ streaming });
      const first = await prepareOpenAIContainer(s.agent, s.params);
      const model = initializeModel({
        provider: Providers.OPENAI,
        tools: first.agent.tools,
        clientOptions: first.agent.model_parameters,
      });
      const output = await model.invoke([new HumanMessage('Remember a Python variable.')]);
      await s.capture(first, output);
      expect(first.snapshot()?.id).toBe('cntr_test');
      const second = await prepareOpenAIContainer(s.agent, {
        ...s.params,
        messageId: 'reply-2',
        history: [
          { ...scope, isCreatedByUser: false, metadata: { openAIContainer: first.snapshot() } },
        ],
      });
      expect(s.claim).toHaveBeenCalledWith(
        expect.objectContaining({ userId: scope.userId, signature: first.snapshot()?.signature }),
      );
      const nextModel = initializeModel({
        provider: Providers.OPENAI,
        tools: second.agent.tools,
        clientOptions: second.agent.model_parameters,
      });
      await nextModel.invoke([new HumanMessage('Read the Python variable.')]);
      const request = s.fetch.mock.calls[s.fetch.mock.calls.length - 1]?.[1];
      expect(JSON.parse(String(request?.body)).tools).toEqual([
        { type: 'code_interpreter', container: 'cntr_test' },
        { type: 'web_search' },
      ]);
      const headers = new Headers(s.fetch.mock.calls[1][1]?.headers);
      expect(headers.get('X-Gateway')).toBe('gateway-secret');
      expect(headers.get('Authorization')).toBe('Bearer test-key');
      expect(second.snapshot()?.signature).not.toBe(first.snapshot()?.signature);
      expect(s.agent.tools[0]).toEqual({ type: 'code_interpreter', container: { type: 'auto' } });
    },
  );

  it.each(['expired', 'failed'])(
    'replaces a remotely %s container and explains lost state to the model',
    async (status) => {
      const s = setup({ status });
      const session = await prepareOpenAIContainer(s.agent, {
        ...s.params,
        history: await s.history(),
        messageId: 'reply-2',
      });
      expect(session.agent.tools).toEqual(s.agent.tools);
      expect(session.agent.additional_instructions).toContain('starts empty');
      expect(session.snapshot()).toBeUndefined();
      await s.capture(session);
      expect(session.snapshot()?.id).toBe('cntr_test');
    },
  );

  it('replaces a missing container, but preserves authentication and transient API errors', async () => {
    for (const httpStatus of [404, 401, 429, 500]) {
      const s = setup({ httpStatus });
      const pending = prepareOpenAIContainer(s.agent, { ...s.params, history: await s.history() });
      if (httpStatus === 404) expect((await pending).snapshot()).toBeUndefined();
      else await expect(pending).rejects.toMatchObject({ status: httpStatus });
      expect(s.claim).not.toHaveBeenCalled();
    }
  });

  it.each([429, 500])(
    'does not consume the continuation on a transient %s preflight failure',
    async (httpStatus) => {
      const s = setup();
      const history = await s.history();
      s.fetch.mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: 'Container temporarily unavailable', type: 'server_error' },
            }),
            { status: httpStatus, headers: { 'content-type': 'application/json' } },
          ),
      );

      await expect(
        prepareOpenAIContainer(s.agent, {
          ...s.params,
          history,
          messageId: 'reply-2',
        }),
      ).rejects.toMatchObject({ status: httpStatus });
      expect(s.claim).not.toHaveBeenCalled();

      const retry = await prepareOpenAIContainer(s.agent, {
        ...s.params,
        history,
        messageId: 'reply-2-retry',
      });
      expect(retry.snapshot()?.id).toBe('cntr_test');
      expect(s.claim).toHaveBeenCalledTimes(1);
    },
  );

  it('does not consume the continuation on a transport timeout', async () => {
    const s = setup();
    const history = await s.history();
    s.fetch.mockImplementationOnce(async () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    });

    await expect(
      prepareOpenAIContainer(s.agent, {
        ...s.params,
        history,
        messageId: 'reply-2',
      }),
    ).rejects.toThrow('Connection error');
    expect(s.claim).not.toHaveBeenCalled();

    const retry = await prepareOpenAIContainer(s.agent, {
      ...s.params,
      history,
      messageId: 'reply-2-retry',
    });
    expect(retry.snapshot()?.id).toBe('cntr_test');
  });

  it('does not claim an active container when the request is aborted during preflight', async () => {
    const s = setup();
    const history = await s.history();
    const controller = new AbortController();
    s.fetch.mockImplementationOnce(async () => {
      controller.abort();
      return new Response(JSON.stringify({ id: 'cntr_test', status: 'running' }), {
        headers: { 'content-type': 'application/json' },
      });
    });

    await prepareOpenAIContainer(s.agent, {
      ...s.params,
      history,
      messageId: 'reply-2',
      signal: controller.signal,
    }).catch(() => undefined);
    expect(s.claim).not.toHaveBeenCalled();

    const retry = await prepareOpenAIContainer(s.agent, {
      ...s.params,
      history,
      messageId: 'reply-2-retry',
      signal: new AbortController().signal,
    });
    expect(retry.snapshot()?.id).toBe('cntr_test');
  });

  it('starts fresh after twenty minutes or several days without requesting the old container', async () => {
    const s = setup();
    const history = await s.history();
    for (const elapsed of [20 * 60_000, 3 * 24 * 60 * 60_000]) {
      const session = await prepareOpenAIContainer(s.agent, {
        ...s.params,
        history,
        now: () => clock + elapsed,
      });
      expect(session.snapshot()).toBeUndefined();
      expect(session.agent.additional_instructions).toContain('starts empty');
    }
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.claim).not.toHaveBeenCalled();
  });

  it.each(['userId', 'tenantId', 'conversationId'])(
    'isolates %s and rejects copied session metadata',
    async (key) => {
      const s = setup();
      const session = await prepareOpenAIContainer(s.agent, {
        ...s.params,
        history: await s.history(),
        [key]: 'other',
      });
      expect(session.snapshot()).toBeUndefined();
      expect(s.claim).not.toHaveBeenCalled();
      expect(s.fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects tampered IDs, timestamps and message IDs', async () => {
    const s = setup();
    const [prior] = await s.history();
    for (const patch of [
      { id: 'cntr_other' },
      { updatedAt: clock + 1 },
      { signature: '0'.repeat(64) },
    ]) {
      const history = [
        {
          ...prior,
          metadata: { openAIContainer: { ...prior.metadata.openAIContainer, ...patch } },
        },
      ];
      expect(
        (await prepareOpenAIContainer(s.agent, { ...s.params, history })).snapshot(),
      ).toBeUndefined();
    }
    await prepareOpenAIContainer(s.agent, {
      ...s.params,
      history: [{ ...prior, messageId: 'copied' }],
    });
    expect(s.claim).not.toHaveBeenCalled();
  });

  it('does not reuse after credentials, endpoint, project or static headers change', async () => {
    const s = setup();
    const history = await s.history();
    for (const options of [
      { ...s.options, apiKey: 'another-key' },
      {
        ...s.options,
        configuration: { ...s.options.configuration, baseURL: 'https://other.example/v1' },
      },
      { ...s.options, configuration: { ...s.options.configuration, project: 'another-project' } },
      {
        ...s.options,
        configuration: {
          ...s.options.configuration,
          defaultHeaders: { 'X-Gateway': 'another-gateway-secret' },
        },
      },
    ]) {
      const session = await prepareOpenAIContainer(
        { ...s.agent, model_parameters: options },
        { ...s.params, history },
      );
      expect(session.snapshot()).toBeUndefined();
    }
    expect(s.claim).not.toHaveBeenCalled();
  });

  it('resolves gateway headers for the preflight with the same user and conversation as generation', async () => {
    const s = setup();
    s.options.configuration!.defaultHeaders = {
      'X-User': '{{LIBRECHAT_USER_ID}}',
      'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
    };
    await prepareOpenAIContainer(s.agent, { ...s.params, history: await s.history() });
    const headers = new Headers(s.fetch.mock.calls[0][1]?.headers);
    expect(headers.get('X-User')).toBe(scope.userId);
    expect(headers.get('X-Conversation')).toBe(scope.conversationId);
    expect(s.options.configuration?.defaultHeaders).toEqual({
      'X-User': '{{LIBRECHAT_USER_ID}}',
      'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
    });
  });

  it('keeps turn-specific gateway headers out of the stable scope and sends their current values', async () => {
    const previousSecret = process.env.CONTAINER_SCOPE_SECRET;
    process.env.CONTAINER_SCOPE_SECRET = 'admin-secret';
    try {
      const s = setup();
      s.options.configuration!.defaultHeaders = {
        'X-Message': '{{LIBRECHAT_BODY_MESSAGEID}}',
        'X-Parent': '{{LIBRECHAT_BODY_PARENTMESSAGEID}}',
        'X-Conversation': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
        'X-User': '{{LIBRECHAT_USER_ID}}',
        'X-Environment': '${CONTAINER_SCOPE_SECRET}',
        'X-User-Value': '{{LIBRECHAT_USER_NAME}}',
      };
      const user = { id: scope.userId, name: '${CONTAINER_SCOPE_SECRET}' };
      const first = await prepareOpenAIContainer(s.agent, {
        ...s.params,
        parentMessageId: 'user-1',
        user,
      });
      await s.capture(first);

      const second = await prepareOpenAIContainer(s.agent, {
        ...s.params,
        messageId: 'reply-2',
        parentMessageId: 'user-2',
        user,
        history: [
          {
            ...scope,
            isCreatedByUser: false,
            metadata: { openAIContainer: first.snapshot() },
          },
        ],
      });
      expect(second.snapshot()?.id).toBe('cntr_test');

      const preflightHeaders = new Headers(s.fetch.mock.calls[0][1]?.headers);
      expect(preflightHeaders.get('X-Message')).toBe('reply-2');
      expect(preflightHeaders.get('X-Parent')).toBe('user-2');
      expect(preflightHeaders.get('X-Conversation')).toBe(scope.conversationId);
      expect(preflightHeaders.get('X-User')).toBe(scope.userId);
      expect(preflightHeaders.get('X-Environment')).toBe('admin-secret');
      expect(preflightHeaders.get('X-User-Value')).toBe('${CONTAINER_SCOPE_SECRET}');

      const model = initializeModel({
        provider: Providers.OPENAI,
        tools: second.agent.tools,
        clientOptions: second.agent.model_parameters,
      });
      await model.invoke([new HumanMessage('Continue with the current turn headers.')]);
      const generationHeaders = new Headers(
        s.fetch.mock.calls[s.fetch.mock.calls.length - 1][1]?.headers,
      );
      expect(generationHeaders.get('X-Message')).toBe('reply-2');
      expect(generationHeaders.get('X-Parent')).toBe('user-2');
      expect(generationHeaders.get('X-User-Value')).toBe('${CONTAINER_SCOPE_SECRET}');
      expect(s.options.configuration?.defaultHeaders?.['X-Message']).toBe(
        '{{LIBRECHAT_BODY_MESSAGEID}}',
      );
    } finally {
      if (previousSecret === undefined) delete process.env.CONTAINER_SCOPE_SECRET;
      else process.env.CONTAINER_SCOPE_SECRET = previousSecret;
    }
  });

  it('keeps resolved user and environment header values in the signed scope', async () => {
    const previousSecret = process.env.CONTAINER_SCOPE_SECRET;
    process.env.CONTAINER_SCOPE_SECRET = 'first-secret';
    try {
      const s = setup();
      s.options.configuration!.defaultHeaders = {
        'X-Environment': '${CONTAINER_SCOPE_SECRET}',
        'X-User': '{{LIBRECHAT_USER_NAME}}',
      };
      const first = await prepareOpenAIContainer(s.agent, {
        ...s.params,
        user: { id: scope.userId, name: 'Alice' },
      });
      await s.capture(first);
      const history = [
        {
          ...scope,
          isCreatedByUser: false,
          metadata: { openAIContainer: first.snapshot() },
        },
      ];

      const changedUser = await prepareOpenAIContainer(s.agent, {
        ...s.params,
        messageId: 'reply-2',
        user: { id: scope.userId, name: 'Bob' },
        history,
      });
      expect(changedUser.snapshot()).toBeUndefined();

      process.env.CONTAINER_SCOPE_SECRET = 'second-secret';
      const changedEnvironment = await prepareOpenAIContainer(s.agent, {
        ...s.params,
        messageId: 'reply-3',
        user: { id: scope.userId, name: 'Alice' },
        history,
      });
      expect(changedEnvironment.snapshot()).toBeUndefined();
      expect(s.claim).not.toHaveBeenCalled();
      expect(s.fetch).not.toHaveBeenCalled();
    } finally {
      if (previousSecret === undefined) delete process.env.CONTAINER_SCOPE_SECRET;
      else process.env.CONTAINER_SCOPE_SECRET = previousSecret;
    }
  });

  it('preserves compatibility with sessions signed before stable turn headers', async () => {
    const s = setup();
    const config = s.options.configuration;
    const legacyScope = JSON.stringify([
      scope.userId,
      scope.tenantId,
      scope.conversationId,
      s.agent.id,
      s.agent.provider,
      config?.baseURL,
      config?.organization,
      config?.project,
      Object.entries(config?.defaultHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      config?.defaultQuery,
      { type: 'auto' },
    ]);
    const prior = {
      id: 'cntr_test',
      updatedAt: clock,
      signature: createHmac('sha256', s.options.apiKey as string)
        .update(JSON.stringify([legacyScope, scope.messageId, 'cntr_test', clock]))
        .digest('hex'),
    };

    const session = await prepareOpenAIContainer(s.agent, {
      ...s.params,
      messageId: 'reply-2',
      history: [
        {
          ...scope,
          isCreatedByUser: false,
          metadata: { openAIContainer: prior },
        },
      ],
    });
    expect(session.snapshot()?.id).toBe('cntr_test');
  });

  it('does not expand user-derived values again when headers were already resolved', async () => {
    const previousSecret = process.env.CONTAINER_SCOPE_SECRET;
    process.env.CONTAINER_SCOPE_SECRET = 'must-not-leak';
    try {
      const s = setup();
      s.options.configuration!.defaultHeaders = {
        'X-User-Value': '{{LIBRECHAT_USER_NAME}}',
      };
      const user = { id: scope.userId, name: '${CONTAINER_SCOPE_SECRET}' };
      resolveConfigHeaders({
        llmConfig: s.options as Parameters<typeof resolveConfigHeaders>[0]['llmConfig'],
        user,
        body: scope,
      });

      const first = await prepareOpenAIContainer(s.agent, { ...s.params, user });
      const resolvedHeaders = new Headers(
        (first.agent.model_parameters as OpenAIClientOptions).configuration
          ?.defaultHeaders as HeadersInit,
      );
      expect(resolvedHeaders.get('X-User-Value')).toBe('${CONTAINER_SCOPE_SECRET}');
      await s.capture(first);

      const second = await prepareOpenAIContainer(s.agent, {
        ...s.params,
        user,
        messageId: 'reply-2',
        history: [
          {
            ...scope,
            isCreatedByUser: false,
            metadata: { openAIContainer: first.snapshot() },
          },
        ],
      });
      expect(second.snapshot()?.id).toBe('cntr_test');
      const headers = new Headers(s.fetch.mock.calls[0][1]?.headers);
      expect(headers.get('X-User-Value')).toBe('${CONTAINER_SCOPE_SECRET}');
    } finally {
      if (previousSecret === undefined) delete process.env.CONTAINER_SCOPE_SECRET;
      else process.env.CONTAINER_SCOPE_SECRET = previousSecret;
    }
  });

  it('does not claim or query a container when the request was already cancelled', async () => {
    const s = setup();
    const controller = new AbortController();
    controller.abort();
    await prepareOpenAIContainer(s.agent, {
      ...s.params,
      history: await s.history(),
      signal: controller.signal,
    });
    expect(s.claim).not.toHaveBeenCalled();
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('explains the fresh workspace when resuming conversations created before session persistence', async () => {
    const s = setup();
    const session = await prepareOpenAIContainer(s.agent, {
      ...s.params,
      history: [
        { messageId: 'old-reply', conversationId: scope.conversationId, isCreatedByUser: false },
      ],
    });
    expect(session.agent.additional_instructions).toContain('starts empty');
    expect(session.snapshot()).toBeUndefined();
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('starts a separate workspace when another continuation already claimed the ancestor', async () => {
    const s = setup();
    s.claim.mockResolvedValue(false);
    const session = await prepareOpenAIContainer(s.agent, {
      ...s.params,
      history: await s.history(),
    });
    expect(session.agent.tools).toEqual(s.agent.tools);
    expect(session.agent.additional_instructions).toContain('starts empty');
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it('preflights concurrent continuations before atomically allowing only one claim', async () => {
    const s = setup();
    const history = await s.history();
    let claimed = false;
    s.claim.mockImplementation(async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    });
    s.fetch.mockClear();

    const sessions = await Promise.all([
      prepareOpenAIContainer(s.agent, {
        ...s.params,
        history,
        messageId: 'reply-2a',
      }),
      prepareOpenAIContainer(s.agent, {
        ...s.params,
        history,
        messageId: 'reply-2b',
      }),
    ]);

    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.claim).toHaveBeenCalledTimes(2);
    expect(sessions.filter((session) => session.snapshot()?.id === 'cntr_test')).toHaveLength(1);
    expect(
      sessions.filter((session) => session.agent.additional_instructions?.includes('starts empty')),
    ).toHaveLength(1);
  });

  it('carries the session forward through a text-only reply and ignores child-agent output', async () => {
    const s = setup();
    const session = await prepareOpenAIContainer(s.agent, {
      ...s.params,
      history: await s.history(),
      messageId: 'reply-2',
    });
    const snapshot = session.snapshot();
    await s.capture(session, new AIMessage('Hello'));
    expect(session.snapshot()).toEqual(snapshot);
    const childGraph = new StandardGraph({
      agents: [{ agentId: 'child', provider: Providers.OPENAI, clientOptions: s.options }],
    });
    await session.wrapHandler({ handle: async () => {} }).handle(
      GraphEvents.CHAT_MODEL_END,
      {
        output: new AIMessage({
          content: '',
          additional_kwargs: {
            tool_outputs: [{ ...response.output[0], container_id: 'cntr_child' }],
          },
        }),
      },
      { langgraph_node: 'agent=child' },
      childGraph,
    );
    expect(session.snapshot()).toEqual(snapshot);
  });

  it('leaves disabled tools, explicit containers and other providers unchanged', async () => {
    const s = setup();
    for (const agent of [
      { ...s.agent, tools: [] },
      { ...s.agent, provider: Providers.ANTHROPIC },
      { ...s.agent, model_parameters: { ...s.options, useResponsesApi: false } },
      { ...s.agent, tools: [{ type: 'code_interpreter', container: 'cntr_configured' }] },
    ]) {
      expect((await prepareOpenAIContainer(agent, s.params)).agent).toBe(agent);
    }
    expect(s.fetch).not.toHaveBeenCalled();
  });
});
