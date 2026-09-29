import { Types } from 'mongoose';
import { CustomOpenAIClient } from '@librechat/agents';
import type { LCTool } from '@librechat/agents';
import type { ToolExecuteBatchRequest, ToolExecuteResult } from '@librechat/agents';
import type { CommonsImage } from '../images/commons';
import { createToolExecuteHandler } from './handlers';
import {
  IMPORT_COMMONS_IMAGE_TOOL_NAME,
  SEARCH_COMMONS_IMAGES_TOOL_NAME,
  prepareCommonsTools,
} from './commons';

const image: CommonsImage = {
  pageId: 42,
  title: 'File:Matterhorn.jpg',
  description: 'The Matterhorn from Zermatt',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Matterhorn.jpg',
  url: 'https://upload.wikimedia.org/matterhorn.jpg',
  thumbnailUrl: 'https://upload.wikimedia.org/matterhorn-800px.jpg',
  width: 4000,
  height: 3000,
  author: 'Example Photographer',
  credit: 'Photo: Example Photographer',
  license: 'CC BY-SA 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  attribution: 'Example Photographer / CC BY-SA 4.0',
  attributionRequired: true,
};

function fixture() {
  const skillId = new Types.ObjectId();
  const bytes = Buffer.from('verified image bytes');
  const fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          id: 'cfile_commons_42',
          object: 'container.file',
          bytes: bytes.length,
          container_id: 'cntr_primary',
          created_at: 1,
          source: 'user',
          path: '/mnt/data/provider-prefix-matterhorn.jpg',
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
  });
  const client = new CustomOpenAIClient({ apiKey: 'test-key', fetch, maxRetries: 0 });
  const search = jest.fn(async () => [image]);
  const download = jest.fn(async () => ({
    image,
    buffer: bytes,
    filename: 'matterhorn.jpg',
    mimeType: 'image/jpeg',
  }));
  const createClient = jest.fn(() => ({ search, download }));
  const getSkillByName = jest.fn(async (_name: string, ids: Types.ObjectId[]) =>
    ids.some((id) => id.equals(skillId))
      ? { ...image, _id: skillId, name: 'images-commons', body: '', version: 1, fileCount: 0 }
      : null,
  );
  const agent = {
    id: 'primary',
    tools: [{ type: 'code_interpreter', container: 'cntr_primary' }],
    toolDefinitions: [] as LCTool[],
    toolRegistry: new Map<string, LCTool>(),
    accessibleSkillIds: [skillId],
    activeSkillNames: new Set(['images-commons']),
  };
  return { agent, bytes, client, createClient, getSkillByName, search, download, fetch };
}

