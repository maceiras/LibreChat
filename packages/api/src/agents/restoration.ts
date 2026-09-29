import path from 'node:path';
import { FileSources } from 'librechat-data-provider';
import type { CustomOpenAIClient } from '@librechat/agents';
import type { IMongoFile } from '@librechat/data-schemas';
import type { TMessage } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import {
  findVerifiedContainerFile,
  listContainerFiles,
  readTransferBuffer,
  sha256,
  throwIfAborted,
} from './transfer';

const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const RESTORED_PREFIX = 'restored';
const nonByteSources = new Set<string>([FileSources.vectordb, FileSources.document_parser]);

export interface RestoreContainerFilesParams {
  client: CustomOpenAIClient;
  containerId: string;
  signal?: AbortSignal;
  req: ServerRequest;
  conversationId: string;
  currentMessages: TMessage[];
  /** Files loaded by the caller with an owner, tenant and conversation-scoped query. */
  files: IMongoFile[];
  getStrategyFunctions: (source: string) => {
    getDownloadStream?: (req: ServerRequest, filepath: string) => Promise<NodeJS.ReadableStream>;
  };
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  now?: () => number;
}

export interface RestoredContainerFile {
  sourceFileId: string;
  containerFileId: string;
  filename: string;
  path: string;
  bytes: number;
  cached: boolean;
}

export interface UnavailableContainerFile {
  sourceFileId: string;
  filename?: string;
  reason:
    | 'record-missing'
    | 'scope-mismatch'
    | 'expired'
    | 'source-unavailable'
    | 'size-limit'
    | 'download-failed'
    | 'upload-failed';
}

export interface SkippedContainerFile {
  sourceFileId: string;
  filename?: string;
  reason: 'superseded-filename' | 'file-limit' | 'total-size-limit';
}

export interface RestoreContainerFilesResult {
  restored: RestoredContainerFile[];
  unavailable: UnavailableContainerFile[];
  skipped: SkippedContainerFile[];
  instructions: string;
}

function messageFiles(message: TMessage): object[] {
  const files: object[] = [];
  for (const file of message.files ?? []) files.push(file);
  for (const attachment of message.attachments ?? []) files.push(attachment);
  return files;
}

function fileId(file: object): string | undefined {
  if (!('file_id' in file) || typeof file.file_id !== 'string' || !file.file_id) return;
  return file.file_id;
}

/** Returns file references from the current ancestor branch, newest first. */
export function collectRestorableFileIds(
  currentMessages: TMessage[],
  conversationId: string,
): string[] {
  const messageMap = new Map<string, TMessage>();
  let last: TMessage | undefined;
  for (const message of currentMessages) {
    if (message.conversationId !== conversationId) continue;
    messageMap.set(message.messageId, message);
    last = message;
  }

  const messages: TMessage[] = [];
  const visited = new Set<string>();
  let current = last;
  while (current && !visited.has(current.messageId)) {
    visited.add(current.messageId);
    messages.push(current);
    current = current.parentMessageId ? messageMap.get(current.parentMessageId) : undefined;
  }

  const fileIds: string[] = [];
  const seenFileIds = new Set<string>();
  for (const message of messages) {
    for (const file of messageFiles(message)) {
      const id = fileId(file);
      if (!id) continue;
      if (!seenFileIds.has(id)) {
        seenFileIds.add(id);
        fileIds.push(id);
      }
    }
  }

  return fileIds;
}

function scopeMatches(file: IMongoFile, req: ServerRequest, conversationId: string): boolean {
  if (!req.user || String(file.user) !== req.user.id) return false;
  if ((file.tenantId ?? '') !== (req.user.tenantId ?? '')) return false;
  return file.conversationId == null || file.conversationId === conversationId;
}

