import { Constants, EModelEndpoint, tConversationSchema } from 'librechat-data-provider';
import type { Agent, TConversation, TModelSpec } from 'librechat-data-provider';
import { getOpenAIConfig } from '~/endpoints/openai/config';
import type { LoadAddedAgentDeps } from './added';
import { loadAddedAgent } from './added';

const deps: LoadAddedAgentDeps = {
  getAgent: jest.fn(),
  getMCPServerTools: jest.fn().mockResolvedValue(null),
};

const conversation = (overrides: Partial<TConversation> = {}): TConversation =>
  tConversationSchema.parse({
    conversationId: null,
    endpoint: EModelEndpoint.openAI,
    title: 'New Chat',
    model: 'gpt-4.1-mini',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

const request = (modelSpecs: TModelSpec[] = []) => ({
  user: { id: 'user-1' },
  config: {
    endpoints: { [EModelEndpoint.openAI]: {} },
    modelSpecs: { list: modelSpecs },
  },
});

const modelParameters = (): Agent['model_parameters'] => ({
  temperature: null,
  maxContextTokens: null,
  max_context_tokens: null,
  max_output_tokens: null,
  top_p: null,
  frequency_penalty: null,
  presence_penalty: null,
});

const ephemeralPrimary = (overrides: Partial<Agent> = {}): Agent => ({
  id: Constants.EPHEMERAL_AGENT_ID as string,
  name: null,
  description: null,
  created_at: 0,
  avatar: null,
  provider: EModelEndpoint.openAI,
  model: 'gpt-4.1',
  model_parameters: modelParameters(),
  tools: ['web_search'],
  ...overrides,
});

describe('loadAddedAgent native OpenAI parameters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves the added conversation settings when the primary is ephemeral', async () => {
    const agent = await loadAddedAgent(
      {
        req: request(),
        conversation: conversation({ code_execution: true, useResponsesApi: true }),
        primaryAgent: ephemeralPrimary(),
      },
      deps,
    );

    expect(agent?.model).toBe('gpt-4.1-mini');
    expect(agent?.model_parameters).toMatchObject({
      code_execution: true,
      useResponsesApi: true,
    });
    expect(agent?.tools).toEqual(['web_search']);
  });

  it('preserves the added conversation settings in the independently built ephemeral branch', async () => {
    const agent = await loadAddedAgent(
      {
        req: request(),
        conversation: conversation({
          code_execution: true,
          useResponsesApi: true,
          temperature: 0.25,
        }),
      },
      deps,
    );

    expect(agent?.model_parameters).toMatchObject({
      code_execution: true,
      useResponsesApi: true,
      temperature: 0.25,
    });
  });

  it('uses the selected model spec preset when the added conversation omits the settings', async () => {
    const modelSpec: TModelSpec = {
      name: 'parallel-code',
      label: 'Parallel code',
      preset: {
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4.1-mini',
        code_execution: true,
        useResponsesApi: true,
      },
    };

    const agent = await loadAddedAgent(
      {
        req: request([modelSpec]),
        conversation: conversation({ spec: modelSpec.name }),
      },
      deps,
    );

    expect(agent?.model_parameters).toMatchObject({
      code_execution: true,
      useResponsesApi: true,
    });
  });

  it('keeps explicit false values from the added conversation over model spec defaults', async () => {
    const modelSpec: TModelSpec = {
      name: 'parallel-code',
      label: 'Parallel code',
      preset: {
        endpoint: EModelEndpoint.openAI,
        model: 'gpt-4.1-mini',
        code_execution: true,
        useResponsesApi: true,
      },
    };

    const agent = await loadAddedAgent(
      {
        req: request([modelSpec]),
        conversation: conversation({
          spec: modelSpec.name,
          code_execution: false,
          useResponsesApi: false,
        }),
        primaryAgent: ephemeralPrimary({
          model_parameters: {
            ...modelParameters(),
            code_execution: true,
            useResponsesApi: true,
          } as Agent['model_parameters'] & { code_execution: boolean },
        }),
      },
      deps,
    );

    expect(agent?.model_parameters).toMatchObject({
      code_execution: false,
      useResponsesApi: false,
    });
  });

  it.each([
    ['inherited-tools branch', ephemeralPrimary()],
    ['independent branch', undefined],
  ])('leaves native code execution disabled by absence in the %s', async (_, primaryAgent) => {
    const agent = await loadAddedAgent(
      { req: request(), conversation: conversation(), primaryAgent },
      deps,
    );

    expect(agent?.model_parameters).not.toHaveProperty('code_execution');
    expect(agent?.model_parameters).not.toHaveProperty('useResponsesApi');
  });

  it('does not rewrite model parameters for a persistent added agent', async () => {
    const storedParameters = { ...modelParameters(), useResponsesApi: false };
    const storedAgent: Agent & { versions: Array<{ id: string }> } = {
      ...ephemeralPrimary({
        id: 'agent_persistent',
        tools: undefined,
        model_parameters: storedParameters,
      }),
      versions: [{ id: 'v1' }],
    };
    jest.mocked(deps.getAgent).mockResolvedValueOnce(storedAgent);

    const agent = await loadAddedAgent(
      {
        req: request(),
        conversation: conversation({
          agent_id: 'agent_persistent',
          code_execution: true,
          useResponsesApi: true,
        }),
      },
      deps,
    );

    expect(agent?.model_parameters).toBe(storedParameters);
    expect((agent as Agent & { version?: number }).version).toBe(1);
  });

  it('enables the real OpenAI Responses Code Interpreter tool from code_execution alone', async () => {
    const agent = await loadAddedAgent(
      {
        req: request(),
        conversation: conversation({ code_execution: true }),
      },
      deps,
    );
    expect(agent?.model_parameters).toEqual({ code_execution: true });
    const modelOptions = {
      ...(agent?.model_parameters as Record<string, unknown>),
      model: agent?.model,
    };

    const { llmConfig, tools } = getOpenAIConfig('test-key', {
      modelOptions: modelOptions as NonNullable<
        NonNullable<Parameters<typeof getOpenAIConfig>[1]>['modelOptions']
      >,
    });

    expect(tools).toEqual([{ type: 'code_interpreter', container: { type: 'auto' } }]);
    expect(llmConfig.useResponsesApi).toBe(true);
  });
});
