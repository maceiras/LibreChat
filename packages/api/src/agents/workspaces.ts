import type { GenericTool } from '@librechat/agents';
import type { InitializedAgent } from './initialize';

/** Initialized run agent with the explicit, preloaded subagent graph used by createRun. */
export type OpenAIWorkspaceAgent = Omit<InitializedAgent, 'tools'> & {
  tools: GenericTool[];
  subagentAgentConfigs?: OpenAIWorkspaceAgent[];
};

export interface PrepareOpenAIWorkspacesParams {
  agents: OpenAIWorkspaceAgent[];
  prepare: (agent: OpenAIWorkspaceAgent) => Promise<OpenAIWorkspaceAgent>;
  /** Already-prepared agents, keyed by their stable run agent id. */
  prepared?: ReadonlyMap<string, OpenAIWorkspaceAgent>;
}

function detachedAgent(agent: OpenAIWorkspaceAgent): OpenAIWorkspaceAgent {
  return {
    ...agent,
    tools: [...agent.tools],
    ...(agent.subagentAgentConfigs !== undefined && { subagentAgentConfigs: [] }),
  };
}

/**
 * Prepares every distinct agent workspace and rebuilds the reachable agent graph.
 *
 * Agent ids are the graph identity: repeated roots and shared subagents resolve to
 * the same rebuilt object, and cycles remain cycles. The callback receives a
 * detached node without live child references so preparation cannot mutate the
 * source graph. Self-spawn declarations are ordinary agent configuration and are
 * intentionally not expanded here.
 */
export async function prepareOpenAIWorkspaces({
  agents,
  prepare,
  prepared = new Map(),
}: PrepareOpenAIWorkspacesParams): Promise<OpenAIWorkspaceAgent[]> {
  const sourceById = new Map<string, OpenAIWorkspaceAgent>();
  const pending = [...agents];

  for (let index = 0; index < pending.length; index++) {
    const agent = pending[index];
    if (sourceById.has(agent.id)) continue;
    sourceById.set(agent.id, agent);
    for (const child of agent.subagentAgentConfigs ?? []) {
      if (!sourceById.has(child.id)) pending.push(child);
    }
  }

  const preparedEntries = await Promise.all(
    [...sourceById].map(async ([id, source]) => {
      const existing = prepared.get(id);
      const result = existing ?? (await prepare(detachedAgent(source)));
      return [id, result] as const;
    }),
  );
  const preparedById = new Map(preparedEntries);
  const rebuiltById = new Map<string, OpenAIWorkspaceAgent>();

  for (const [id, source] of sourceById) {
    const result = preparedById.get(id);
    if (!result) continue;
    const rebuilt = detachedAgent({ ...result, id });
    if (source.subagentAgentConfigs === undefined) {
      delete rebuilt.subagentAgentConfigs;
    }
    rebuiltById.set(id, rebuilt);
  }

  for (const [id, source] of sourceById) {
    if (source.subagentAgentConfigs === undefined) continue;
    const rebuilt = rebuiltById.get(id);
    if (!rebuilt) continue;
    rebuilt.subagentAgentConfigs = source.subagentAgentConfigs
      .map((child) => rebuiltById.get(child.id))
      .filter((child): child is OpenAIWorkspaceAgent => child !== undefined);
  }

  return agents
    .map((agent) => rebuiltById.get(agent.id))
    .filter((agent): agent is OpenAIWorkspaceAgent => agent !== undefined);
}
