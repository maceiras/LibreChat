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
    container: z.object({ type: z.literal('auto') }).passthrough(),
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
  wrapHandler: (handler: EventHandler) => EventHandler;
  snapshot: () => OpenAIContainerSession | undefined;
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
    now = Date.now,
  }: ContainerOptions,
): Promise<ReusableOpenAIContainer<T>> {
  let current: OpenAIContainerSession | undefined;
  const unchanged: ReusableOpenAIContainer<T> = {
    agent,
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

  const clientOptions = { ...options, configuration: { ...options.configuration } };
  resolveConfigHeaders({
    llmConfig: clientOptions as RunLLMConfig,
    user: user ?? { id: userId },
    body: { messageId, conversationId, parentMessageId },
  });
  const config = clientOptions.configuration;
  const scope = JSON.stringify([
    userId,
    tenantId ?? '',
    conversationId,
    agent.id,
    agent.provider,
    config?.baseURL ?? 'https://api.openai.com/v1',
    config?.organization,
    config?.project,
    Object.entries(config?.defaultHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    config?.defaultQuery,
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
    const claimed = await claim({
      userId,
      conversationId,
      messageId: message.messageId,
      signature,
    });
    if (!claimed) break;
    const client = new CustomOpenAIClient({
      ...config,
      apiKey,
      timeout: 10_000,
      maxRetries: 0,
    });
    try {
      const container = await client.containers.retrieve(prior.id, { signal });
      if (container.status === 'running' || container.status === 'active') {
        remember(prior.id, now());
        reset = false;
      }
    } catch (error) {
      if (!(error instanceof CustomOpenAIClient.APIError) || error.status !== 404) throw error;
    }
    break;
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