describe('native Wikimedia Commons tools', () => {
  it('registers schemas and executes request-scoped search and verified import callbacks', async () => {
    const f = fixture();
    const workspace = prepareCommonsTools({
      agent: f.agent,
      client: f.client,
      containerId: 'cntr_primary',
      signal: new AbortController().signal,
      getSkillByName: f.getSkillByName,
      createClient: f.createClient,
    });

    expect(f.agent.toolDefinitions.map(({ name }) => name)).toEqual([
      SEARCH_COMMONS_IMAGES_TOOL_NAME,
      IMPORT_COMMONS_IMAGE_TOOL_NAME,
    ]);
    expect([...f.agent.toolRegistry.keys()]).toEqual([
      SEARCH_COMMONS_IMAGES_TOOL_NAME,
      IMPORT_COMMONS_IMAGE_TOOL_NAME,
    ]);

    const searchTool = workspace?.tools.get(SEARCH_COMMONS_IMAGES_TOOL_NAME);
    const searchResult = JSON.parse(String(await searchTool?.invoke({ query: 'Matterhorn' })));
    expect(searchResult.images).toEqual([image]);
    expect(f.search).toHaveBeenCalledWith({ query: 'Matterhorn', limit: undefined });

    const importTool = workspace?.tools.get(IMPORT_COMMONS_IMAGE_TOOL_NAME);
    const imported = JSON.parse(
      String(await importTool?.invoke({ page_id: image.pageId, width: 1200 })),
    );
    expect(imported).toEqual(
      expect.objectContaining({
        status: 'imported',
        path: '/mnt/data/provider-prefix-matterhorn.jpg',
        pageId: image.pageId,
        width: image.width,
        height: image.height,
        attribution: image.attribution,
      }),
    );

    await importTool?.invoke({ page_id: image.pageId, width: 1200 });
    expect(f.download).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(f.getSkillByName).toHaveBeenCalledTimes(3);
  });

  it('executes through the event-driven tool loader with string content', async () => {
    const f = fixture();
    const workspace = prepareCommonsTools({
      agent: f.agent,
      client: f.client,
      containerId: 'cntr_primary',
      signal: new AbortController().signal,
      getSkillByName: f.getSkillByName,
      createClient: f.createClient,
    });
    const handler = createToolExecuteHandler({
      loadTools: async (names, agentId) => ({
        loadedTools:
          agentId === f.agent.id
            ? names.map((name) => workspace?.tools.get(name)).filter((tool) => tool !== undefined)
            : [],
      }),
    });

    const results = await new Promise<ToolExecuteResult[]>((resolve, reject) => {
      handler.handle('on_tool_execute', {
        agentId: f.agent.id,
        toolCalls: [
          {
            id: 'commons-search-call',
            name: SEARCH_COMMONS_IMAGES_TOOL_NAME,
            args: { query: 'Matterhorn' },
          },
        ],
        resolve,
        reject,
      } satisfies ToolExecuteBatchRequest);
    });

    expect(results).toEqual([
      expect.objectContaining({
        toolCallId: 'commons-search-call',
        status: 'success',
        content: expect.any(String),
      }),
    ]);
    expect(JSON.parse(String(results[0].content)).images).toEqual([image]);
  });

  it('does not register outside an active, accessible native workspace', () => {
    const inactive = fixture();
    inactive.agent.activeSkillNames.clear();
    expect(
      prepareCommonsTools({
        agent: inactive.agent,
        client: inactive.client,
        containerId: 'cntr_primary',
        signal: new AbortController().signal,
        getSkillByName: inactive.getSkillByName,
        createClient: inactive.createClient,
      }),
    ).toBeUndefined();

    const noNativeInterpreter = fixture();
    noNativeInterpreter.agent.tools = [];
    expect(
      prepareCommonsTools({
        agent: noNativeInterpreter.agent,
        client: noNativeInterpreter.client,
        containerId: 'cntr_primary',
        signal: new AbortController().signal,
        getSkillByName: noNativeInterpreter.getSkillByName,
        createClient: noNativeInterpreter.createClient,
      }),
    ).toBeUndefined();

    const inaccessible = fixture();
    inaccessible.agent.accessibleSkillIds = [];
    expect(
      prepareCommonsTools({
        agent: inaccessible.agent,
        client: inaccessible.client,
        containerId: 'cntr_primary',
        signal: new AbortController().signal,
        getSkillByName: inaccessible.getSkillByName,
        createClient: inaccessible.createClient,
      }),
    ).toBeUndefined();
  });

  it('fails closed when another tool already owns a Commons tool name', () => {
    const f = fixture();
    f.agent.toolDefinitions = [
      {
        name: SEARCH_COMMONS_IMAGES_TOOL_NAME,
        description: 'Different tool',
        parameters: { type: 'object', properties: {} },
      },
    ];

    expect(
      prepareCommonsTools({
        agent: f.agent,
        client: f.client,
        containerId: 'cntr_primary',
        signal: new AbortController().signal,
        getSkillByName: f.getSkillByName,
        createClient: f.createClient,
      }),
    ).toBeUndefined();
    expect(f.agent.toolRegistry.size).toBe(0);
    expect(f.createClient).not.toHaveBeenCalled();
  });

  it('revalidates skill access before every callback', async () => {
    const f = fixture();
    const workspace = prepareCommonsTools({
      agent: f.agent,
      client: f.client,
      containerId: 'cntr_primary',
      signal: new AbortController().signal,
      getSkillByName: jest.fn(async () => null),
      createClient: f.createClient,
    });

    await expect(
      workspace?.tools.get(SEARCH_COMMONS_IMAGES_TOOL_NAME)?.invoke({ query: 'Matterhorn' }),
    ).rejects.toThrow('not accessible');
    expect(f.search).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('honors request cancellation before external work', async () => {
    const f = fixture();
    const abort = new AbortController();
    const workspace = prepareCommonsTools({
      agent: f.agent,
      client: f.client,
      containerId: 'cntr_primary',
      signal: abort.signal,
      getSkillByName: f.getSkillByName,
      createClient: f.createClient,
    });
    abort.abort();

    await expect(
      workspace?.tools.get(SEARCH_COMMONS_IMAGES_TOOL_NAME)?.invoke({ query: 'Matterhorn' }),
    ).rejects.toThrow();
    expect(f.getSkillByName).not.toHaveBeenCalled();
    expect(f.search).not.toHaveBeenCalled();
  });
});
