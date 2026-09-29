import { Readable } from 'node:stream';
import { Types } from 'mongoose';
import { CustomOpenAIClient } from '@librechat/agents';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { TMessage } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { collectRestorableFileIds, restoreContainerFiles } from './restoration';

const owner = new Types.ObjectId();
const ownerId = owner.toString();
const conversationId = 'conversation-1';

function message(
  messageId: string,
  parentMessageId: string | null,
  isCreatedByUser: boolean,
  fileIds: string[] = [],
  attachmentIds: string[] = [],
  targetConversationId = conversationId,
): TMessage {
  return {
    messageId,
    parentMessageId,
    conversationId: targetConversationId,
    isCreatedByUser,
    text: messageId,
    files: fileIds.map((file_id) => ({ file_id })),
    attachments: attachmentIds.map((file_id) => ({
      file_id,
      messageId,
      toolCallId: `tool-${messageId}`,
      conversationId: targetConversationId,
    })),
  } as TMessage;
}

function storedFile(
  file_id: string,
  filename: string,
  overrides: Partial<IMongoFile> = {},
): IMongoFile {
  return {
    user: owner,
    tenantId: 'tenant-1',
    conversationId,
    file_id,
    bytes: 5,
    filename,
    filepath: `/storage/${file_id}`,
    object: 'file',
    type: 'application/octet-stream',
    usage: 0,
    source: FileSources.local,
    context: FileContext.message_attachment,
    ...overrides,
  } as IMongoFile;
}

function request(tenantId = 'tenant-1'): ServerRequest {
  return { user: { id: ownerId, tenantId } } as ServerRequest;
}

interface RemoteFile {
  id: string;
  bytes: number;
  path: string;
  content?: Buffer;
}

