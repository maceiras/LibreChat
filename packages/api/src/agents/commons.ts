import { z } from 'zod';
import { CustomOpenAIClient } from '@librechat/agents';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { GraphTools, LCTool, LCToolRegistry } from '@librechat/agents';
import type { Types } from 'mongoose';
import type { CommonsImage, CreateCommonsClient } from '../images/commons';
import type { ToolExecuteOptions } from './handlers';
import { createCommonsClient } from '../images/commons';
import { sha256, throwIfAborted, verifyContainerFile } from './transfer';

export const COMMONS_SKILL_NAME = 'images-commons';
export const SEARCH_COMMONS_IMAGES_TOOL_NAME = 'search_commons_images';
export const IMPORT_COMMONS_IMAGE_TOOL_NAME = 'import_commons_image';
const SEARCH_COMMONS_IMAGES_DESCRIPTION =
  'Search Wikimedia Commons for reusable images. Returns candidate page IDs, preview URLs, dimensions, descriptions, and attribution metadata. Refine the query when the results are ambiguous.';
const IMPORT_COMMONS_IMAGE_DESCRIPTION =
  'Import one selected Wikimedia Commons image into the current native Python workspace. Returns the exact local path and attribution metadata. Embed the image with readable author credits and clickable source/license links in the requested artifact; keep the image file internal unless separately requested.';

const SEARCH_COMMONS_IMAGES_DEF: LCTool = Object.freeze({
  name: SEARCH_COMMONS_IMAGES_TOOL_NAME,
  description: SEARCH_COMMONS_IMAGES_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Concrete visual search query, including the subject and useful location.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 8,
        default: 6,
        description: 'Maximum number of candidates to return.',
      },
    },
    required: ['query'],
  } as LCTool['parameters'],
}) as LCTool;

const IMPORT_COMMONS_IMAGE_DEF: LCTool = Object.freeze({
  name: IMPORT_COMMONS_IMAGE_TOOL_NAME,
  description: IMPORT_COMMONS_IMAGE_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      page_id: {
        type: 'integer',
        minimum: 1,
        description: 'Wikimedia Commons page ID returned by search_commons_images.',
      },
      width: {
        type: 'integer',
        minimum: 320,
        maximum: 2400,
        default: 1600,
        description: 'Requested image width in pixels.',
      },
    },
    required: ['page_id'],
  } as LCTool['parameters'],
}) as LCTool;

interface CommonsToolAgent {
  id: string;
  tools?: GraphTools;
  toolDefinitions?: LCTool[];
  toolRegistry?: LCToolRegistry;
  accessibleSkillIds?: Types.ObjectId[];
  activeSkillNames?: Set<string>;
}

interface PrepareCommonsToolsParams {
  agent: CommonsToolAgent;
  client: CustomOpenAIClient;
  containerId: string;
  signal: AbortSignal;
  getSkillByName: NonNullable<ToolExecuteOptions['getSkillByName']>;
  createClient?: CreateCommonsClient;
}

type ImportedCommonsImage = Pick<
  CommonsImage,
  | 'pageId'
  | 'title'
  | 'description'
  | 'sourceUrl'
  | 'width'
  | 'height'
  | 'author'
  | 'credit'
  | 'license'
  | 'licenseUrl'
  | 'attribution'
  | 'attributionRequired'
> & {
  status: 'imported';
  path: string;
  containerFileId: string;
  filename: string;
  mimeType: string;
  bytes: number;
};

export interface CommonsToolWorkspace {
  tools: ReadonlyMap<string, DynamicStructuredTool>;
}

function hasNativeInterpreter(tools: GraphTools | undefined): boolean {
  return (
    tools?.some(
      (tool) => typeof tool === 'object' && 'type' in tool && tool.type === 'code_interpreter',
    ) === true
  );
}

function registerDefinition(agent: CommonsToolAgent, definition: LCTool): void {
  const registry = agent.toolRegistry ?? new Map<string, LCTool>();
  registry.set(definition.name, definition);
  agent.toolRegistry = registry;
  if (agent.toolDefinitions?.some(({ name }) => name === definition.name) === true) return;
  agent.toolDefinitions = [...(agent.toolDefinitions ?? []), definition];
}

function hasDefinitionCollision(agent: CommonsToolAgent, definition: LCTool): boolean {
  const registered = agent.toolRegistry?.get(definition.name);
  if (registered && registered !== definition) return true;
  const declared = agent.toolDefinitions?.find(({ name }) => name === definition.name);
  return declared !== undefined && declared !== definition;
}

function providerWorkspacePath(value: string): string {
  if (!value.startsWith('/mnt/data/') || value.split('/').includes('..') || value.includes('\0')) {
    throw new Error('Wikimedia Commons image upload returned an invalid workspace path');
  }
  return value;
}

function formatSearchResult(
  images: Awaited<ReturnType<ReturnType<CreateCommonsClient>['search']>>,
) {
  return JSON.stringify({ images });
}

