import os from 'node:os';
import path from 'node:path';
import { model } from 'mongoose';
import { fileSchema } from '@librechat/data-schemas';
import { FileContext, FileSources } from 'librechat-data-provider';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { AIMessageChunk } from '@librechat/agents/langchain/messages';
import { GraphEvents, Providers, StandardGraph } from '@librechat/agents';
import type { IMongoFile } from '@librechat/data-schemas';
import type { SaveBufferParams } from '~/storage/types';
import type { ServerRequest } from '~/types';
import { createOpenAIFileHandler } from './openai';

const File = model<IMongoFile>('OpenAIOutputTest', fileSchema);
const citation = {
  type: 'container_file_citation',
  container_id: 'cntr_test',
  file_id: 'cfile_test',
  filename: '/mnt/data/report.csv',
};
const metadata = {
  run_id: 'response-message',
  thread_id: 'conversation',
  langgraph_node: 'agent=agent',
};

describe('Responses container files', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'openai-output-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function setup({
    limit = 20,
    status = 200,
    provider = Providers.OPENAI,
    useResponsesApi = true,
  } = {}) {
    const fetch = jest.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('a,b\n1,2\n', { status }),
    );
    const graph = new StandardGraph({
      agents: [
        {
          agentId: 'agent',
          provider,
          clientOptions: {
            apiKey: 'user-key',
            useResponsesApi,
            configuration: {
              baseURL: 'https://openai.example/v1',
              fetch,
              defaultHeaders: { 'X-Gateway': 'configured' },
            },
          },
        },
      ],
    });
    const req = {
      user: { id: '507f1f77bcf86cd799439011', tenantId: 'school' } as NonNullable<
        ServerRequest['user']
      >,
      config: {
        config: {},
        imageOutputType: 'png',
        fileStrategy: FileSources.local,
        fileConfig: { endpoints: { openAI: { fileSizeLimit: limit } } },
      } as NonNullable<ServerRequest['config']>,
    } as ServerRequest;
    const saveBuffer = jest.fn(async ({ buffer, fileName }: SaveBufferParams) => {
      const filepath = path.join(directory, fileName);
      await writeFile(filepath, buffer);
      return filepath;
    });
    const createFile = jest.fn(async (data: Partial<IMongoFile>) => {
      const document = new File(data);
      await document.validate();
      return document.toObject();
    });
    const onFile = jest.fn();
    const previousHandler = { handle: jest.fn() };
    const expiredAt = new Date('2026-10-01');
    const handler = createOpenAIFileHandler({
      req,
      handler: previousHandler,
      createFile,
      onFile,
      getStrategyFunctions: () => ({ saveBuffer }),
      getRetentionExpiry: async () => ({ expiredAt }),
    });
    const output = new AIMessageChunk({
      content: [{ type: 'text', text: 'Download the report.', annotations: [citation, citation] }],
    });
    const invoke = () => handler.handle(GraphEvents.CHAT_MODEL_END, { output }, metadata, graph);
    return {
      handler,
      graph,
      fetch,
      output,
      invoke,
      createFile,
      onFile,
      saveBuffer,
      previousHandler,
      expiredAt,
    };
  }

  it('downloads once with the producing client credentials, stores bytes, and emits an owned retained file', async () => {
    const test = setup();
    await test.invoke();
    await test.invoke();
    expect(test.previousHandler.handle).toHaveBeenCalledTimes(2);
    expect(test.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = test.fetch.mock.calls[0];
    expect(String(url)).toBe(
      'https://openai.example/v1/containers/cntr_test/files/cfile_test/content',
    );
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer user-key');
    expect(headers.get('x-gateway')).toBe('configured');
    expect(test.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'report.csv',
        context: FileContext.code_interpreter,
        source: FileSources.local,
        tenantId: 'school',
        messageId: metadata.run_id,
        conversationId: metadata.thread_id,
        expiredAt: test.expiredAt,
        bytes: 8,
      }),
      true,
    );
    const file = test.onFile.mock.calls[0][0] as IMongoFile;
    expect(String(file.user)).toBe('507f1f77bcf86cd799439011');
    expect(file.file_id).not.toBe(citation.file_id);
    expect(await readFile(file.filepath, 'utf8')).toBe('a,b\n1,2\n');
  });

  it('accepts the normalized citations returned by the installed LangChain Responses adapter', async () => {
    const test = setup();
    test.output.content = [
      {
        type: 'text',
        text: '',
        annotations: [
          {
            type: 'citation',
            source: 'container_file_citation',
            title: citation.filename,
            container_id: citation.container_id,
            file_id: citation.file_id,
          },
        ],
      },
    ];
    await test.invoke();
    expect(test.onFile).toHaveBeenCalledTimes(1);
  });

  it.each([{ provider: Providers.ANTHROPIC }, { useResponsesApi: false }])(
    'ignores non-Responses output: %j',
    async (options) => {
      const test = setup(options);
      await test.invoke();
      expect(test.fetch).not.toHaveBeenCalled();
      expect(test.previousHandler.handle).toHaveBeenCalledTimes(1);
    },
  );

  it('ignores text links and non-container or malformed annotations', async () => {
    const test = setup();
    test.output.content = [
      {
        type: 'text',
        text: '[fake](sandbox:/mnt/data/fake.csv)',
        annotations: [
          { type: 'file_citation', file_id: 'file_test' },
          { ...citation, container_id: '../other' },
        ],
      },
    ];
    await test.invoke();
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it('bounds streamed bytes even without Content-Length', async () => {
    const test = setup({ limit: 0.000001 });
    await test.invoke();
    expect(test.fetch).toHaveBeenCalledTimes(1);
    expect(test.saveBuffer).not.toHaveBeenCalled();
    expect(test.onFile).not.toHaveBeenCalled();
  });

  it('preserves the answer and usage handler when a remote file has expired', async () => {
    const test = setup({ status: 404 });
    await expect(test.invoke()).resolves.toBeUndefined();
    expect(test.previousHandler.handle).toHaveBeenCalledTimes(1);
    expect(test.onFile).not.toHaveBeenCalled();
    expect(test.output.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Download the report.' })]),
    );
  });

  it('uses an opaque storage name even for path traversal in the filename', async () => {
    const test = setup();
    test.output.content = [
      { type: 'text', text: '', annotations: [{ ...citation, filename: '../../outside.csv' }] },
    ];
    await test.invoke();
    const file = test.onFile.mock.calls[0][0] as IMongoFile;
    expect(file.filename).toBe('outside.csv');
    expect(path.dirname(file.filepath)).toBe(directory);
    expect(path.basename(file.filepath)).toMatch(/^[0-9a-f-]+\.csv$/);
  });
});
