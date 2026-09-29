import { Readable } from 'node:stream';
import { Types } from 'mongoose';
import { CustomOpenAIClient } from '@librechat/agents';
import type { ServerRequest } from '~/types';
import { createOpenAIResources } from './native';
import { IMPORT_COMMONS_IMAGE_TOOL_NAME, SEARCH_COMMONS_IMAGES_TOOL_NAME } from './commons';

function fixture() {
  const id = new Types.ObjectId();
  const skill = {
    _id: id,
    name: 'office',
    body: 'Use Office resources.',
    fileCount: 1,
    version: 1,
  };
  let uploads = 0;
  const fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      uploads++;
      return new Response(
        JSON.stringify({
          id: `cfile_${uploads}`,
          object: 'container.file',
          bytes: 100,
          container_id: 'cntr_current',
          created_at: 1,
          source: 'user',
          path: `/mnt/data/provider-prefix-resource-${uploads}.zip`,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ data: [], object: 'list', has_more: false }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const client = new CustomOpenAIClient({ apiKey: 'test-key', fetch, maxRetries: 0 });
  const req = {
    user: { id: new Types.ObjectId().toString(), tenantId: 'tenant-1' },
  } as ServerRequest;
  const getSkillByName = jest.fn(async (_name: string, ids: Types.ObjectId[]) =>
    ids.some((candidate) => candidate.equals(id)) ? skill : null,
  );
  const listSkillFiles = jest.fn(async () => [
    {
      relativePath: 'scripts/example.py',
      filename: 'example.py',
      filepath: '/stored/example.py',
      source: 'local',
      bytes: 12,
    },
  ]);
  const getFiles = jest.fn(async () => []);
  const resources = createOpenAIResources({
    req,
    getSkillByName,
    listSkillFiles,
    getFiles,
    getStrategyFunctions: () => ({ getDownloadStream: async () => Readable.from('print(42)\n') }),
  });
  const preparation = {
    container: { id: () => 'cntr_current', client: () => client },
    agent: { id: 'primary', accessibleSkillIds: [id] },
    conversationId: 'conversation-1',
    history: [],
    payload: [],
    signal: new AbortController().signal,
  };
  return { resources, preparation, skill, getSkillByName, listSkillFiles, getFiles, fetch };
}

describe('native OpenAI resource wiring', () => {
  it('prepares the exact manually selected skill before the first model call', async () => {
    const f = fixture();
    const instructions = await f.resources.prepare({
      ...f.preparation,
      agent: { ...f.preparation.agent, manualSkillPrimes: [f.skill] },
    });
    expect(f.getSkillByName).toHaveBeenCalledWith('office', [f.skill._id]);
    expect(instructions).toContain('/mnt/data/provider-prefix-resource-1.zip');
    expect(instructions).not.toContain('print(42)');
    expect(f.listSkillFiles).toHaveBeenCalledWith(f.skill._id);
  });

  it('restages a historical skill in the current container', async () => {
    const f = fixture();
    const instructions = await f.resources.prepare({
      ...f.preparation,
      payload: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              tool_call: {
                name: 'skill',
                args: { skillName: 'office' },
              },
            },
          ],
        },
      ],
    });
    expect(instructions).toContain('/mnt/data/provider-prefix-resource-1.zip');
    expect(f.getSkillByName).toHaveBeenCalledWith('office', [f.skill._id]);
  });

  it('does not transfer stale history outside the current agent skill scope', async () => {
    const f = fixture();
    const instructions = await f.resources.prepare({
      ...f.preparation,
      agent: { id: 'primary', accessibleSkillIds: [] },
      payload: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              tool_call: {
                name: 'skill',
                args: { skillName: 'office' },
              },
            },
          ],
        },
      ],
    });
    expect(instructions).toBe('');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.listSkillFiles).not.toHaveBeenCalled();
  });

  it('supports autonomous loading but never shares the primary workspace with another agent', async () => {
    const f = fixture();
    await f.resources.prepare(f.preparation);
    expect(await f.resources.primeSkill(f.skill, 'secondary')).toBeUndefined();
    expect(await f.resources.primeSkill(f.skill)).toBeUndefined();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.resources.primeSkill(f.skill, 'primary')).toContain('/mnt/data/');
    await expect(
      f.resources.primeSkill({ ...f.skill, _id: new Types.ObjectId() }, 'primary'),
    ).rejects.toThrow('not accessible');
  });

  it('keeps concurrently prepared agents in separate containers with separate access scopes', async () => {
    const f = fixture();
    await Promise.all([
      f.resources.prepare(f.preparation),
      f.resources.prepare({
        ...f.preparation,
        agent: { ...f.preparation.agent, id: 'secondary' },
        container: { ...f.preparation.container, id: () => 'cntr_secondary' },
      }),
      f.resources.prepare({
        ...f.preparation,
        agent: { id: 'restricted', accessibleSkillIds: [] },
        container: { ...f.preparation.container, id: () => 'cntr_restricted' },
      }),
    ]);
    await expect(f.resources.primeSkill(f.skill, 'primary')).resolves.toContain('/mnt/data/');
    await expect(f.resources.primeSkill(f.skill, 'secondary')).resolves.toContain('/mnt/data/');
    await expect(f.resources.primeSkill(f.skill, 'restricted')).rejects.toThrow('not accessible');
    const uploadedUrls = f.fetch.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([url]) => String(url));
    expect(uploadedUrls).toEqual([
      expect.stringContaining('/containers/cntr_current/files'),
      expect.stringContaining('/containers/cntr_secondary/files'),
    ]);
  });

  it('reports unavailable transfers for unmanaged native containers without claiming a resource path', async () => {
    const f = fixture();
    const agent = {
      ...f.preparation.agent,
      tools: [{ type: 'code_interpreter', container: 'cntr_external' }],
      toolDefinitions: [],
      toolRegistry: new Map(),
      activeSkillNames: new Set(['images-commons']),
    };
    const instructions = await f.resources.prepare({
      ...f.preparation,
      container: { id: () => undefined, client: () => undefined },
      agent,
    });
    expect(instructions).toContain('unmanaged');
    await expect(f.resources.primeSkill(f.skill, 'primary')).rejects.toThrow('unavailable');
    expect(agent.toolDefinitions).toEqual([]);
    expect(f.resources.loadTools([SEARCH_COMMONS_IMAGES_TOOL_NAME], 'primary')).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.getFiles).not.toHaveBeenCalled();
  });

  it('performs no storage or provider work when native Code Interpreter is disabled', async () => {
    const f = fixture();
    const instructions = await f.resources.prepare({
      ...f.preparation,
      container: { id: () => undefined, client: () => undefined },
      agent: { ...f.preparation.agent, manualSkillPrimes: [f.skill] },
    });
    expect(instructions).toBe('');
    expect(await f.resources.primeSkill(f.skill, 'primary')).toBeUndefined();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.getFiles).not.toHaveBeenCalled();
  });

  it('exposes Commons callbacks only in the prepared agent workspace', async () => {
    const f = fixture();
    const agent = {
      ...f.preparation.agent,
      tools: [{ type: 'code_interpreter', container: 'cntr_current' }],
      toolDefinitions: [],
      toolRegistry: new Map(),
      activeSkillNames: new Set(['images-commons']),
    };
    await f.resources.prepare({
      ...f.preparation,
      agent,
    });

    expect(agent.toolDefinitions.map(({ name }) => name)).toEqual([
      SEARCH_COMMONS_IMAGES_TOOL_NAME,
      IMPORT_COMMONS_IMAGE_TOOL_NAME,
    ]);
    expect([...agent.toolRegistry.keys()]).toEqual([
      SEARCH_COMMONS_IMAGES_TOOL_NAME,
      IMPORT_COMMONS_IMAGE_TOOL_NAME,
    ]);
    expect(
      f.resources.loadTools(
        [SEARCH_COMMONS_IMAGES_TOOL_NAME, IMPORT_COMMONS_IMAGE_TOOL_NAME],
        'primary',
      ),
    ).toHaveLength(2);
    expect(f.resources.loadTools([SEARCH_COMMONS_IMAGES_TOOL_NAME], 'secondary')).toEqual([]);
    expect(f.resources.loadTools([SEARCH_COMMONS_IMAGES_TOOL_NAME])).toEqual([]);
  });
});
