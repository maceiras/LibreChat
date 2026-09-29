import { z } from 'zod';
import sharp from 'sharp';
import path from 'node:path';
import { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { GraphEvents, Providers, CustomOpenAIClient } from '@librechat/agents';
import {
  FileContext,
  FileSources,
  imageExtRegex,
  inferMimeType,
  megabyte,
} from 'librechat-data-provider';
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

const sandboxDataPrefix = 'sandbox:/mnt/data/';
const sandboxDataRoot = '/mnt/data/';

interface OpenAIFileHandlerOptions {
  req: ServerRequest;
  handler: EventHandler;
  imageSource?: string;
  onProgress?: () => void | Promise<void>;
  onError?: () => void | Promise<void>;
  getStrategyFunctions: (source: string) => { saveBuffer?: SaveBufferFn };
  createFile: (file: Partial<IMongoFile>, disableTTL?: boolean) => Promise<IMongoFile | null>;
  getRetentionExpiry: (req: ServerRequest) => Promise<RetentionExpiry>;
  onFile: (file: IMongoFile) => void | Promise<void>;
}

async function getImageMetadata(
  buffer: Buffer,
  filename: string,
): Promise<Pick<IMongoFile, 'width' | 'height' | 'type'> | undefined> {
  if (!imageExtRegex.test(filename)) {
    return;
  }
  try {
    const { format, width, height, pageHeight } = await sharp(buffer).metadata();
    if (!format || !['png', 'jpeg', 'gif', 'webp'].includes(format) || !width || !height) {
      return;
    }
    return { type: `image/${format}`, width, height: pageHeight ?? height };
  } catch (error) {
    logger.warn('[OpenAI Code Interpreter] Unable to inspect image; keeping download', error);
  }
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

function normalizeSandboxDataLink(destination: string): string | undefined {
  if (!destination.startsWith(sandboxDataPrefix)) {
    return;
  }
  const suffixIndex = destination.search(/[?#]/);
  const withoutSuffix = suffixIndex === -1 ? destination : destination.slice(0, suffixIndex);
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutSuffix.slice('sandbox:'.length));
  } catch {
    return;
  }
  const slashPath = decoded.replace(/\\/g, '/');
  if (
    !slashPath.startsWith(sandboxDataRoot) ||
    slashPath
      .slice(sandboxDataRoot.length)
      .split('/')
      .some((part) => part === '.' || part === '..')
  ) {
    return;
  }
  const normalized = path.posix.normalize(slashPath);
  if (!normalized.startsWith(sandboxDataRoot) || normalized === sandboxDataRoot) {
    return;
  }
  return normalized;
}

function skipCodeFence(text: string, index: number): number | undefined {
  const marker = text[index];
  if (marker !== '`' && marker !== '~') {
    return;
  }
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  if (!/^ {0,3}$/.test(text.slice(lineStart, index))) {
    return;
  }
  let markerLength = 0;
  while (text[index + markerLength] === marker) {
    markerLength += 1;
  }
  if (markerLength < 3) {
    return;
  }
  let nextLine = text.indexOf('\n', index + markerLength);
  if (nextLine === -1) {
    return text.length;
  }
  nextLine += 1;
  while (nextLine < text.length) {
    const lineEnd = text.indexOf('\n', nextLine);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(nextLine, end);
    const indent = line.match(/^ {0,3}/)?.[0].length ?? 0;
    let closingLength = 0;
    while (line[indent + closingLength] === marker) {
      closingLength += 1;
    }
    if (closingLength >= markerLength && line.slice(indent + closingLength).trim() === '') {
      return lineEnd === -1 ? text.length : lineEnd + 1;
    }
    if (lineEnd === -1) {
      break;
    }
    nextLine = lineEnd + 1;
  }
  return text.length;
}

function skipCodeSpan(text: string, index: number): number | undefined {
  if (text[index] !== '`') {
    return;
  }
  let markerLength = 0;
  while (text[index + markerLength] === '`') {
    markerLength += 1;
  }
  const marker = '`'.repeat(markerLength);
  let closing = text.indexOf(marker, index + markerLength);
  while (closing !== -1) {
    if (text[closing - 1] !== '`' && text[closing + markerLength] !== '`') {
      return closing + markerLength;
    }
    closing = text.indexOf(marker, closing + markerLength);
  }
}

function readMarkdownLink(
  text: string,
  index: number,
): { destination: string; end: number } | undefined {
  let cursor = index;
  if (text[cursor] === '!') {
    cursor += 1;
  }
  if (text[cursor] !== '[') {
    return;
  }
  let labelDepth = 1;
  cursor += 1;
  while (cursor < text.length && labelDepth > 0) {
    if (text[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    const codeEnd = skipCodeSpan(text, cursor);
    if (codeEnd != null) {
      cursor = codeEnd;
      continue;
    }
    if (text[cursor] === '[') {
      labelDepth += 1;
    } else if (text[cursor] === ']') {
      labelDepth -= 1;
    }
    cursor += 1;
  }
  if (labelDepth !== 0 || text[cursor] !== '(') {
    return;
  }
  cursor += 1;
  while (/\s/.test(text[cursor] ?? '')) {
    cursor += 1;
  }

  let destination = '';
  if (text[cursor] === '<') {
    cursor += 1;
    while (cursor < text.length && text[cursor] !== '>') {
      if (text[cursor] === '\\' && cursor + 1 < text.length) {
        destination += text[cursor + 1];
        cursor += 2;
        continue;
      }
      if (text[cursor] === '\n') {
        return;
      }
      destination += text[cursor];
      cursor += 1;
    }
    if (text[cursor] !== '>') {
      return;
    }
    cursor += 1;
  } else {
    let nestedParentheses = 0;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === '\\' && cursor + 1 < text.length) {
        destination += text[cursor + 1];
        cursor += 2;
        continue;
      }
      if (character === '(') {
        nestedParentheses += 1;
        destination += character;
        cursor += 1;
        continue;
      }
      if (character === ')') {
        if (nestedParentheses === 0) {
          return { destination, end: cursor + 1 };
        }
        nestedParentheses -= 1;
        destination += character;
        cursor += 1;
        continue;
      }
      if (/\s/.test(character) && nestedParentheses === 0) {
        break;
      }
      destination += character;
      cursor += 1;
    }
  }

  while (/\s/.test(text[cursor] ?? '')) {
    cursor += 1;
  }
  if (text[cursor] === '"' || text[cursor] === "'") {
    const quote = text[cursor];
    cursor += 1;
    while (cursor < text.length && text[cursor] !== quote) {
      cursor += text[cursor] === '\\' ? 2 : 1;
    }
    if (text[cursor] !== quote) {
      return;
    }
    cursor += 1;
    while (/\s/.test(text[cursor] ?? '')) {
      cursor += 1;
    }
  }
  if (text[cursor] !== ')') {
    return;
  }
  return { destination, end: cursor + 1 };
}

function getMarkdownSandboxLinks(text: string): Set<string> {
  const links = new Set<string>();
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    const fenceEnd = skipCodeFence(text, cursor);
    if (fenceEnd != null) {
      cursor = fenceEnd;
      continue;
    }
    const codeEnd = skipCodeSpan(text, cursor);
    if (codeEnd != null) {
      cursor = codeEnd;
      continue;
    }
    const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
    if (/^(?: {4,}|\t)/.test(text.slice(lineStart, cursor))) {
      cursor = text.indexOf('\n', cursor);
      if (cursor === -1) {
        break;
      }
      cursor += 1;
      continue;
    }
    const markdownLink = readMarkdownLink(text, cursor);
    if (!markdownLink) {
      cursor += 1;
      continue;
    }
    const link = normalizeSandboxDataLink(markdownLink.destination);
    if (link) {
      links.add(link);
    }
    cursor = markdownLink.end;
  }
  return links;
}

function normalizeCitationPath(filename: string): string | undefined {
  const slashPath = filename.replace(/\\/g, '/');
  if (
    !slashPath.startsWith(sandboxDataRoot) ||
    slashPath
      .slice(sandboxDataRoot.length)
      .split('/')
      .some((part) => part === '.' || part === '..')
  ) {
    return;
  }
  const normalized = path.posix.normalize(slashPath);
  if (!normalized.startsWith(sandboxDataRoot) || normalized === sandboxDataRoot) {
    return;
  }
  return normalized;
}

function getContainerCitations(output: NonNullable<ModelEndData>['output']): ContainerCitation[] {
  if (!Array.isArray(output?.content)) {
    return [];
  }
  const citations = new Map<string, ContainerCitation>();
  const linkedPaths = new Set<string>();
  for (const block of output.content) {
    if (typeof block !== 'object') {
      continue;
    }
    if (typeof block.text === 'string') {
      for (const link of getMarkdownSandboxLinks(block.text)) {
        linkedPaths.add(link);
      }
    }
    if (Array.isArray(block.annotations)) {
      for (const annotation of block.annotations) {
        const parsed = containerCitationSchema.safeParse(annotation);
        if (parsed.success) {
          citations.set(`${parsed.data.container_id}:${parsed.data.file_id}`, parsed.data);
        }
      }
    }
  }
  if (!linkedPaths.size) {
    return [];
  }

  const entries = [...citations.entries()];
  const citationsByPath = new Map<string, Array<[string, ContainerCitation]>>();
  for (const entry of entries) {
    const citationPath = normalizeCitationPath(entry[1].filename);
    if (!citationPath) {
      continue;
    }
    const matches = citationsByPath.get(citationPath) ?? [];
    matches.push(entry);
    citationsByPath.set(citationPath, matches);
  }

  const selected = new Set<string>();
  const availableLinkedPathsByBasename = new Map<string, Set<string>>();
  for (const linkedPath of linkedPaths) {
    const exactMatches = citationsByPath.get(linkedPath);
    if (exactMatches?.length === 1) {
      selected.add(exactMatches[0][0]);
    }
    if (exactMatches?.length) {
      continue;
    }
    const basename = path.posix.basename(linkedPath);
    const matches = availableLinkedPathsByBasename.get(basename) ?? new Set<string>();
    matches.add(linkedPath);
    availableLinkedPathsByBasename.set(basename, matches);
  }

  const bareCitationsByBasename = new Map<string, Array<[string, ContainerCitation]>>();
  for (const entry of entries) {
    if (entry[1].filename.includes('/') || entry[1].filename.includes('\\')) {
      continue;
    }
    const matches = bareCitationsByBasename.get(entry[1].filename) ?? [];
    matches.push(entry);
    bareCitationsByBasename.set(entry[1].filename, matches);
  }
  for (const [basename, matches] of bareCitationsByBasename) {
    if (matches.length === 1 && availableLinkedPathsByBasename.get(basename)?.size === 1) {
      selected.add(matches[0][0]);
    }
  }

  return entries.filter(([key]) => selected.has(key)).map(([, item]) => item);
}

/** Persist Responses container outputs before the remote container expires. */
export function createOpenAIFileHandler({
  req,
  handler,
  imageSource,
  onProgress,
  onError,
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
      /** Match the graph callback visibility rule: hidden intermediate sequential-agent
       * outputs remain available to the wrapped handler for accounting/state updates, but
       * must not produce user-visible or persisted attachments. */
      const lastAgentId = metadata.last_agent_id;
      const graphNode = metadata.langgraph_node;
      const isLastAgent =
        typeof lastAgentId === 'string' &&
        lastAgentId.length > 0 &&
        typeof graphNode === 'string' &&
        graphNode.length > 0 &&
        graphNode.endsWith(lastAgentId);
      if (metadata.hide_sequential_outputs === true && !isLastAgent) {
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
      const defaultSource = req.config?.fileStrategy ?? FileSources.local;
      const limit =
        getConfiguredFileSizeLimit(req, { provider: context.provider }) ?? 20 * megabyte;
      for (const citation of citations) {
        const key = `${metadata.run_id}:${citation.container_id}:${citation.file_id}`;
        if (processed.has(key)) {
          continue;
        }
        processed.add(key);
        try {
          await onProgress?.();
          const timeout = AbortSignal.timeout(30_000);
          const response = await client.containers.files.content.retrieve(
            citation.file_id,
            { container_id: citation.container_id },
            { signal: graph.signal ? AbortSignal.any([graph.signal, timeout]) : timeout },
          );
          const buffer = await readFileContent(response, limit);
          const filename = path.posix.basename(citation.filename.replace(/\\/g, '/'));
          const file_id = randomUUID();
          const image = await getImageMetadata(buffer, filename);
          const source = image ? (imageSource ?? defaultSource) : defaultSource;
          const { saveBuffer } = getStrategyFunctions(source);
          if (!saveBuffer) {
            throw new Error(`File storage is unavailable for strategy ${source}`);
          }
          const type = image?.type ?? (inferMimeType(filename, '') || 'application/octet-stream');
          const extension = image
            ? `.${type.slice('image/'.length)}`
            : path
                .extname(filename)
                .replace(/[^.a-zA-Z0-9]/g, '')
                .slice(0, 16);
          const filepath = await saveBuffer({
            userId: user.id,
            tenantId: user.tenantId,
            buffer,
            fileName: `${file_id}${extension}`,
            basePath: image ? 'images' : 'uploads',
          });
          const file = await createFile(
            {
              file_id,
              filename,
              filepath,
              type,
              ...(image && { width: image.width, height: image.height }),
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
          await onError?.();
          processed.delete(key);
          logger.error('[OpenAI Code Interpreter] Failed to save output file', error);
        }
      }
    },
  };
}
