import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { CustomOpenAIClient, GraphEvents, Providers } from '@librechat/agents';
import type {
  EventHandler,
  GraphTools,
  ModelEndData,
  OpenAIClientOptions,
} from '@librechat/agents';
import type { MessageMethods } from '@librechat/data-schemas';
import type { TMessage } from 'librechat-data-provider';
import type { InitializedAgent } from './initialize';
import type { RunLLMConfig } from '~/types';
import { resolveConfigHeaders } from '~/utils/headers';

const idleTimeout = 20 * 60 * 1000;
const stableTurnBody = {
  messageId: '__LIBRECHAT_OPENAI_CONTAINER_MESSAGE_ID__',
  parentMessageId: '__LIBRECHAT_OPENAI_CONTAINER_PARENT_MESSAGE_ID__',
};
const sessionSchema = z.object({
  id: z.string().regex(/^cntr_[a-zA-Z0-9_-]{1,128}$/),
  updatedAt: z.number().int().nonnegative(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});
const callSchema = z.object({
  type: z.literal('code_interpreter_call'),
  container_id: sessionSchema.shape.id,
});
const outputSchema = z.object({
  response_metadata: z.object({ output: z.array(z.unknown()).optional() }).optional(),
  additional_kwargs: z.object({ tool_outputs: z.array(z.unknown()).optional() }).optional(),
});
const automaticToolSchema = z
  .object({
    type: z.literal('code_interpreter'),
    container: z
      .object({
        type: z.literal('auto'),
        memory_limit: z.enum(['1g', '4g', '16g', '64g']).optional(),
        file_ids: z.array(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
const resetInstructions =
  'No previous Python workspace is available for this turn. Any new Code Interpreter ' +
  'container starts empty: recreate variables and intermediate files from the conversation ' +
  'and available inputs. Do not assume earlier Python state or container paths still exist. ' +
  'If necessary source data is missing, ask the user for it rather than inventing it.';

export interface OpenAIContainerSession {
  id: string;
  updatedAt: number;
  signature: string;
}

interface ContainerOptions {
  userId: string;
  tenantId?: string;
  conversationId: string;
  messageId: string;
  parentMessageId?: string;
  user?: Parameters<typeof resolveConfigHeaders>[0]['user'];
  history: Pick<TMessage, 'messageId' | 'conversationId' | 'isCreatedByUser' | 'metadata'>[];
  claim: MessageMethods['claimOpenAIContainer'];
  signal: AbortSignal;
  /** Create a native OpenAI container before the run when files must be staged. */
  ensureExplicit?: boolean;
  now?: () => number;
}

interface ContainerAgent {
  id: string;
  provider: string;
  tools?: GraphTools;
  model_parameters?: object;
  additional_instructions?: string | null;
}

export interface ReusableOpenAIContainer<T extends ContainerAgent = InitializedAgent> {
  agent: T;
  id: () => string | undefined;
  client: () => CustomOpenAIClient | undefined;
  wrapHandler: (handler: EventHandler) => EventHandler;
  snapshot: () => OpenAIContainerSession | undefined;
}

function containerName(conversationId: string): string {
  const suffix = conversationId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  return `librechat-${suffix || 'conversation'}`;
}

function lastContainer(output: NonNullable<ModelEndData>['output']): string | undefined {
  const parsed = outputSchema.safeParse(output);
  if (!parsed.success) return;
  const outputItems = parsed.data.response_metadata?.output;
  const items = outputItems?.length
    ? outputItems
    : (parsed.data.additional_kwargs?.tool_outputs ?? []);
  for (let index = items.length - 1; index >= 0; index--) {
    const call = callSchema.safeParse(items[index]);
    if (call.success) return call.data.container_id;
  }
}

/** Reuse only a signed, server-loaded ancestor, atomically consumed by one continuation. */
export async function prepareOpenAIContainer<T extends ContainerAgent>(
  agent: T,
  {
    userId,
    tenantId,
    conversationId,
    messageId,
    parentMessageId,
    user,
    history,
    claim,
    signal,
    ensureExplicit = false,
    now = Date.now,
  }: ContainerOptions,
): Promise<ReusableOpenAIContainer<T>> {
  let current: OpenAIContainerSession | undefined;
  const unchanged: ReusableOpenAIContainer<T> = {
    agent,
    id: () => undefined,
    client: () => undefined,
    wrapHandler: (handler) => handler,
    snapshot: () => undefined,
  };
  const options = agent.model_parameters as OpenAIClientOptions | undefined;
  const tools = agent.tools ?? [];
  const nativeTools = tools.filter(
    (tool) => typeof tool === 'object' && 'type' in tool && tool.type === 'code_interpreter',
  );
  if (
    ![Providers.OPENAI, Providers.AZURE].includes(agent.provider as Providers) ||
    options?.useResponsesApi !== true ||
    typeof options.apiKey !== 'string' ||
    !options.apiKey ||
    nativeTools.length !== 1 ||
    !userId ||
    !conversationId ||
    !messageId
  ) {
    return unchanged;
  }
  const nativeTool = nativeTools[0];
  const parsedTool = automaticToolSchema.safeParse(nativeTool);
  if (!parsedTool.success) return unchanged;
  const apiKey = options.apiKey;

  const resolveClientOptions = (body: {
    messageId: string;
    conversationId: string;
    parentMessageId?: string;
  }) => {
    const configuration = { ...options.configuration };
    const resolved = { ...options, configuration };
    resolveConfigHeaders({
      llmConfig: resolved as RunLLMConfig,
      user: user ?? { id: userId },
      body,
    });
    return resolved;
  };

  /**
   * Resolve the outbound headers and the signed identity independently from the
   * original templates. The latter substitutes stable sentinels only for values
   * that identify an individual turn. Static, environment, user, auth and
   * conversation-scoped header values remain part of the signature, while a new
   * message/parent pair does not invalidate an otherwise reusable container.
   * Keeping the two resolutions independent also prevents a user-derived value
   * from being passed through environment expansion a second time.
   */
  const clientOptions = resolveClientOptions({ messageId, conversationId, parentMessageId });
  const scopeOptions = resolveClientOptions({
    ...stableTurnBody,
    conversationId,
  });
  const config = clientOptions.configuration;
  const scopeConfig = scopeOptions.configuration;
  const client = new CustomOpenAIClient({
    ...config,
    apiKey,
    timeout: 10_000,
    maxRetries: 0,
  });
  const scope = JSON.stringify([
    userId,
    tenantId ?? '',
    conversationId,
    agent.id,
    agent.provider,
    scopeConfig?.baseURL ?? 'https://api.openai.com/v1',
    scopeConfig?.organization,
    scopeConfig?.project,
    Object.entries(scopeConfig?.defaultHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    scopeConfig?.defaultQuery,
    parsedTool.data.container,
  ]);
  const sign = (id: string, updatedAt: number, responseId: string) =>
    createHmac('sha256', apiKey)
      .update(JSON.stringify([scope, responseId, id, updatedAt]))
      .digest('hex');
  const remember = (id: string, updatedAt: number) => {
    current = { id, updatedAt, signature: sign(id, updatedAt, messageId) };
  };

  let reset = false;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.isCreatedByUser || message.conversationId !== conversationId) continue;
    reset = true;
    const parsed = sessionSchema.safeParse(message.metadata?.openAIContainer);
    if (!parsed.success) continue;
    const prior = parsed.data;
    const signature = sign(prior.id, prior.updatedAt, message.messageId);
    if (
      !timingSafeEqual(Buffer.from(prior.signature, 'hex'), Buffer.from(signature, 'hex')) ||
      now() - prior.updatedAt >= idleTimeout ||
      now() < prior.updatedAt ||
      signal.aborted
    ) {
      break;
    }
    try {
      const container = await client.containers.retrieve(prior.id, { signal });
      if (container.status === 'running' || container.status === 'active') {
        if (signal.aborted) break;
        const claimed = await claim({
          userId,
          conversationId,
          messageId: message.messageId,
          signature: prior.signature,
        });
        if (!claimed) break;
        remember(prior.id, now());
        reset = false;
      }
    } catch (error) {
      if (!(error instanceof CustomOpenAIClient.APIError) || error.status !== 404) throw error;
    }
    break;
  }

  if (!current && ensureExplicit && !signal.aborted) {
    const { memory_limit, file_ids } = parsedTool.data.container;
    const container = await client.containers.create(
      {
        name: containerName(conversationId),
        ...(memory_limit !== undefined && { memory_limit }),
        ...(file_ids !== undefined && { file_ids }),
      },
      { signal },
    );
    if (!signal.aborted) {
      remember(container.id, now());
    }
  }

  return {
    agent: {
      ...agent,
      model_parameters: clientOptions,
      tools: tools.map((tool) =>
        tool === nativeTool && current ? { ...parsedTool.data, container: current.id } : tool,
      ),
      ...(reset && {
        additional_instructions: [agent.additional_instructions, resetInstructions]
          .filter(Boolean)
          .join('\n\n'),
      }),
    },
    id: () => current?.id,
    client: () => client,
    snapshot: () => (current ? { ...current } : undefined),
    wrapHandler: (handler) => ({
      async handle(event, data, metadata, graph) {
        await handler.handle(event, data, metadata, graph);
        if (event !== GraphEvents.CHAT_MODEL_END || !graph || !metadata) return;
        const id = lastContainer((data as ModelEndData)?.output);
        if (!id) return;
        const context = graph.getAgentContext(metadata);
        if (context.agentId !== agent.id || context.provider !== agent.provider) return;
        remember(id, now());
      },
    }),
  };
}
