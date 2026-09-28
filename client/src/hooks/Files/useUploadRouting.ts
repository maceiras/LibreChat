import { useCallback } from 'react';
import {
  EModelEndpoint,
  mergeFileConfig,
  AgentCapabilities,
  resolveEndpointType,
  getEndpointFileConfig,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import { useGetFileConfig, useGetEndpointsQuery, useGetAgentByIdQuery } from '~/data-provider';
import { useAgentsMapContext } from '~/Providers/AgentsMapContext';
import { getDefaultUploadToolResource } from '~/utils/uploads';

interface UploadRoutingOptions {
  endpoint?: string | null;
  endpointType?: string | null;
  agentId?: string | null;
  useResponsesApi?: boolean;
}

export default function useUploadRouting(options: UploadRoutingOptions) {
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { data: agentData } = useGetAgentByIdQuery(options.agentId);
  const agentsMap = useAgentsMapContext();
  const agent = agentData ?? agentsMap?.[options.agentId ?? ''];
  const { data: fileConfig = null } = useGetFileConfig({ select: mergeFileConfig });
  const endpointType =
    options.endpointType && options.endpointType !== EModelEndpoint.agents
      ? options.endpointType
      : resolveEndpointType(endpointsConfig, options.endpoint, agent?.provider);
  const provider = agent?.provider ?? options.endpoint;
  const useResponsesApi = options.useResponsesApi ?? agent?.model_parameters?.useResponsesApi;
  const capabilities =
    endpointsConfig?.[EModelEndpoint.agents]?.capabilities ?? defaultAgentCapabilities;
  const contextEnabled = capabilities.includes(AgentCapabilities.context);
  const endpointFileConfig = getEndpointFileConfig({
    endpoint: options.endpoint,
    endpointType,
    fileConfig,
  });

  const getToolResource = useCallback(
    (file: File) =>
      getDefaultUploadToolResource(file, {
        provider,
        endpointType,
        useResponsesApi,
        endpointFileConfig,
        fileConfig,
        contextEnabled,
      }),
    [provider, endpointType, useResponsesApi, endpointFileConfig, fileConfig, contextEnabled],
  );

  return { getToolResource, endpointType, endpointFileConfig, fileConfig };
}
