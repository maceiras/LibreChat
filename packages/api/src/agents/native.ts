import type { FileMethods } from '@librechat/data-schemas';
import type { TMessage } from 'librechat-data-provider';
import type { GenericTool, GraphTools, LCTool, LCToolRegistry } from '@librechat/agents';
import type { PrimeInvokedSkillsDeps, PrimeSkillFilesParams } from './skillFiles';
import type { ReusableOpenAIContainer } from './container';
import type { InitializedAgent } from './initialize';
import type { ToolExecuteOptions } from './handlers';
import type { ServerRequest } from '~/types';
import { collectRestorableFileIds, restoreContainerFiles } from './restoration';
import { createOpenAISkillResourcePrimer } from './bundles';
import { prepareCommonsTools } from './commons';
import { extractInvokedSkillsFromPayload } from './run';

interface NativeResourceDependencies {
  req: ServerRequest;
  getFiles: FileMethods['getFiles'];
  getSkillByName: NonNullable<ToolExecuteOptions['getSkillByName']>;
  listSkillFiles: NonNullable<ToolExecuteOptions['listSkillFiles']>;
  getStrategyFunctions: PrimeSkillFilesParams['getStrategyFunctions'];
}

interface NativeResourcePreparation {
  container: Pick<ReusableOpenAIContainer, 'client' | 'id'>;
  agent: Pick<
    InitializedAgent,
    | 'id'
    | 'accessibleSkillIds'
    | 'activeSkillNames'
    | 'manualSkillPrimes'
    | 'alwaysApplySkillPrimes'
  > & {
    tools?: GraphTools;
    toolDefinitions?: LCTool[];
    toolRegistry?: LCToolRegistry;
  };
  conversationId: string;
  history: TMessage[];
  payload: PrimeInvokedSkillsDeps['payload'];
  signal: AbortSignal;
}

export interface OpenAIResources {
  primeSkill: NonNullable<ToolExecuteOptions['primeOpenAISkill']>;
  loadTools: (toolNames: string[], agentId?: string) => GenericTool[];
  prepare: (options: NativeResourcePreparation) => Promise<string>;
}

interface AgentResources {
  primer?: ReturnType<typeof createOpenAISkillResourcePrimer>;
  accessibleIds: Set<string>;
  tools?: ReadonlyMap<string, GenericTool>;
  unavailable?: string;
}

/** Keep native provider workspaces isolated by agent within one request. */
export function createOpenAIResources(deps: NativeResourceDependencies): OpenAIResources {
  const workspaces = new Map<string, AgentResources>();

  const primeSkill: NonNullable<ToolExecuteOptions['primeOpenAISkill']> = async (
    skill,
    agentId,
  ) => {
    const workspace = agentId ? workspaces.get(agentId) : undefined;
    if (!workspace) return;
    if (!workspace.accessibleIds.has(skill._id.toString())) {
      throw new Error('Skill resources are not accessible to this agent');
    }
    const files = await deps.listSkillFiles(skill._id);
    if (!files.length) return;
    if (workspace.unavailable) throw new Error(workspace.unavailable);
    return (await workspace.primer?.ensureSkill(skill, files))?.instructions;
  };

  return {
    primeSkill,
    loadTools(toolNames, agentId) {
      const tools = agentId ? workspaces.get(agentId)?.tools : undefined;
      if (!tools) return [];
      return toolNames
        .map((name) => tools.get(name))
        .filter((tool): tool is GenericTool => tool !== undefined);
    },
    async prepare({
      container,
      agent,
      conversationId,
      history,
      payload,
      signal,
    }: NativeResourcePreparation): Promise<string> {
      workspaces.delete(agent.id);
      const accessibleIds = new Set((agent.accessibleSkillIds ?? []).map((id) => id.toString()));
      const client = container.client();
      const containerId = container.id();
      const user = deps.req.user;
      if (!client || !containerId || !user) {
        const hasNativeTool = agent.tools?.some(
          (tool) => typeof tool === 'object' && 'type' in tool && tool.type === 'code_interpreter',
        );
        if (!hasNativeTool) return '';
        const unavailable =
          'Automatic skill transfer and file restoration are unavailable for this unmanaged ' +
          'Code Interpreter container. No resource path has been verified. Use only files ' +
          'confirmed present by the runtime; do not reconstruct scripts from read_file output.';
        workspaces.set(agent.id, { accessibleIds, unavailable });
        return unavailable;
      }
      const primer = createOpenAISkillResourcePrimer({
        client,
        containerId,
        req: deps.req,
        getStrategyFunctions: deps.getStrategyFunctions,
        signal,
      });
      const commonsWorkspace = prepareCommonsTools({
        agent,
        client,
        containerId,
        signal,
        getSkillByName: deps.getSkillByName,
      });
      workspaces.set(agent.id, { accessibleIds, primer, tools: commonsWorkspace?.tools });

      const instructions: string[] = [];
      const fresh = new Map(
        [...(agent.alwaysApplySkillPrimes ?? []), ...(agent.manualSkillPrimes ?? [])].map(
          (prime) => [prime.name, prime],
        ),
      );
      const names = new Set([...extractInvokedSkillsFromPayload(payload), ...fresh.keys()]);
      for (const name of names) {
        const pinned = fresh.get(name);
        if (pinned && !accessibleIds.has(pinned._id.toString())) continue;
        const skill = await deps.getSkillByName(
          name,
          pinned ? [pinned._id] : (agent.accessibleSkillIds ?? []),
        );
        if (!skill) continue;
        const content = await primeSkill(skill, agent.id);
        if (content) instructions.push(content);
      }

      const ids = collectRestorableFileIds(history, conversationId);
      if (ids.length) {
        const files = await deps.getFiles({
          file_id: { $in: ids },
          user: user.id,
          tenantId: user.tenantId ?? { $in: [null] },
          $or: [
            { conversationId },
            { conversationId: { $exists: false } },
            { conversationId: null },
          ],
        });
        const restored = await restoreContainerFiles({
          client,
          containerId,
          signal,
          req: deps.req,
          conversationId,
          currentMessages: history,
          files: files ?? [],
          getStrategyFunctions: deps.getStrategyFunctions,
        });
        if (restored.instructions) instructions.push(restored.instructions);
      }
      return instructions.join('\n\n');
    },
  };
}
