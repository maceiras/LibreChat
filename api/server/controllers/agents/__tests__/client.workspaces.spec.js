const mockPrepareOpenAIContainer = jest.fn();
const mockPrepareOpenAIWorkspaces = jest.fn();
const mockCreateRun = jest.fn();
const mockWithResponseProgress = jest.fn();

jest.mock('@librechat/api', () => {
  return {
    prepareOpenAIContainer: (...args) => mockPrepareOpenAIContainer(...args),
    prepareOpenAIWorkspaces: (...args) => mockPrepareOpenAIWorkspaces(...args),
    createRun: (...args) => mockCreateRun(...args),
    withResponseProgress: (...args) => mockWithResponseProgress(...args),
    collectRestorableFileIds: jest.fn((messages) =>
      messages.flatMap((message) => message.files ?? []).map((file) => file.file_id),
    ),
    isEnabled: jest.fn(() => false),
    checkAccess: jest.fn(() => true),
    buildToolSet: jest.fn(() => new Set()),
    logToolError: jest.fn(),
    sanitizeTitle: jest.fn((value) => value),
    payloadParser: jest.fn((value) => value),
    createSafeUser: jest.fn((user) => user),
    initializeAgent: jest.fn(),
    resolveConfigHeaders: jest.fn(),
    countTokens: jest.fn(() => 0),
    createTokenCounter: jest.fn(() => jest.fn(() => 0)),
    getBalanceConfig: jest.fn(() => ({ enabled: false })),
    getTransactionsConfig: jest.fn(() => ({ enabled: false })),
    omitTitleOptions: jest.fn((value) => value),
    getProviderConfig: jest.fn(),
    memoryInstructions: '',
    applyContextToAgent: jest.fn(),
    isMemoryAgentEnabled: jest.fn(() => false),
    recordCollectedUsage: jest.fn(),
    sendEvent: jest.fn(),
    computeUsageCostUSD: jest.fn(() => 0),
    aggregateEmittedUsage: jest.fn(),
    resolveAgentTokenConfig: jest.fn(),
    buildPersistedContextUsage: jest.fn(),
    computeSummaryUsedTokens: jest.fn(),
    priorRunOutputTokens: jest.fn(),
    resolveRecursionLimit: jest.fn(() => 25),
    createMemoryProcessor: jest.fn(),
    loadAgent: jest.fn(),
    createMultiAgentMapper: jest.fn(),
    filterMalformedContentParts: jest.fn((value) => value),
    countFormattedMessageTokens: jest.fn(() => 0),
    prependFileContext: jest.fn((value) => value),
    prependQuotes: jest.fn((value) => value),
    anyAgentReplaysReasoningContent: jest.fn(() => false),
    buildInitialToolSessions: jest.fn(() => undefined),
    buildAgentScopedContext: jest.fn(() => new Map()),
    buildSkillPrimeContentParts: jest.fn(() => []),
    hasUrlContextTool: jest.fn(() => false),
    appendYouTubeVideoParts: jest.fn((value) => value),
    resolveYouTubeInjectionConfig: jest.fn(),
    GenerationJobManager: { setGraph: jest.fn() },
    hydrateMissingIndexTokenCounts: jest.fn(({ indexTokenCountMap }) => indexTokenCountMap),
    collectFreshSkillPrimeNames: jest.fn(() => new Set()),
    isSkillPrimeMessage: jest.fn(() => false),
    injectSkillPrimes: jest.fn(({ initialMessages, indexTokenCountMap }) => ({
      initialMessages,
      indexTokenCountMap,
    })),
    createSubagentUsageSink: jest.fn(() => jest.fn()),
  };
});

jest.mock('@librechat/agents', () => ({
  Callback: { TOOL_ERROR: 'tool_error' },
  GraphEvents: { CHAT_MODEL_END: 'on_chat_model_end' },
  Providers: { OPENAI: 'openAI', AZURE: 'azureOpenAI' },
  TitleMethod: {},
  formatMessage: jest.fn((message) => message),
  formatAgentMessages: jest.fn(() => ({ messages: [], indexTokenCountMap: {} })),
  createMetadataAggregator: jest.fn(() => ({ handleLLMEnd: jest.fn(), collected: [] })),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('~/server/services/Files/permissions', () => ({
  filterFilesByAgentAccess: jest.fn(),
}));
jest.mock('~/server/services/Files/images/encode', () => ({ encodeAndFormat: jest.fn() }));
jest.mock('~/app/clients/prompts', () => ({ createContextHandlers: jest.fn() }));
jest.mock('~/server/services/MCP', () => ({ resolveConfigServers: jest.fn(() => ({})) }));
jest.mock('~/server/services/Config', () => ({ getMCPServerTools: jest.fn() }));
jest.mock('~/config', () => ({ getMCPManager: jest.fn(() => ({})) }));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({})),
}));
jest.mock('~/cache', () => ({ logViolation: jest.fn() }));
jest.mock('~/models', () => ({
  claimOpenAIContainer: jest.fn(),
}));