/** Register request-scoped Commons definitions and execution callbacks for one native workspace. */
export function prepareCommonsTools({
  agent,
  client,
  containerId,
  signal,
  getSkillByName,
  createClient = createCommonsClient,
}: PrepareCommonsToolsParams): CommonsToolWorkspace | undefined {
  if (!agent.activeSkillNames?.has(COMMONS_SKILL_NAME)) return;
  if (!hasNativeInterpreter(agent.tools)) return;
  if (
    hasDefinitionCollision(agent, SEARCH_COMMONS_IMAGES_DEF) ||
    hasDefinitionCollision(agent, IMPORT_COMMONS_IMAGE_DEF)
  ) {
    return;
  }

  const accessibleSkillIds = [...(agent.accessibleSkillIds ?? [])];
  const accessibleIds = new Set(accessibleSkillIds.map((id) => id.toString()));
  if (!accessibleIds.size) return;

  const commons = createClient({ signal });
  const imported = new Map<string, Promise<ImportedCommonsImage>>();
  const authorize = async (): Promise<void> => {
    throwIfAborted(signal);
    if (!agent.activeSkillNames?.has(COMMONS_SKILL_NAME)) {
      throw new Error('Wikimedia Commons image tools are not active for this agent');
    }
    const skill = await getSkillByName(COMMONS_SKILL_NAME, accessibleSkillIds, {
      preferModelInvocable: true,
    });
    if (!skill || skill.name !== COMMONS_SKILL_NAME || !accessibleIds.has(skill._id.toString())) {
      throw new Error('Wikimedia Commons image tools are not accessible to this agent');
    }
    throwIfAborted(signal);
  };

  const searchTool = new DynamicStructuredTool({
    name: SEARCH_COMMONS_IMAGES_TOOL_NAME,
    description: SEARCH_COMMONS_IMAGES_DESCRIPTION,
    schema: z.object({
      query: z.string().trim().min(2),
      limit: z.number().int().min(1).max(8).optional(),
    }),
    func: async ({ query, limit }) => {
      await authorize();
      return formatSearchResult(await commons.search({ query, limit }));
    },
  });

  const importTool = new DynamicStructuredTool({
    name: IMPORT_COMMONS_IMAGE_TOOL_NAME,
    description: IMPORT_COMMONS_IMAGE_DESCRIPTION,
    schema: z.object({
      page_id: z.number().int().positive(),
      width: z.number().int().min(320).max(2400).optional(),
    }),
    func: async ({ page_id, width }) => {
      await authorize();
      const key = `${page_id}:${width ?? 'default'}`;
      const existing = imported.get(key);
      if (existing) return JSON.stringify(await existing);

      const pending = (async (): Promise<ImportedCommonsImage> => {
        const downloaded = await commons.download({ pageId: page_id, width });
        throwIfAborted(signal);
        const digest = sha256(downloaded.buffer);
        const uploaded = await client.containers.files.create(
          containerId,
          {
            file: new File([new Uint8Array(downloaded.buffer)], downloaded.filename, {
              type: downloaded.mimeType,
            }),
          },
          {
            signal,
            idempotencyKey: `${containerId}:commons:${page_id}:${width ?? 'default'}:${digest}`,
          },
        );
        if (!uploaded.id || !uploaded.path) {
          throw new Error('Wikimedia Commons image upload returned no usable workspace path');
        }
        const uploadedId = uploaded.id;
        const uploadedPath = providerWorkspacePath(uploaded.path);
        const verified = await verifyContainerFile({ client, containerId, signal }, uploadedId, {
          bytes: downloaded.buffer.byteLength,
          sha256: digest,
        });
        if (!verified) {
          throw new Error('Wikimedia Commons image upload could not be verified');
        }
        const image = downloaded.image;
        return {
          status: 'imported',
          path: uploadedPath,
          containerFileId: uploadedId,
          filename: downloaded.filename,
          mimeType: downloaded.mimeType,
          bytes: downloaded.buffer.byteLength,
          pageId: image.pageId,
          title: image.title,
          description: image.description,
          sourceUrl: image.sourceUrl,
          width: image.width,
          height: image.height,
          author: image.author,
          credit: image.credit,
          license: image.license,
          licenseUrl: image.licenseUrl,
          attribution: image.attribution,
          attributionRequired: image.attributionRequired,
        };
      })();
      imported.set(key, pending);
      try {
        return JSON.stringify(await pending);
      } catch (error) {
        imported.delete(key);
        throw error;
      }
    },
  });

  registerDefinition(agent, SEARCH_COMMONS_IMAGES_DEF);
  registerDefinition(agent, IMPORT_COMMONS_IMAGE_DEF);
  return {
    tools: new Map<string, DynamicStructuredTool>([
      [SEARCH_COMMONS_IMAGES_TOOL_NAME, searchTool],
      [IMPORT_COMMONS_IMAGE_TOOL_NAME, importTool],
    ]),
  };
}
