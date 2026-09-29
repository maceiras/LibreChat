import os from 'node:os';
import sharp from 'sharp';
import path from 'node:path';
import { model } from 'mongoose';
import { fileSchema } from '@librechat/data-schemas';
import { FileContext, FileSources } from 'librechat-data-provider';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { AIMessageChunk } from '@librechat/agents/langchain/messages';
import { GraphEvents, Providers, StandardGraph } from '@librechat/agents';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ResponseProgress } from 'librechat-data-provider';
import type { SaveBufferParams } from '~/storage/types';
import type { ServerRequest } from '~/types';
import { createResponseProgress } from '../agents/progress';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    imageSource = FileSources.local,
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
    const onProgress = jest.fn();
    const onError = jest.fn();
    const previousHandler = { handle: jest.fn() };
    const expiredAt = new Date('2026-10-01');
    const getStrategyFunctions = jest.fn((_source: string) => ({ saveBuffer }));
    const handler = createOpenAIFileHandler({
      req,
      imageSource,
      handler: previousHandler,
      createFile,
      onFile,
      onProgress,
      onError,
      getStrategyFunctions,
      getRetentionExpiry: async () => ({ expiredAt }),
    });
    const output = new AIMessageChunk({
      content: [
        {
          type: 'text',
          text: '[Download the report](sandbox:/mnt/data/report.csv)',
          annotations: [citation, citation],
        },
      ],
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
      onProgress,
      onError,
      saveBuffer,
      getStrategyFunctions,
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
    expect(test.onProgress).toHaveBeenCalledTimes(1);
    expect(test.onError).not.toHaveBeenCalled();
    expect(test.onProgress.mock.invocationCallOrder[0]).toBeLessThan(
      test.fetch.mock.invocationCallOrder[0],
    );
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

  it.each(['png', 'jpeg', 'gif', 'webp'] as const)(
    'preserves a real %s image and its dimensions for inline rendering after reload',
    async (format) => {
      const buffer = await sharp({
        create: { width: 32, height: 16, channels: 3, background: '#2d6cdf' },
      })
        .toFormat(format)
        .toBuffer();
      const test = setup();
      test.fetch.mockImplementation(async () => new Response(new Uint8Array(buffer)));
      test.output.content = [
        {
          type: 'text',
          text: `![Chart](sandbox:/mnt/data/chart.${format})`,
          annotations: [{ ...citation, filename: `/mnt/data/chart.${format}` }],
        },
      ];

      await test.invoke();

      const file = test.onFile.mock.calls[0][0] as IMongoFile;
      expect(file).toMatchObject({
        type: `image/${format}`,
        width: 32,
        height: 16,
        bytes: buffer.length,
        context: FileContext.code_interpreter,
        source: FileSources.local,
        expiredAt: test.expiredAt,
      });
      expect(test.saveBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          basePath: 'images',
          userId: '507f1f77bcf86cd799439011',
          tenantId: 'school',
          fileName: `${file.file_id}.${format}`,
        }),
      );
      expect(await readFile(file.filepath)).toEqual(buffer);
      const restored = new File(JSON.parse(JSON.stringify(file)));
      await expect(restored.validate()).resolves.toBeUndefined();
      expect(restored.toObject()).toMatchObject({ width: 32, height: 16, type: `image/${format}` });
    },
  );

  it('uses the configured image storage while ordinary files keep their download storage', async () => {
    const buffer = await sharp({
      create: { width: 2, height: 1, channels: 3, background: '#2d6cdf' },
    })
      .png()
      .toBuffer();
    const test = setup({ imageSource: FileSources.s3 });
    test.fetch.mockImplementationOnce(async () => new Response(new Uint8Array(buffer)));
    test.output.content = [
      {
        type: 'text',
        text: '![Chart](sandbox:/mnt/data/chart.png) [Report](sandbox:/mnt/data/report.csv)',
        annotations: [{ ...citation, file_id: 'cfile_image', filename: 'chart.png' }, citation],
      },
    ];

    await test.invoke();

    expect(test.getStrategyFunctions.mock.calls).toEqual([[FileSources.s3], [FileSources.local]]);
    expect(test.onFile.mock.calls.map(([file]: [IMongoFile]) => file.source)).toEqual([
      FileSources.s3,
      FileSources.local,
    ]);
    expect(test.saveBuffer.mock.calls.map(([params]) => params.basePath)).toEqual([
      'images',
      'uploads',
    ]);
  });

  it.each([
    'invalid image bytes',
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16"/></svg>',
  ])('keeps an invalid or unsupported PNG payload downloadable: %s', async (payload) => {
    const test = setup();
    test.fetch.mockImplementation(async () => new Response(payload));
    test.output.content = [
      {
        type: 'text',
        text: '![Chart](sandbox:/mnt/data/chart.png)',
        annotations: [{ ...citation, filename: 'chart.png' }],
      },
    ];

    await expect(test.invoke()).resolves.toBeUndefined();

    const file = test.onFile.mock.calls[0][0] as IMongoFile;
    expect(file.width).toBeUndefined();
    expect(file.height).toBeUndefined();
    expect(file.type).toBe('application/octet-stream');
    expect(test.saveBuffer).toHaveBeenCalledWith(expect.objectContaining({ basePath: 'uploads' }));
    expect(await readFile(file.filepath, 'utf8')).toBe(payload);
  });

  it('accepts the normalized citations returned by the installed LangChain Responses adapter', async () => {
    const test = setup();
    test.output.content = [
      {
        type: 'text',
        text: '[Download the report](sandbox:/mnt/data/report.csv)',
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

  it('keeps only the explicitly linked deliverable and ignores unlinked reports and inspection images', async () => {
    const test = setup();
    test.output.content = [
      {
        type: 'text',
        text: '[Download the deck](sandbox:/mnt/data/marmottes.pptx)',
        annotations: [
          { ...citation, file_id: 'cfile_deck', filename: '/mnt/data/marmottes.pptx' },
          { ...citation, file_id: 'cfile_report', filename: '/mnt/data/render.json' },
          { ...citation, file_id: 'cfile_preview', filename: 'cfile_preview.png' },
        ],
      },
    ];

    await test.invoke();

    expect(test.fetch).toHaveBeenCalledTimes(1);
    expect(String(test.fetch.mock.calls[0][0])).toContain('/files/cfile_deck/content');
    expect(test.onFile).toHaveBeenCalledTimes(1);
    expect(test.onFile.mock.calls[0][0]).toMatchObject({ filename: 'marmottes.pptx' });
  });

  it('keeps explicitly linked JSON and images using a decoded full path or unique basename', async () => {
    const test = setup();
    test.output.content = [
      {
        type: 'text',
        text:
          '[JSON report](sandbox:/mnt/data/reports/My%20Report.json) ' +
          '![Requested image](sandbox:/mnt/data/exports/result.png)',
        annotations: [
          {
            ...citation,
            file_id: 'cfile_json',
            filename: '/mnt/data/reports/My Report.json',
          },
          {
            type: 'citation',
            source: 'container_file_citation',
            title: 'result.png',
            container_id: citation.container_id,
            file_id: 'cfile_image',
          },
        ],
      },
    ];

    await test.invoke();

    expect(test.fetch).toHaveBeenCalledTimes(2);
    expect(test.onFile.mock.calls.map(([file]: [IMongoFile]) => file.filename)).toEqual([
      'My Report.json',
      'result.png',
    ]);
  });

  it('requires an unqualified citation basename to identify one linked path and one citation', async () => {
    const test = setup();
    test.output.content = [
      {
        type: 'text',
        text:
          '[First](sandbox:/mnt/data/first/render.json) ' +
          '[Second](sandbox:/mnt/data/second/render.json)',
        annotations: [{ ...citation, file_id: 'cfile_render', filename: 'render.json' }],
      },
    ];

    await test.invoke();

    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.createFile).not.toHaveBeenCalled();
    expect(test.onFile).not.toHaveBeenCalled();
  });

  it('uses a valid full path to select one of several citations with the same basename', async () => {
    const test = setup();
    test.output.content = [
      {
        type: 'text',
        text: '[Approved](sandbox:/mnt/data/approved/report.json)',
        annotations: [
          {
            ...citation,
            file_id: 'cfile_approved',
            filename: '/mnt/data/approved/report.json',
          },
          {
            ...citation,
            file_id: 'cfile_internal',
            filename: '/mnt/data/internal/report.json',
          },
          { ...citation, file_id: 'cfile_bare', filename: 'report.json' },
        ],
      },
    ];

    await test.invoke();

    expect(test.fetch).toHaveBeenCalledTimes(1);
    expect(String(test.fetch.mock.calls[0][0])).toContain('/files/cfile_approved/content');
  });

  it('does not treat plain paths, code output, or external URLs as delivered files', async () => {
    const test = setup();
    test.output.content = [
      {
        type: 'text',
        text:
          '`sandbox:/mnt/data/report.csv`\n' +
          '`[Inline example](sandbox:/mnt/data/report.csv)`\n' +
          '```markdown\n[Fenced example](sandbox:/mnt/data/report.csv)\n```\n' +
          '    [Indented example](sandbox:/mnt/data/report.csv)\n' +
          '\\[Escaped example](sandbox:/mnt/data/report.csv)\n' +
          '[Missing close](sandbox:/mnt/data/report.csv\n' +
          '[External](https://example.test/sandbox:/mnt/data/report.csv)',
        annotations: [citation],
      },
    ];

    await test.invoke();

    expect(test.fetch).not.toHaveBeenCalled();
  });

  it('does not guess when two citations claim the same explicit full path', async () => {
    const test = setup();
    test.output.content = [
      {
        type: 'text',
        text: '[Report](sandbox:/mnt/data/report.csv)',
        annotations: [citation, { ...citation, file_id: 'cfile_duplicate' }],
      },
    ];

    await test.invoke();

    expect(test.fetch).not.toHaveBeenCalled();
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

  describe('sequential-agent visibility', () => {
    it('does not fetch, persist, or publish files from a hidden intermediate agent', async () => {
      const test = setup();

      await test.handler.handle(
        GraphEvents.CHAT_MODEL_END,
        { output: test.output },
        {
          ...metadata,
          last_agent_id: 'final-agent',
          hide_sequential_outputs: true,
        },
        test.graph,
      );

      expect(test.previousHandler.handle).toHaveBeenCalledTimes(1);
      expect(test.fetch).not.toHaveBeenCalled();
      expect(test.onProgress).not.toHaveBeenCalled();
      expect(test.saveBuffer).not.toHaveBeenCalled();
      expect(test.createFile).not.toHaveBeenCalled();
      expect(test.onFile).not.toHaveBeenCalled();
      expect(test.onError).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', {}],
      ['empty', { last_agent_id: '' }],
    ] as const)(
      'fails closed when hidden sequential output has a %s last_agent_id',
      async (_case, metadataOverride) => {
        const test = setup();

        await test.handler.handle(
          GraphEvents.CHAT_MODEL_END,
          { output: test.output },
          {
            ...metadata,
            ...metadataOverride,
            hide_sequential_outputs: true,
          },
          test.graph,
        );

        expect(test.previousHandler.handle).toHaveBeenCalledTimes(1);
        expect(test.fetch).not.toHaveBeenCalled();
        expect(test.onProgress).not.toHaveBeenCalled();
        expect(test.saveBuffer).not.toHaveBeenCalled();
        expect(test.createFile).not.toHaveBeenCalled();
        expect(test.onFile).not.toHaveBeenCalled();
        expect(test.onError).not.toHaveBeenCalled();
      },
    );

    it('persists files from the last agent when sequential outputs are hidden', async () => {
      const test = setup();

      await test.handler.handle(
        GraphEvents.CHAT_MODEL_END,
        { output: test.output },
        {
          ...metadata,
          last_agent_id: 'agent',
          hide_sequential_outputs: true,
        },
        test.graph,
      );

      expect(test.fetch).toHaveBeenCalledTimes(1);
      expect(test.createFile).toHaveBeenCalledTimes(1);
      expect(test.onFile).toHaveBeenCalledTimes(1);
    });

    it('persists files from an intermediate agent when sequential outputs are visible', async () => {
      const test = setup();

      await test.handler.handle(
        GraphEvents.CHAT_MODEL_END,
        { output: test.output },
        {
          ...metadata,
          last_agent_id: 'final-agent',
          hide_sequential_outputs: false,
        },
        test.graph,
      );

      expect(test.fetch).toHaveBeenCalledTimes(1);
      expect(test.createFile).toHaveBeenCalledTimes(1);
      expect(test.onFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('response progress lifecycle', () => {
    it('waits for every visible file and reports an incomplete response after a partial failure', async () => {
      const test = setup();
      const snapshots: ResponseProgress[] = [];
      const secondDownload = deferred<Response>();
      const secondStarted = deferred<void>();
      let time = 1_000;
      const progress = createResponseProgress(
        (snapshot) => {
          snapshots.push(snapshot);
        },
        () => time,
      );
      progress.bind(metadata.run_id, new AbortController().signal);
      await progress.stage('preparing');
      test.onProgress.mockImplementation(() => progress.stage('files'));
      test.onError.mockImplementation(() => progress.markIncomplete());
      test.fetch
        .mockImplementationOnce(async () => new Response('expired', { status: 404 }))
        .mockImplementationOnce(() => {
          secondStarted.resolve();
          return secondDownload.promise;
        });
      test.output.content = [
        {
          type: 'text',
          text: '[Expired](sandbox:/mnt/data/expired.csv) [Ready](sandbox:/mnt/data/ready.csv)',
          annotations: [
            { ...citation, file_id: 'cfile_expired', filename: '/mnt/data/expired.csv' },
            { ...citation, file_id: 'cfile_ready', filename: '/mnt/data/ready.csv' },
          ],
        },
      ];

      const invocation = test.handler.handle(
        GraphEvents.CHAT_MODEL_END,
        { output: test.output },
        {
          ...metadata,
          last_agent_id: 'final-agent',
          hide_sequential_outputs: false,
        },
        test.graph,
      );
      await secondStarted.promise;

      expect(progress.snapshot()).toMatchObject({ status: 'running' });
      expect(progress.snapshot()?.endedAt).toBeUndefined();
      time = 2_000;
      await progress.stage('responding');
      expect(progress.snapshot()?.steps.map((step) => step.stage)).toEqual([
        'preparing',
        'files',
        'responding',
      ]);

      secondDownload.resolve(new Response('a,b\n1,2\n'));
      await invocation;

      expect(test.onError).toHaveBeenCalledTimes(1);
      expect(test.onFile).toHaveBeenCalledTimes(1);
      expect(test.onFile.mock.calls[0][0]).toMatchObject({ filename: 'ready.csv' });
      expect(progress.snapshot()).toMatchObject({ status: 'running' });
      time = 3_000;
      await progress.finish('completed');
      expect(progress.snapshot()).toMatchObject({ status: 'incomplete', endedAt: 3_000 });
      expect(snapshots[snapshots.length - 1]).toMatchObject({
        status: 'incomplete',
        endedAt: 3_000,
      });
    });

    it('keeps cancellation terminal when a file download rejects after abort', async () => {
      const test = setup();
      const controller = new AbortController();
      const downloadStarted = deferred<void>();
      const progress = createResponseProgress(jest.fn());
      progress.bind(metadata.run_id, controller.signal);
      test.graph.signal = controller.signal;
      test.onProgress.mockImplementation(() => progress.stage('files'));
      test.onError.mockImplementation(() => progress.markIncomplete());
      test.fetch.mockImplementation(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            downloadStarted.resolve();
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new Error('aborted')),
              { once: true },
            );
          }),
      );

      const invocation = test.invoke();
      await downloadStarted.promise;
      controller.abort();
      await invocation;

      expect(test.onError).toHaveBeenCalledTimes(1);
      expect(progress.snapshot()?.status).toBe('cancelled');
      await progress.finish('completed');
      expect(progress.snapshot()?.status).toBe('cancelled');
    });
  });

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
      expect.arrayContaining([
        expect.objectContaining({
          text: '[Download the report](sandbox:/mnt/data/report.csv)',
        }),
      ]),
    );
  });

  it('does not use basename fallback for a citation containing path traversal', async () => {
    const test = setup();
    test.output.content = [
      {
        type: 'text',
        text: '[Download](sandbox:/mnt/data/outside.csv)',
        annotations: [{ ...citation, filename: '../../outside.csv' }],
      },
    ];
    await test.invoke();
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.saveBuffer).not.toHaveBeenCalled();
    expect(test.onFile).not.toHaveBeenCalled();
  });
});
