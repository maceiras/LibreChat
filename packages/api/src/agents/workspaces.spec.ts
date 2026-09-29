import { z } from 'zod';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import { prepareOpenAIWorkspaces } from './workspaces';
import type { OpenAIWorkspaceAgent } from './workspaces';

function testTool(name: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name,
    description: name,
    schema: z.object({}),
    func: async () => name,
  });
}

function agent(id: string, tool: string = `${id}-tool`): OpenAIWorkspaceAgent {
  return {
    id,
    name: id,
    description: null,
    created_at: 0,
    avatar: null,
    provider: 'openAI',
    model: `${id}-model`,
    model_parameters: {
      temperature: null,
      maxContextTokens: null,
      max_context_tokens: null,
      max_output_tokens: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
    },
    tools: [testTool(tool)],
    attachments: [],
    requestAttachments: [],
    agentContextAttachments: [],
    toolContextMap: {},
    maxContextTokens: 32_000,
    useLegacyContent: false,
    resendFiles: true,
    codeEnvAvailable: false,
    skillAuthoringAvailable: false,
  };
}

describe('prepareOpenAIWorkspaces', () => {
  it('prepares every reachable id once and preserves shared subagent identity', async () => {
    const shared = agent('shared');
    const left = agent('left');
    const right = agent('right');
    left.subagentAgentConfigs = [shared];
    right.subagentAgentConfigs = [shared];
    const calls: string[] = [];

    const roots = await prepareOpenAIWorkspaces({
      agents: [left, right],
      prepare: async (current) => {
        calls.push(current.id);
        return { ...current, additional_instructions: `workspace:${current.id}` };
      },
    });

    expect(calls).toEqual(['left', 'right', 'shared']);
    expect(roots[0]).not.toBe(left);
    expect(roots[1]).not.toBe(right);
    expect(roots[0].subagentAgentConfigs?.[0]).toBe(roots[1].subagentAgentConfigs?.[0]);
    expect(roots[0].subagentAgentConfigs?.[0]?.additional_instructions).toBe('workspace:shared');
  });

  it('uses prepared roots without preparing them again and keeps agent data isolated', async () => {
    const primary = agent('primary', 'primary-tool');
    const secondary = agent('secondary', 'secondary-tool');
    primary.subagentAgentConfigs = [secondary];
    const preparedPrimary = {
      ...primary,
      tools: [testTool('primary-prepared-tool')],
      additional_instructions: 'primary-workspace',
    };
    const prepare = jest.fn(async (current: OpenAIWorkspaceAgent) => ({
      ...current,
      tools: [testTool(`${current.id}-prepared-tool`)],
      additional_instructions: `${current.id}-workspace`,
    }));

    const [root] = await prepareOpenAIWorkspaces({
      agents: [primary],
      prepare,
      prepared: new Map([[primary.id, preparedPrimary]]),
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ id: 'secondary' }));
    expect(root.id).toBe('primary');
    expect(root.tools.map(({ name }) => name)).toEqual(['primary-prepared-tool']);
    expect(root.subagentAgentConfigs?.[0]).toEqual(
      expect.objectContaining({ id: 'secondary', additional_instructions: 'secondary-workspace' }),
    );
    expect(root.subagentAgentConfigs?.[0]?.tools.map(({ name }) => name)).toEqual([
      'secondary-prepared-tool',
    ]);
    expect(root.subagentAgentConfigs?.[0]?.id).not.toBe(root.id);
  });

  it('rebuilds cycles and duplicate roots without mutating the original graph', async () => {
    const first = agent('first');
    const second = agent('second');
    first.subagentAgentConfigs = [second];
    second.subagentAgentConfigs = [first];
    const originalFirstChildren = first.subagentAgentConfigs;
    const originalSecondChildren = second.subagentAgentConfigs;
    const prepare = jest.fn(async (current: OpenAIWorkspaceAgent) => ({
      ...current,
      instructions: `prepared:${current.id}`,
    }));

    const roots = await prepareOpenAIWorkspaces({ agents: [first, first], prepare });

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(roots[0]).toBe(roots[1]);
    const rebuiltSecond = roots[0].subagentAgentConfigs?.[0];
    expect(rebuiltSecond?.subagentAgentConfigs?.[0]).toBe(roots[0]);
    expect(first.subagentAgentConfigs).toBe(originalFirstChildren);
    expect(second.subagentAgentConfigs).toBe(originalSecondChildren);
    expect(first.subagentAgentConfigs?.[0]).toBe(second);
    expect(second.subagentAgentConfigs?.[0]).toBe(first);
    expect(first.instructions).not.toBe('prepared:first');
    expect(second.instructions).not.toBe('prepared:second');
  });

  it('detaches the mutable tool list before invoking the preparation callback', async () => {
    const original = agent('primary', 'original-tool');

    const [result] = await prepareOpenAIWorkspaces({
      agents: [original],
      prepare: async (current) => {
        current.tools.push(testTool('prepared-tool'));
        return current;
      },
    });

    expect(original.tools.map(({ name }) => name)).toEqual(['original-tool']);
    expect(result.tools.map(({ name }) => name)).toEqual(['original-tool', 'prepared-tool']);
  });
});