function timestamp(value: Date | string | undefined): number | undefined {
  if (value == null) return;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isExpired(file: IMongoFile, now: number): boolean {
  const retentionExpiry = timestamp(file.expiredAt ?? undefined);
  const uploadExpiry = timestamp(file.expiresAt);
  return (
    (retentionExpiry !== undefined && retentionExpiry <= now) ||
    (uploadExpiry !== undefined && uploadExpiry <= now)
  );
}

function safeFilename(filename: string): string {
  const basename = path.posix.basename(filename.replace(/\\/g, '/'));
  let cleaned = '';
  for (const character of basename) {
    const code = character.codePointAt(0) ?? 0;
    cleaned += code <= 31 || code === 127 ? '_' : character;
  }
  cleaned = cleaned.slice(-180);
  return cleaned || 'file';
}

function restoredFilename(filename: string, digest: string): string {
  return `${RESTORED_PREFIX}-${digest.slice(0, 20)}-${safeFilename(filename)}`;
}

function instructionsFor(
  restored: RestoredContainerFile[],
  unavailable: UnavailableContainerFile[],
  skipped: SkippedContainerFile[],
): string {
  const lines = [
    'Persisted conversation files are available in the current Code Interpreter workspace.',
  ];
  if (restored.length > 0) {
    lines.push('Use these exact current-container paths:');
    for (const file of restored) {
      lines.push(`- ${JSON.stringify(file.filename)}: ${JSON.stringify(file.path)}`);
    }
  } else {
    lines.push('No prior conversation file could be restored into this workspace.');
  }
  if (unavailable.length > 0) {
    lines.push('These referenced files are unavailable:');
    for (const file of unavailable) {
      lines.push(`- ${JSON.stringify(file.filename ?? file.sourceFileId)} (${file.reason})`);
    }
    lines.push(
      'Do not invent unavailable file contents or paths; ask the user to provide them again.',
    );
  }
  const limited = skipped.filter(
    (file) => file.reason === 'file-limit' || file.reason === 'total-size-limit',
  );
  if (limited.length > 0) {
    lines.push('These current source files were not restored because of workspace limits:');
    for (const file of limited) {
      lines.push(`- ${JSON.stringify(file.filename ?? file.sourceFileId)} (${file.reason})`);
    }
    lines.push('Ask the user to narrow or reattach them before relying on their contents.');
  }
  return lines.join('\n');
}

/** Restores persisted inputs and recent output versions into an explicit active container. */
export async function restoreContainerFiles({
  client,
  containerId,
  signal,
  req,
  conversationId,
  currentMessages,
  files,
  getStrategyFunctions,
  maxFiles = DEFAULT_MAX_FILES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  now = Date.now,
}: RestoreContainerFilesParams): Promise<RestoreContainerFilesResult> {
  const relevantIds = new Set(collectRestorableFileIds(currentMessages, conversationId));
  const recordsById = new Map<string, IMongoFile>();
  for (const file of files) {
    if (relevantIds.has(file.file_id) && !recordsById.has(file.file_id)) {
      recordsById.set(file.file_id, file);
    }
  }

  const unavailable: UnavailableContainerFile[] = [];
  const skipped: SkippedContainerFile[] = [];
  const candidates: IMongoFile[] = [];
  const candidateNames = new Set<string>();
  const currentTime = now();
  for (const id of relevantIds) {
    const file = recordsById.get(id);
    if (!file) {
      unavailable.push({ sourceFileId: id, reason: 'record-missing' });
      continue;
    }
    if (!scopeMatches(file, req, conversationId)) {
      unavailable.push({ sourceFileId: id, filename: file.filename, reason: 'scope-mismatch' });
      continue;
    }
    const filenameKey = safeFilename(file.filename).toLowerCase();
    if (candidateNames.has(filenameKey)) {
      skipped.push({
        sourceFileId: file.file_id,
        filename: file.filename,
        reason: 'superseded-filename',
      });
      continue;
    }
    candidateNames.add(filenameKey);
    if (isExpired(file, currentTime)) {
      unavailable.push({ sourceFileId: id, filename: file.filename, reason: 'expired' });
      continue;
    }
    if (
      !file.filepath ||
      !file.source ||
      nonByteSources.has(file.source) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    ) {
      unavailable.push({ sourceFileId: id, filename: file.filename, reason: 'source-unavailable' });
      continue;
    }
    if (file.bytes > maxFileBytes) {
      unavailable.push({ sourceFileId: id, filename: file.filename, reason: 'size-limit' });
      continue;
    }
    candidates.push(file);
  }

  const selected: IMongoFile[] = [];
  let selectedBytes = 0;
  for (const file of candidates) {
    if (selected.length >= maxFiles) {
      skipped.push({ sourceFileId: file.file_id, filename: file.filename, reason: 'file-limit' });
      continue;
    }
    if (selectedBytes + file.bytes > maxTotalBytes) {
      skipped.push({
        sourceFileId: file.file_id,
        filename: file.filename,
        reason: 'total-size-limit',
      });
      continue;
    }
    selectedBytes += file.bytes;
    selected.push(file);
  }

  const transfer = { client, containerId, signal };
  const remoteFiles = await listContainerFiles(transfer);
  const restored: RestoredContainerFile[] = [];
  let restoredBytes = 0;
  for (const file of selected) {
    throwIfAborted(signal);
    let buffer: Buffer;
    try {
      const strategy = getStrategyFunctions(file.source);
      if (!strategy.getDownloadStream) {
        unavailable.push({
          sourceFileId: file.file_id,
          filename: file.filename,
          reason: 'source-unavailable',
        });
        continue;
      }
      const stream = await strategy.getDownloadStream(req, file.storageKey || file.filepath);
      throwIfAborted(signal);
      buffer = await readTransferBuffer(stream, maxFileBytes, signal);
    } catch (error) {
      throwIfAborted(signal, error);
      unavailable.push({
        sourceFileId: file.file_id,
        filename: file.filename,
        reason: error instanceof RangeError ? 'size-limit' : 'download-failed',
      });
      continue;
    }
    if (restoredBytes + buffer.byteLength > maxTotalBytes) {
      skipped.push({
        sourceFileId: file.file_id,
        filename: file.filename,
        reason: 'total-size-limit',
      });
      continue;
    }

    const digest = sha256(buffer);
    const uploadName = restoredFilename(file.filename, digest);
    const cached = await findVerifiedContainerFile(transfer, remoteFiles, uploadName, {
      bytes: buffer.byteLength,
      sha256: digest,
    });
    if (cached) {
      restored.push({
        sourceFileId: file.file_id,
        containerFileId: cached.id,
        filename: file.filename,
        path: cached.path,
        bytes: buffer.byteLength,
        cached: true,
      });
      restoredBytes += buffer.byteLength;
      continue;
    }

    try {
      const nameDigest = sha256(uploadName).slice(0, 16);
      const uploaded = await client.containers.files.create(
        containerId,
        { file: new File([new Uint8Array(buffer)], uploadName, { type: file.type }) },
        { signal, idempotencyKey: `${containerId}:${file.file_id}:${digest}:${nameDigest}` },
      );
      restored.push({
        sourceFileId: file.file_id,
        containerFileId: uploaded.id,
        filename: file.filename,
        path: uploaded.path,
        bytes: buffer.byteLength,
        cached: false,
      });
      restoredBytes += buffer.byteLength;
    } catch (error) {
      throwIfAborted(signal, error);
      unavailable.push({
        sourceFileId: file.file_id,
        filename: file.filename,
        reason: 'upload-failed',
      });
    }
  }

  return {
    restored,
    unavailable,
    skipped,
    instructions: instructionsFor(restored, unavailable, skipped),
  };
}