const { GraphEvents } = require('@librechat/agents');
const AgentClient = require('../client');

describe('AgentClient native OpenAI workspace history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWithResponseProgress.mockImplementation((agent) => agent);
    mockPrepareOpenAIContainer.mockImplementation(async (agent) => ({
      agent,
      id: () => 'cntr-primary',
      client: () => ({}),
      snapshot: () => undefined,
      wrapHandler: (handler) => handler,
    }));
    mockPrepareOpenAIWorkspaces.mockImplementation(async ({ agents, prepared }) =>
      agents.map((agent) => prepared.get(agent.id) ?? agent),
    );
    mockCreateRun.mockResolvedValue({
      processStream: jest.fn().mockResolvedValue(undefined),
      getCalibrationRatio: jest.fn(() => 0),
    });
  });

  function progressTracker() {
    return {
      bind: jest.fn(),
      stage: jest.fn().mockResolvedValue(undefined),
      finish: jest.fn().mockResolvedValue(undefined),
      snapshot: jest.fn(),
    };
  }

  async function createProgressClient(responseProgress) {
    const agent = {
      id: 'primary',
      provider: 'openAI',
      model: 'gpt-test',
      model_parameters: { model: 'gpt-test', useResponsesApi: true },
      tools: [],
      accessibleSkillIds: [],
    };
    const client = new AgentClient({
      req: {
        body: {},
        config: {},
        user: { id: 'user-1', tenantId: 'tenant-1' },
      },
      agent,
      agentConfigs: new Map(),
      contentParts: [],
      collectedUsage: [],
      collectedThoughtSignatures: {},
      artifactPromises: [],
      eventHandlers: { [GraphEvents.CHAT_MODEL_END]: { handle: jest.fn() } },
      responseProgress,
    });
    client.loadHistory = jest.fn().mockResolvedValue([]);
    client.getSaveOptions = jest.fn(() => ({}));
    client.getEncoding = jest.fn(() => 'cl100k_base');
    client.recordCollectedUsage = jest.fn().mockResolvedValue(undefined);
    client.finalizeSubagentContent = jest.fn();
    client.awaitMemoryWithTimeout = jest.fn().mockResolvedValue(undefined);
    await client.setMessageOptions({
      conversationId: 'conversation-progress',
      parentMessageId: 'user-parent',
      responseMessageId: 'assistant-progress',
      user: 'user-1',
    });
    return { agent, client };
  }

  it('starts response progress before slow container preflight and wraps the primary once', async () => {
    const responseProgress = progressTracker();
    const { agent, client } = await createProgressClient(responseProgress);
    const trackedAgent = { ...agent, tracked: true };
    mockWithResponseProgress.mockReturnValue(trackedAgent);
    let releasePreflight;
    const preflightStarted = new Promise((resolve) => {
      mockPrepareOpenAIContainer.mockImplementationOnce(
        () =>
          new Promise((release) => {
            releasePreflight = () => {
              release({
                agent: trackedAgent,
                id: () => 'cntr-primary',
                client: () => ({}),
                snapshot: () => undefined,
                wrapHandler: (handler) => handler,
              });
            };
            resolve();
          }),
      );
    });

    const completion = client.chatCompletion({ payload: [] });
    await preflightStarted;

    expect(responseProgress.stage).toHaveBeenCalledWith('preparing');
    expect(mockWithResponseProgress).toHaveBeenCalledTimes(1);
    expect(mockPrepareOpenAIContainer).toHaveBeenCalledWith(trackedAgent, expect.any(Object));
    expect(responseProgress.stage.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrepareOpenAIContainer.mock.invocationCallOrder[0],
    );

    releasePreflight();
    await completion;
    expect(mockWithResponseProgress).toHaveBeenCalledTimes(1);
  });

  it('settles early progress as failed when container preflight fails', async () => {
    const responseProgress = progressTracker();
    const { client } = await createProgressClient(responseProgress);
    mockPrepareOpenAIContainer.mockRejectedValueOnce(new Error('container unavailable'));

    await client.chatCompletion({ payload: [] });

    expect(responseProgress.stage).toHaveBeenCalledWith('preparing');
    expect(responseProgress.finish.mock.calls[0]).toEqual(['failed']);
  });

  it('settles early progress as cancelled when preflight is aborted', async () => {
    const responseProgress = progressTracker();
    const { client } = await createProgressClient(responseProgress);
    const controller = new AbortController();
    let preflightStarted;
    const started = new Promise((resolve) => {
      preflightStarted = resolve;
    });
    mockPrepareOpenAIContainer.mockImplementationOnce((_agent, { signal }) => {
      preflightStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });

    const completion = client.chatCompletion({ payload: [], abortController: controller });
    await started;
    controller.abort();
    await completion;

    expect(responseProgress.stage).toHaveBeenCalledWith('preparing');
    expect(responseProgress.finish.mock.calls[0]).toEqual(['cancelled']);
  });

  it('does not start progress when the request was already aborted', async () => {
    const responseProgress = progressTracker();
    const { client } = await createProgressClient(responseProgress);
    const controller = new AbortController();
    controller.abort();
    mockPrepareOpenAIContainer.mockRejectedValueOnce(new Error('already aborted'));

    await client.chatCompletion({ payload: [], abortController: controller });

    expect(responseProgress.stage).not.toHaveBeenCalled();
    expect(responseProgress.finish.mock.calls[0]).toEqual(['cancelled']);
  });

  it('passes the loaded parent branch and its latest output file to container restoration', async () => {
    const conversationId = 'conversation-1';
    const root = {
      messageId: 'user-root',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      conversationId,
      isCreatedByUser: true,
      text: 'make a report',
    };
    const output = {
      messageId: 'assistant-output',
      parentMessageId: root.messageId,
      conversationId,
      isCreatedByUser: false,
      text: 'report ready',
      files: [{ file_id: 'file-report', filename: 'report.docx' }],
    };
    const otherBranch = {
      messageId: 'assistant-other',
      parentMessageId: root.messageId,
      conversationId,
      isCreatedByUser: false,
      text: 'other branch',
      files: [{ file_id: 'file-wrong', filename: 'wrong.docx' }],
    };
    const current = {
      messageId: 'user-current',
      parentMessageId: output.messageId,
      conversationId,
      isCreatedByUser: true,
      text: 'revise it',
    };
    const prepareResources = jest.fn().mockResolvedValue('');
    const agent = {
      id: 'primary',
      provider: 'openAI',
      model: 'gpt-test',
      model_parameters: { model: 'gpt-test' },
      tools: [],
      accessibleSkillIds: [],
    };
    const client = new AgentClient({
      req: {
        body: {},
        config: {},
        user: { id: 'user-1', tenantId: 'tenant-1' },
      },
      agent,
      agentConfigs: new Map(),
      contentParts: [],
      collectedUsage: [],
      collectedThoughtSignatures: {},
      artifactPromises: [],
      eventHandlers: { [GraphEvents.CHAT_MODEL_END]: { handle: jest.fn() } },
      openAIResources: { prepare: prepareResources },
    });
    client.loadHistory = jest.fn(async (_conversationId, head) =>
      head === output.messageId ? [root, output] : [root, otherBranch],
    );
    client.getSaveOptions = jest.fn(() => ({}));
    client.getEncoding = jest.fn(() => 'cl100k_base');
    client.recordCollectedUsage = jest.fn().mockResolvedValue(undefined);
    client.finalizeSubagentContent = jest.fn();
    client.awaitMemoryWithTimeout = jest.fn().mockResolvedValue(undefined);

    await client.setMessageOptions({
      conversationId,
      parentMessageId: output.messageId,
      responseMessageId: 'assistant-next',
      user: 'user-1',
    });
    client.currentMessages.push(current);
    await client.chatCompletion({ payload: [] });

    expect(client.loadHistory).toHaveBeenCalledWith(conversationId, output.messageId);
    const expectedHistory = [root, output, current];
    expect(mockPrepareOpenAIContainer).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({ history: expectedHistory, ensureExplicit: true }),
    );
    expect(prepareResources).toHaveBeenCalledWith(
      expect.objectContaining({ agent, history: expectedHistory }),
    );
    const restoredHistory = prepareResources.mock.calls[0][0].history;
    expect(restoredHistory.flatMap((message) => message.files ?? [])).toEqual([
      expect.objectContaining({ file_id: 'file-report' }),
    ]);
    expect(restoredHistory).not.toContain(otherBranch);
  });
});
