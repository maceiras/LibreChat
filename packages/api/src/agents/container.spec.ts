import { GraphEvents, Providers, StandardGraph, initializeModel } from '@librechat/agents';
import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import type { OpenAIClientOptions } from '@librechat/agents';
import { prepareOpenAIContainer } from './container';

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

function setup({ status = 'running', httpStatus = 200, streaming = false } = {}) {
  const fetch = jest.fn(async (url: string | URL | Request, _init?: RequestInit) => {
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
    tools: [{ type: 'code_interpreter', container: { type: 'auto' } }, { type: 'web_search' }],
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
    }
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

  it('does not reuse a session after credentials, endpoint or project change', async () => {
    const s = setup();
    const history = await s.history();
    for (const options of [
      { ...s.options, apiKey: 'another-key' },
      {
        ...s.options,
        configuration: { ...s.options.configuration, baseURL: 'https://other.example/v1' },
      },
      { ...s.options, configuration: { ...s.options.configuration, project: 'another-project' } },
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
    expect(s.fetch).not.toHaveBeenCalled();
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