function openAIClient(remoteByContainer: Map<string, RemoteFile[]> = new Map()) {
  const uploads: Array<{ containerId: string; name: string; bytes: Buffer }> = [];
  let failUploads = false;
  let failLists = false;
  const fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const parts = parsed.pathname.split('/');
    const containerIndex = parts.indexOf('containers');
    const containerId = parts[containerIndex + 1];
    if ((init?.method ?? 'GET') === 'GET') {
      const remoteFiles = remoteByContainer.get(containerId) ?? [];
      if (parts[parts.length - 1] === 'content') {
        const remote = remoteFiles.find(({ id }) => id === parts[parts.length - 2]);
        if (!remote?.content) return new Response('missing', { status: 404 });
        return new Response(new Uint8Array(remote.content));
      }
      if (failLists) {
        return new Response(JSON.stringify({ error: { message: 'not authorized' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      const data = remoteFiles.map(({ id, bytes, path }) => ({ id, bytes, path }));
      return new Response(
        JSON.stringify({ object: 'list', data, first_id: null, last_id: null, has_more: false }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (failUploads) {
      return new Response(JSON.stringify({ error: { message: 'upload failed' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error('Expected multipart upload');
    const uploaded = form.get('file');
    if (!(uploaded instanceof File)) throw new Error('Expected a file upload');
    const bytes = Buffer.from(await uploaded.arrayBuffer());
    uploads.push({ containerId, name: uploaded.name, bytes });
    const created = {
      id: `cfile-${uploads.length}`,
      bytes: bytes.byteLength,
      container_id: containerId,
      created_at: 1,
      object: 'container.file',
      path: `/mnt/data/${uploaded.name}`,
      source: 'user',
    };
    return new Response(JSON.stringify(created), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const client = new CustomOpenAIClient({
    apiKey: 'test-key',
    baseURL: 'https://openai.example/v1',
    fetch,
    maxRetries: 0,
  });
  return {
    client,
    fetch,
    uploads,
    setFailUploads: () => (failUploads = true),
    setFailLists: () => (failLists = true),
  };
}

function restoreParams({
  currentMessages,
  files,
  contents,
  req = request(),
  containerId = 'cntr-current',
  client = openAIClient().client,
}: {
  currentMessages: TMessage[];
  files: IMongoFile[];
  contents: Map<string, Buffer | Error>;
  req?: ServerRequest;
  containerId?: string;
  client?: CustomOpenAIClient;
}) {
  const getDownloadStream = jest.fn(async (_req: ServerRequest, filepath: string) => {
    const content = contents.get(filepath);
    if (content instanceof Error) throw content;
    if (!content) throw new Error(`Missing fixture ${filepath}`);
    return Readable.from([content]);
  });
  return {
    params: {
      client,
      containerId,
      req,
      conversationId,
      currentMessages,
      files,
      getStrategyFunctions: () => ({ getDownloadStream }),
    },
    getDownloadStream,
  };
}

describe('collectRestorableFileIds', () => {
  it('walks only the current ancestor branch and returns newest references first', () => {
    const messages = [
      message('root', null, true, ['source-root']),
      message('old-output', 'root', false, [], ['output-old']),
      message('sibling', 'root', false, [], ['output-sibling']),
      message('current-user', 'old-output', true, ['source-current']),
      message('current-output', 'current-user', false, [], ['output-current']),
    ];

    expect(collectRestorableFileIds(messages, conversationId)).toEqual([
      'output-current',
      'source-current',
      'output-old',
      'source-root',
    ]);
  });
});

describe('restoreContainerFiles', () => {
  it('uploads exact persisted bytes for user sources and bounded recent outputs', async () => {
    const api = openAIClient();
    const messages = [
      message('root', null, true, ['source']),
      message('old-output', 'root', false, [], ['old']),
      message('current-user', 'old-output', true),
      message('latest-output', 'current-user', false, [], ['latest']),
    ];
    const source = storedFile('source', 'source.csv', { bytes: 4, source: FileSources.text });
    const old = storedFile('old', 'old.xlsx', {
      bytes: 3,
      context: FileContext.execute_code,
    });
    const latest = storedFile('latest', 'report.xlsx', {
      bytes: 6,
      context: FileContext.execute_code,
    });
    const contents = new Map<string, Buffer | Error>([
      [source.filepath, Buffer.from([0, 1, 2, 255])],
      [old.filepath, Buffer.from('old')],
      [latest.filepath, Buffer.from('latest')],
    ]);
    const setup = restoreParams({
      currentMessages: messages,
      files: [source, old, latest],
      contents,
      client: api.client,
    });

    const result = await restoreContainerFiles(setup.params);

    expect(api.uploads.map(({ bytes }) => bytes)).toEqual([
      Buffer.from('latest'),
      Buffer.from('old'),
      Buffer.from([0, 1, 2, 255]),
    ]);
    expect(result.restored.map(({ sourceFileId }) => sourceFileId)).toEqual([
      'latest',
      'old',
      'source',
    ]);
    expect(result.restored.every(({ path }) => path.startsWith('/mnt/data/restored-'))).toBe(true);
    expect(result.instructions).toContain(JSON.stringify(result.restored[0].path));
    expect(setup.getDownloadStream).toHaveBeenCalledWith(expect.anything(), old.filepath);
  });

  it('keeps a document and a later image available for a following composition turn', async () => {
    const api = openAIClient();
    const messages = [
      message('root', null, true),
      message('document-turn', 'root', false, [], ['document']),
      message('image-request', 'document-turn', true),
      message('image-turn', 'image-request', false, [], ['image']),
      message('compose-request', 'image-turn', true),
    ];
    const document = storedFile('document', 'report.docx', {
      bytes: 4,
      context: FileContext.execute_code,
    });
    const image = storedFile('image', 'chart.png', {
      bytes: 3,
      context: FileContext.execute_code,
      type: 'image/png',
    });
    const setup = restoreParams({
      currentMessages: messages,
      files: [document, image],
      contents: new Map([
        [document.filepath, Buffer.from('docx')],
        [image.filepath, Buffer.from('png')],
      ]),
      client: api.client,
    });

    const result = await restoreContainerFiles(setup.params);

    expect(result.restored.map(({ sourceFileId }) => sourceFileId)).toEqual(['image', 'document']);
    expect(result.instructions).toContain('report.docx');
    expect(result.instructions).toContain('chart.png');
  });

  it('rejects returned records outside the authenticated owner, tenant or conversation scope', async () => {
    const otherOwner = new Types.ObjectId();
    const messages = [message('root', null, true, ['owner', 'tenant', 'branch', 'unscoped'])];
    const files = [
      storedFile('owner', 'owner.csv', { user: otherOwner }),
      storedFile('tenant', 'tenant.csv', { tenantId: 'tenant-2' }),
      storedFile('branch', 'branch.csv', { conversationId: 'conversation-2' }),
      storedFile('unscoped', 'unscoped.csv', { conversationId: undefined, tenantId: 'tenant-1' }),
    ];
    const contents = new Map<string, Buffer | Error>([[files[3].filepath, Buffer.from('valid')]]);
    const setup = restoreParams({ currentMessages: messages, files, contents });

    const result = await restoreContainerFiles(setup.params);

    expect(result.restored.map(({ sourceFileId }) => sourceFileId)).toEqual(['unscoped']);
    expect(result.unavailable.filter(({ reason }) => reason === 'scope-mismatch')).toHaveLength(3);
    expect(setup.getDownloadStream).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest file when a filename was reused', async () => {
    const api = openAIClient();
    const messages = [
      message('root', null, true, ['source-version']),
      message('output', 'root', false, [], ['output-version']),
    ];
    const source = storedFile('source-version', 'report.xlsx', { bytes: 3 });
    const output = storedFile('output-version', 'report.xlsx', {
      bytes: 3,
      context: FileContext.execute_code,
    });
    const setup = restoreParams({
      currentMessages: messages,
      files: [source, output],
      contents: new Map<string, Buffer | Error>([
        [source.filepath, Buffer.from('old')],
        [output.filepath, Buffer.from('new')],
      ]),
      client: api.client,
    });

    const result = await restoreContainerFiles(setup.params);

    expect(api.uploads).toHaveLength(1);
    expect(api.uploads[0].bytes).toEqual(Buffer.from('new'));
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ sourceFileId: 'source-version', reason: 'superseded-filename' }),
    );
  });

  it('prefers a newer user source over an older assistant output with the same filename', async () => {
    const api = openAIClient();
    const messages = [
      message('root', null, true),
      message('output', 'root', false, [], ['output-version']),
      message('user-edit', 'output', true, ['user-version']),
    ];
    const output = storedFile('output-version', 'report.xlsx', {
      bytes: 3,
      context: FileContext.execute_code,
    });
    const user = storedFile('user-version', 'report.xlsx', { bytes: 3 });
    const setup = restoreParams({
      currentMessages: messages,
      files: [output, user],
      contents: new Map([
        [output.filepath, Buffer.from('old')],
        [user.filepath, Buffer.from('new')],
      ]),
      client: api.client,
    });

    const result = await restoreContainerFiles(setup.params);

    expect(result.restored.map(({ sourceFileId }) => sourceFileId)).toEqual(['user-version']);
    expect(api.uploads[0].bytes).toEqual(Buffer.from('new'));
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ sourceFileId: 'output-version', reason: 'superseded-filename' }),
    );
  });

  it('enforces metadata, streamed and aggregate size limits', async () => {
    const messages = [message('root', null, true, ['metadata-large', 'stream-large', 'aggregate'])];
    const metadataLarge = storedFile('metadata-large', 'large.csv', { bytes: 11 });
    const streamLarge = storedFile('stream-large', 'stream.csv', { bytes: 2 });
    const aggregate = storedFile('aggregate', 'aggregate.csv', { bytes: 8 });
    const setup = restoreParams({
      currentMessages: messages,
      files: [metadataLarge, streamLarge, aggregate],
      contents: new Map([
        [streamLarge.filepath, Buffer.alloc(11)],
        [aggregate.filepath, Buffer.alloc(8)],
      ]),
    });

    const result = await restoreContainerFiles({
      ...setup.params,
      maxFileBytes: 10,
      maxTotalBytes: 7,
    });

    expect(result.restored).toHaveLength(0);
    expect(result.unavailable).toContainEqual(
      expect.objectContaining({ sourceFileId: 'metadata-large', reason: 'size-limit' }),
    );
    expect(result.unavailable).toContainEqual(
      expect.objectContaining({ sourceFileId: 'stream-large', reason: 'size-limit' }),
    );
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ sourceFileId: 'aggregate', reason: 'total-size-limit' }),
    );
  });

  it('reports missing, expired, non-byte, download and upload failures without inventing paths', async () => {
    const api = openAIClient();
    api.setFailUploads();
    const messages = [
      message('root', null, true, ['missing', 'expired', 'rag', 'download', 'upload']),
    ];
    const expired = storedFile('expired', 'expired.csv', {
      expiresAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    const rag = storedFile('rag', 'rag.pdf', { source: FileSources.vectordb });
    const download = storedFile('download', 'download.csv');
    const upload = storedFile('upload', 'upload.csv');
    const setup = restoreParams({
      currentMessages: messages,
      files: [expired, rag, download, upload],
      contents: new Map<string, Buffer | Error>([
        [download.filepath, new Error('storage unavailable')],
        [upload.filepath, Buffer.from('bytes')],
      ]),
      client: api.client,
    });

    const result = await restoreContainerFiles({
      ...setup.params,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });

    expect(result.unavailable.map(({ sourceFileId, reason }) => [sourceFileId, reason])).toEqual(
      expect.arrayContaining([
        ['missing', 'record-missing'],
        ['expired', 'expired'],
        ['rag', 'source-unavailable'],
        ['download', 'download-failed'],
        ['upload', 'upload-failed'],
      ]),
    );
    expect(result.instructions).toContain('Do not invent unavailable file contents or paths');
    expect(result.instructions).not.toContain('/mnt/data/');
  });

  it('reuses content verified in the same container but uploads again after container expiration', async () => {
    const firstApi = openAIClient();
    const messages = [message('root', null, true, ['source'])];
    const source = storedFile('source', 'source.csv');
    const contents = new Map([[source.filepath, Buffer.from('bytes')]]);
    const firstSetup = restoreParams({
      currentMessages: messages,
      files: [source],
      contents,
      containerId: 'cntr-old',
      client: firstApi.client,
    });
    const first = await restoreContainerFiles(firstSetup.params);
    const restored = first.restored[0];
    const uploadName = restored.path.split('/').pop();
    const remote = new Map<string, RemoteFile[]>([
      [
        'cntr-old',
        [
          {
            id: restored.containerFileId,
            bytes: restored.bytes,
            path: `/mnt/data/provider-prefix-${uploadName}`,
            content: Buffer.from('bytes'),
          },
        ],
      ],
    ]);
    const secondApi = openAIClient(remote);
    const cachedSetup = restoreParams({
      currentMessages: messages,
      files: [source],
      contents,
      containerId: 'cntr-old',
      client: secondApi.client,
    });
    const cached = await restoreContainerFiles(cachedSetup.params);
    const replacementSetup = restoreParams({
      currentMessages: messages,
      files: [source],
      contents,
      containerId: 'cntr-new',
      client: secondApi.client,
    });
    const replacement = await restoreContainerFiles(replacementSetup.params);

    expect(cached.restored[0]).toEqual(expect.objectContaining({ cached: true }));
    expect(replacement.restored[0]).toEqual(expect.objectContaining({ cached: false }));
    expect(secondApi.uploads).toHaveLength(1);
    expect(secondApi.uploads[0].containerId).toBe('cntr-new');
  });

  it('does not reuse a same-size remote file whose content was mutated', async () => {
    const firstApi = openAIClient();
    const messages = [message('root', null, true, ['source'])];
    const source = storedFile('source', 'source.csv');
    const contents = new Map([[source.filepath, Buffer.from('bytes')]]);
    const firstSetup = restoreParams({
      currentMessages: messages,
      files: [source],
      contents,
      client: firstApi.client,
    });
    const first = await restoreContainerFiles(firstSetup.params);
    const restored = first.restored[0];
    const mutatedRemote = new Map<string, RemoteFile[]>([
      [
        'cntr-current',
        [
          {
            id: restored.containerFileId,
            bytes: restored.bytes,
            path: restored.path,
            content: Buffer.from('other'),
          },
        ],
      ],
    ]);
    const secondApi = openAIClient(mutatedRemote);
    const secondSetup = restoreParams({
      currentMessages: messages,
      files: [source],
      contents,
      client: secondApi.client,
    });

    const result = await restoreContainerFiles(secondSetup.params);

    expect(result.restored[0]).toEqual(expect.objectContaining({ cached: false }));
    expect(secondApi.uploads).toHaveLength(1);
    expect(secondApi.uploads[0].bytes).toEqual(Buffer.from('bytes'));
  });

  it('reuploads when a listed cache entry disappears before content verification', async () => {
    const firstApi = openAIClient();
    const messages = [message('root', null, true, ['source'])];
    const source = storedFile('source', 'source.csv');
    const contents = new Map([[source.filepath, Buffer.from('bytes')]]);
    const firstSetup = restoreParams({
      currentMessages: messages,
      files: [source],
      contents,
      client: firstApi.client,
    });
    const first = await restoreContainerFiles(firstSetup.params);
    const restored = first.restored[0];
    const vanishedRemote = new Map<string, RemoteFile[]>([
      [
        'cntr-current',
        [{ id: restored.containerFileId, bytes: restored.bytes, path: restored.path }],
      ],
    ]);
    const secondApi = openAIClient(vanishedRemote);
    const secondSetup = restoreParams({
      currentMessages: messages,
      files: [source],
      contents,
      client: secondApi.client,
    });

    const result = await restoreContainerFiles(secondSetup.params);

    expect(result.restored[0]).toEqual(expect.objectContaining({ cached: false }));
    expect(secondApi.uploads).toHaveLength(1);
  });

  it('propagates provider list failures and request cancellation', async () => {
    const api = openAIClient();
    api.setFailLists();
    const messages = [message('root', null, true, ['source'])];
    const source = storedFile('source', 'source.csv');
    const setup = restoreParams({
      currentMessages: messages,
      files: [source],
      contents: new Map([[source.filepath, Buffer.from('bytes')]]),
      client: api.client,
    });
    await expect(restoreContainerFiles(setup.params)).rejects.toThrow('not authorized');
    expect(setup.getDownloadStream).not.toHaveBeenCalled();

    const activeApi = openAIClient();
    const controller = new AbortController();
    const cancelled = restoreParams({
      currentMessages: messages,
      files: [source],
      contents: new Map([[source.filepath, Buffer.from('bytes')]]),
      client: activeApi.client,
    });
    cancelled.getDownloadStream.mockImplementationOnce(async () => {
      controller.abort(new DOMException('cancelled', 'AbortError'));
      return Readable.from([Buffer.from('bytes')]);
    });
    await expect(
      restoreContainerFiles({ ...cancelled.params, signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(activeApi.uploads).toHaveLength(0);
  });
});
