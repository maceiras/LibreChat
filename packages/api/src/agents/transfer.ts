import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, addAbortSignal } from 'node:stream';
import { CustomOpenAIClient } from '@librechat/agents';
import type { FileListResponse } from 'openai/resources/containers/files/files';
import type { ReadableStream } from 'node:stream/web';

export type ContainerFile = Pick<FileListResponse, 'id' | 'path' | 'bytes'>;

interface ContainerTransfer {
  client: CustomOpenAIClient;
  containerId: string;
  signal?: AbortSignal;
}

interface TransferContent {
  bytes: number;
  sha256: string;
}

class TransferSizeError extends RangeError {}

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function throwIfAborted(signal?: AbortSignal, error?: unknown): void {
  signal?.throwIfAborted();
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  ) {
    throw error;
  }
}

/** Read storage or provider bytes with a hard limit and cancellation of stalled streams. */
export async function readTransferBuffer(
  stream: NodeJS.ReadableStream,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const source = stream as Readable;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    throwIfAborted(signal);
    if (signal) addAbortSignal(signal, source);
    for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
      throwIfAborted(signal);
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      if (bytes > limit) throw new TransferSizeError(`Transfer exceeds ${limit} bytes`);
      chunks.push(buffer);
    }
    throwIfAborted(signal);
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    throwIfAborted(signal, error);
    throw error;
  } finally {
    source.destroy();
  }
}

export async function listContainerFiles({
  client,
  containerId,
  signal,
}: ContainerTransfer): Promise<ContainerFile[]> {
  throwIfAborted(signal);
  const pages = client.containers.files.list(
    containerId,
    { limit: 100, order: 'desc' },
    { signal },
  );
  const files: ContainerFile[] = [];
  for await (const { id, bytes, path: filepath } of pages) {
    throwIfAborted(signal);
    files.push({ id, bytes, path: filepath });
    if (files.length >= 200) break;
  }
  return files;
}

/** Missing or corrupt content is a cache miss; provider and cancellation errors propagate. */
export async function verifyContainerFile(
  { client, containerId, signal }: ContainerTransfer,
  fileId: string,
  expected: TransferContent,
): Promise<boolean> {
  throwIfAborted(signal);
  try {
    const response = await client.containers.files.content.retrieve(
      fileId,
      { container_id: containerId },
      { signal },
    );
    if (!response.body) return false;
    const body = response.body as typeof response.body & ReadableStream<Uint8Array>;
    const stream = Readable.fromWeb(body);
    const content = await readTransferBuffer(stream, expected.bytes, signal);
    return content.length === expected.bytes && sha256(content) === expected.sha256;
  } catch (error) {
    throwIfAborted(signal, error);
    if (error instanceof TransferSizeError) return false;
    if (error instanceof CustomOpenAIClient.APIError && error.status === 404) return false;
    throw error;
  }
}

export async function findVerifiedContainerFile(
  transfer: ContainerTransfer,
  files: ContainerFile[],
  filename: string,
  expected: TransferContent,
): Promise<ContainerFile | undefined> {
  for (const file of files) {
    const name = path.posix.basename(file.path.replace(/\\/g, '/'));
    if (file.bytes !== expected.bytes || (name !== filename && !name.endsWith(`-${filename}`)))
      continue;
    if (await verifyContainerFile(transfer, file.id, expected)) return file;
  }
}
