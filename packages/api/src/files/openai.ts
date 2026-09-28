import { z } from 'zod';
import path from 'node:path';
import { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { GraphEvents, Providers, CustomOpenAIClient } from '@librechat/agents';
import { FileContext, FileSources, inferMimeType, megabyte } from 'librechat-data-provider';
import type { EventHandler, ModelEndData, OpenAIClientOptions } from '@librechat/agents';
import type { IMongoFile } from '@librechat/data-schemas';
import type { SaveBufferFn } from '~/storage/types';
import type { RetentionExpiry } from './retention';
import type { ServerRequest } from '~/types';
import { getConfiguredFileSizeLimit } from './encode/utils';
import { getStorageMetadata } from '~/storage/metadata';

const containerReferenceSchema = z.object({
  container_id: z.string().regex(/^cntr_[a-zA-Z0-9_-]+$/),
  file_id: z.string().regex(/^cfile_[a-zA-Z0-9_-]+$/),
});

const containerCitationSchema = z.union([
  containerReferenceSchema.extend({
    type: z.literal('container_file_citation'),
    filename: z.string().min(1),
  }),
  containerReferenceSchema
    .extend({
      type: z.literal('citation'),
      source: z.literal('container_file_citation'),
      title: z.string().min(1),
    })
    .transform(({ container_id, file_id, title }) => ({
      type: 'container_file_citation' as const,
      container_id,
      file_id,
      filename: title,
    })),
]);

type ContainerCitation = z.infer<typeof containerCitationSchema>;

interface OpenAIFileHandlerOptions {
  req: ServerRequest;
  handler: EventHandler;
  getStrategyFunctions: (source: string) => { saveBuffer?: SaveBufferFn };
  createFile: (file: Partial<IMongoFile>, disableTTL?: boolean) => Promise<IMongoFile | null>;
  getRetentionExpiry: (req: ServerRequest) => Promise<RetentionExpiry>;
  onFile: (file: IMongoFile) => void | Promise<void>;
}

/** Read incrementally so missing or incorrect Content-Length cannot bypass the file limit. */
async function readFileContent(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) {
    throw new Error('OpenAI returned an empty file response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (Number(response.headers.get('content-length')) > limit) {
      throw new Error('OpenAI output file exceeds the configured size limit');
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return Buffer.concat(chunks, bytes);
      }
      bytes += value.byteLength;
      if (bytes > limit) {
        throw new Error('OpenAI output file exceeds the configured size limit');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function getContainerCitations(output: NonNullable<ModelEndData>['output']): ContainerCitation[] {
  if (!Array.isArray(output?.content)) {
    return [];
  }
  const citations = new Map<string, ContainerCitation>();
  for (const block of output.content) {
    if (typeof block !== 'object' || !Array.isArray(block.annotations)) {
      continue;
    }
    for (const annotation of block.annotations) {
      const parsed = containerCitationSchema.safeParse(annotation);
      if (parsed.success) {
        citations.set(`${parsed.data.container_id}:${parsed.data.file_id}`, parsed.data);
      }
    }
  }
  return [...citations.values()];
}

/** Persist Responses container outputs before the remote container expires. */
export function createOpenAIFileHandler({
  req,
  handler,
  onFile,
  createFile,
  getStrategyFunctions,
  getRetentionExpiry,
}: OpenAIFileHandlerOptions): EventHandler {
  const processed = new Set<string>();
  const user = req.user;
  return {
    async handle(event, data, metadata, graph) {
      await handler.handle(event, data, metadata, graph);
      if (event !== GraphEvents.CHAT_MODEL_END || !graph || !metadata || !user) {
        return;
      }
      const citations = getContainerCitations((data as ModelEndData)?.output);
      if (!citations.length) {
        return;
      }
      const context = graph.getAgentContext(metadata);
      if (context.provider !== Providers.OPENAI && context.provider !== Providers.AZURE) {
        return;
      }
      const options = context.clientOptions as OpenAIClientOptions | undefined;
      if (options?.useResponsesApi !== true || options.apiKey == null) {
        return;
      }
      const client = new CustomOpenAIClient({
        ...options.configuration,
        apiKey: options.apiKey,
        timeout: 30_000,
        maxRetries: 1,
      });
      const source = req.config?.fileStrategy ?? FileSources.local;
      const { saveBuffer } = getStrategyFunctions(source);
      const limit =
        getConfiguredFileSizeLimit(req, { provider: context.provider }) ?? 20 * megabyte;
      for (const citation of citations) {
        const key = `${metadata.run_id}:${citation.container_id}:${citation.file_id}`;
        if (processed.has(key)) {
          continue;
        }
        processed.add(key);
        try {
          if (!saveBuffer) {
            throw new Error(`File storage is unavailable for strategy ${source}`);
          }
          const timeout = AbortSignal.timeout(30_000);
          const response = await client.containers.files.content.retrieve(
            citation.file_id,
            { container_id: citation.container_id },
            { signal: graph.signal ? AbortSignal.any([graph.signal, timeout]) : timeout },
          );
          const buffer = await readFileContent(response, limit);
          const filename = path.posix.basename(citation.filename.replace(/\\/g, '/'));
          const file_id = randomUUID();
          const type = inferMimeType(filename, '') || 'application/octet-stream';
          const filepath = await saveBuffer({
            userId: user.id,
            tenantId: user.tenantId,
            buffer,
            fileName: `${file_id}${path
              .extname(filename)
              .replace(/[^.a-zA-Z0-9]/g, '')
              .slice(0, 16)}`,
            basePath: 'uploads',
          });
          const file = await createFile(
            {
              file_id,
              filename,
              filepath,
              type,
              source,
              bytes: buffer.length,
              user: new Types.ObjectId(user.id),
              tenantId: user.tenantId,
              object: 'file',
              context: FileContext.code_interpreter,
              usage: 1,
              messageId: typeof metadata.run_id === 'string' ? metadata.run_id : undefined,
              conversationId:
                typeof metadata.thread_id === 'string' ? metadata.thread_id : undefined,
              ...getStorageMetadata({ filepath, source }),
              ...(await getRetentionExpiry(req)),
            },
            true,
          );
          if (!file) {
            throw new Error('Unable to persist OpenAI output file');
          }
          await onFile(file);
        } catch (error) {
          processed.delete(key);
          logger.error('[OpenAI Code Interpreter] Failed to save output file', error);
        }
      }
    },
  };
}
