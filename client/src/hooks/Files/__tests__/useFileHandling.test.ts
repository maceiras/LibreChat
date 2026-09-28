import { createElement } from 'react';
import { render, fireEvent, renderHook, act, waitFor } from '@testing-library/react';
import {
  Constants,
  EModelEndpoint,
  EToolResources,
  getEndpointFileConfig,
} from 'librechat-data-provider';
import type { Agent, TFileConfig, TEndpointsConfig, TConversation } from 'librechat-data-provider';
import type { ChangeEvent } from 'react';

beforeAll(() => {
  global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = jest.fn();
  Object.defineProperty(global, 'Image', {
    writable: true,
    value: class {
      width = 640;
      height = 480;
      onload: (() => void) | null = null;

      set src(_src: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  });
});

const mockShowToast = jest.fn();
const mockSetFilesLoading = jest.fn();
const mockMutate = jest.fn();
const mockProcessFileForUpload = jest.fn(
  async (_file: File, _quality?: number, _onProgress?: (progress: number) => void) => _file,
);
const mockLocalize = jest.fn((key: string) => key);

let mockConversation: Partial<Omit<TConversation, 'endpoint' | 'endpointType'>> & {
  endpoint?: string | null;
  endpointType?: string | null;
} = {};
let mockIsTemporary = false;
let mockFileConfig: TFileConfig | null = null;
let mockEndpointsConfig: TEndpointsConfig | undefined;
let mockAgent:
  | { provider: Agent['provider']; model_parameters?: Partial<Agent['model_parameters']> }
  | undefined;

jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => ({}),
}));

jest.mock('~/Providers/ChatContext', () => ({
  useChatContext: jest.fn(() => ({
    files: new Map(),
    setFiles: jest.fn(),
    setFilesLoading: mockSetFilesLoading,
    conversation: mockConversation,
  })),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: jest.fn(() => ({
    showToast: mockShowToast,
  })),
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: jest.fn(() => jest.fn()),
  useRecoilValue: jest.fn(() => mockIsTemporary),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { isTemporary: { key: 'isTemporary' } },
  ephemeralAgentByConvoId: jest.fn(() => ({ key: 'mock' })),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(() => ({
    getQueryData: jest.fn(),
    refetchQueries: jest.fn(),
  })),
}));

jest.mock('~/data-provider', () => ({
  useGetFileConfig: jest.fn(({ select }) => ({
    data: mockFileConfig ? select(mockFileConfig) : null,
  })),
  useGetEndpointsQuery: jest.fn(() => ({ data: mockEndpointsConfig })),
  useGetAgentByIdQuery: jest.fn(() => ({ data: mockAgent })),
  useUploadFileMutation: jest.fn((_opts: Record<string, unknown>) => ({
    mutate: mockMutate,
  })),
}));

jest.mock('~/hooks/useLocalize', () => {
  const fn = jest.fn(() => mockLocalize) as jest.Mock & {
    TranslationKeys: Record<string, never>;
  };
  fn.TranslationKeys = {};
  return { __esModule: true, default: fn, TranslationKeys: {} };
});

jest.mock('../useDelayedUploadToast', () => ({
  useDelayedUploadToast: jest.fn(() => ({
    startUploadTimer: jest.fn(),
    clearUploadTimer: jest.fn(),
  })),
}));

jest.mock('~/utils/heicConverter', () => ({
  processFileForUpload: mockProcessFileForUpload,
}));

jest.mock('../useClientResize', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    resizeImageIfNeeded: jest.fn(async (file: File) => ({ file, resized: false })),
  })),
}));

jest.mock('../useUpdateFiles', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    addFile: jest.fn(),
    replaceFile: jest.fn(),
    updateFileById: jest.fn(),
    deleteFileById: jest.fn(),
  })),
}));

jest.mock('~/utils', () => ({
  logger: { log: jest.fn() },
  validateFiles: jest.fn(() => true),
  cachePreview: jest.fn(),
  getCachedPreview: jest.fn(() => undefined),
}));

const mockValidateFiles = jest.requireMock('~/utils').validateFiles;

function pickFiles(onChange: (event: ChangeEvent<HTMLInputElement>) => void, files: File[]) {
  const view = render(createElement('input', { type: 'file', 'aria-label': 'Files', onChange }));
  fireEvent.change(view.getByLabelText('Files'), { target: { files } });
}

describe('useFileHandling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessFileForUpload.mockImplementation(async (file: File) => file);
    mockConversation = {};
    mockIsTemporary = false;
    mockFileConfig = null;
    mockEndpointsConfig = undefined;
    mockAgent = undefined;
  });

  const loadHook = async () => (await import('../useFileHandling')).default;

  describe('paperclip and drop routing', () => {
    beforeEach(() => {
      mockConversation = { endpoint: 'openAI', conversationId: 'convo-1' };
      mockFileConfig = {};
      mockValidateFiles.mockImplementation(jest.requireActual('~/utils/files').validateFiles);
    });

    afterEach(() => {
      mockValidateFiles.mockImplementation(() => true);
    });

    it.each(['picker', 'drop'] as const)(
      '%s prioritizes provider per file and falls back to text in a mixed batch',
      async (method) => {
        const useFileHandling = await loadHook();
        const { result } = renderHook(() => useFileHandling());
        const fileList = [
          new File(['pdf'], 'document.pdf', { type: 'application/pdf' }),
          new File(['docx'], 'document.docx', {
            type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          }),
          new File(['xlsx'], 'workbook.xlsx', {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }),
          new File(['notes'], 'notes.txt', { type: 'text/plain' }),
        ];
        if (method === 'picker') {
          pickFiles(result.current.handleFileChange, fileList);
        } else {
          await act(async () => {
            await result.current.handleFiles(fileList);
          });
        }
        await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(4));
        const routes = mockMutate.mock.calls.map(([body]: [FormData]) => body.get('tool_resource'));
        expect(routes).toEqual([
          null,
          EToolResources.context,
          EToolResources.context,
          EToolResources.context,
        ]);
      },
    );

    it.each(['picker', 'drop'] as const)(
      '%s honors the permissive OpenAI configuration',
      async (method) => {
        mockFileConfig = { endpoints: { openAI: { supportedMimeTypes: ['.*'] } } };
        const useFileHandling = await loadHook();
        const { result } = renderHook(() => useFileHandling());
        const fileList = [
          new File(['docx'], 'document.docx', {
            type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          }),
          new File(['slides'], 'slides.pptx', {
            type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          }),
        ];
        if (method === 'picker') {
          pickFiles(result.current.handleFileChange, fileList);
        } else {
          await act(async () => {
            await result.current.handleFiles(fileList);
          });
        }
        await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(2));
        for (const [body] of mockMutate.mock.calls) {
          expect(body.get('tool_resource')).toBeNull();
        }
      },
    );

    it.each([EToolResources.context, EToolResources.file_search, EToolResources.execute_code])(
      'preserves explicit %s selection',
      async (toolResource) => {
        const useFileHandling = await loadHook();
        const { result } = renderHook(() => useFileHandling());
        await act(async () => {
          await result.current.handleFiles(
            [new File(['pdf'], 'document.pdf', { type: 'application/pdf' })],
            toolResource,
          );
        });
        expect(mockMutate).toHaveBeenCalledTimes(1);
        expect(mockMutate.mock.calls[0][0].get('tool_resource')).toBe(toolResource);
      },
    );

    it('resolves an agent provider and its Responses setting', async () => {
      mockConversation = {
        endpoint: 'agents',
        endpointType: EModelEndpoint.agents,
        agent_id: 'agent-1',
      };
      mockAgent = { provider: 'azureOpenAI', model_parameters: { useResponsesApi: true } };
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      await act(async () => {
        await result.current.handleFiles([
          new File(['pdf'], 'document.pdf', { type: 'application/pdf' }),
        ]);
      });
      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockMutate.mock.calls[0][0].get('tool_resource')).toBeNull();
    });

    it('does not fall back to text when the context capability is disabled', async () => {
      mockEndpointsConfig = { agents: { capabilities: [], order: 0 } };
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      await act(async () => {
        await result.current.handleFiles([
          new File(['docx'], 'document.docx', {
            type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          }),
        ]);
      });
      expect(mockMutate).not.toHaveBeenCalled();
      expect(mockSetFilesLoading).toHaveBeenCalledWith(false);
    });

    it.each([
      { disabled: true },
      { fileLimit: 1 },
      { totalSizeLimit: 0.000001 },
      { fileSizeLimit: 0.000001 },
    ])('enforces endpoint limits across a mixed batch: %j', async (limits) => {
      mockFileConfig = { endpoints: { openAI: limits } };
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      await act(async () => {
        await result.current.handleFiles([
          new File(['pdf'], 'document.pdf', { type: 'application/pdf' }),
          new File(['docx'], 'document.docx', {
            type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          }),
        ]);
      });
      expect(mockMutate).not.toHaveBeenCalled();
      expect(mockSetFilesLoading).toHaveBeenCalledWith(false);
    });

    it('rejects duplicate files before uploading a mixed batch', async () => {
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());
      const docx = new File(['docx'], 'document.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      await act(async () => {
        await result.current.handleFiles([
          new File(['pdf'], 'document.pdf', { type: 'application/pdf' }),
          docx,
          docx,
        ]);
      });
      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  describe('endpointOverride', () => {
    it('uploads non-HEIC images without running HEIC conversion', async () => {
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const imageFile = new File(['maybe-heic'], 'photo.jpg', { type: 'image/jpeg' });

      await act(async () => {
        await result.current.handleFiles([imageFile]);
      });

      expect(mockProcessFileForUpload).not.toHaveBeenCalled();
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });

    it('uses conversation endpoint when no override is provided', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      const validateCall = mockValidateFiles.mock.calls[0][0];
      const configResult = getEndpointFileConfig({
        endpoint: 'openAI',
        endpointType: 'custom',
        fileConfig: null,
      });
      expect(validateCall.endpointFileConfig).toEqual(configResult);
    });

    it('uses endpointOverride for validation instead of conversation endpoint', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({ endpointOverride: EModelEndpoint.agents }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      const validateCall = mockValidateFiles.mock.calls[0][0];
      const agentsConfig = getEndpointFileConfig({
        endpoint: EModelEndpoint.agents,
        endpointType: EModelEndpoint.agents,
        fileConfig: null,
      });
      expect(validateCall.endpointFileConfig).toEqual(agentsConfig);
    });

    it('falls back to conversation endpoint when endpointOverride is undefined', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'anthropic',
        endpointType: undefined,
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling({ endpointOverride: undefined }));

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      const validateCall = mockValidateFiles.mock.calls[0][0];
      const anthropicConfig = getEndpointFileConfig({
        endpoint: 'anthropic',
        endpointType: undefined,
        fileConfig: null,
      });
      expect(validateCall.endpointFileConfig).toEqual(anthropicConfig);
    });

    it('sends correct endpoint in upload form data when override is set', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          endpointOverride: EModelEndpoint.agents,
          additionalMetadata: { agent_id: 'agent-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe(EModelEndpoint.agents);
      expect(formData.get('endpointType')).toBe(EModelEndpoint.agents);
      expect(formData.get('conversationId')).toBeNull();
    });

    it('does not enter assistants upload path when override is agents', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'assistants',
        endpointType: 'assistants',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          endpointOverride: EModelEndpoint.agents,
          additionalMetadata: { agent_id: 'agent-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe(EModelEndpoint.agents);
      expect(formData.get('message_file')).toBeNull();
      expect(formData.get('version')).toBeNull();
      expect(formData.get('model')).toBeNull();
      expect(formData.get('assistant_id')).toBeNull();
    });

    it('enters assistants path without override when conversation is assistants', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'assistants',
        endpointType: 'assistants',
        assistant_id: 'asst-456',
        model: 'gpt-4',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe('assistants');
      expect(formData.get('message_file')).toBe('true');
    });

    it('falls back to "default" when no conversation endpoint and no override', async () => {
      mockConversation = {
        conversationId: Constants.NEW_CONVO as string,
        endpoint: null,
        endpointType: undefined,
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe('default');
      expect(formData.get('conversationId')).toBeNull();
    });

    it('sends temporary flag for temporary chat uploads', async () => {
      mockIsTemporary = true;
      mockConversation = {
        conversationId: Constants.NEW_CONVO as string,
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('conversationId')).toBeNull();
      expect(formData.get('isTemporary')).toBe('true');
    });

    it('does not send temporary flag for assistant builder uploads', async () => {
      mockIsTemporary = true;
      mockConversation = {
        conversationId: 'temporary-convo',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          additionalMetadata: { assistant_id: 'asst-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('assistant_id')).toBe('asst-123');
      expect(formData.get('conversationId')).toBeNull();
      expect(formData.get('isTemporary')).toBeNull();
    });

    it('does not send temporary flag for agent builder uploads', async () => {
      mockIsTemporary = true;
      mockConversation = {
        conversationId: 'temporary-convo',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          endpointOverride: EModelEndpoint.agents,
          additionalMetadata: { agent_id: 'agent-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('agent_id')).toBe('agent-123');
      expect(formData.get('conversationId')).toBeNull();
      expect(formData.get('isTemporary')).toBeNull();
    });

    it('awaits HEIC conversion before uploading the converted file', async () => {
      const convertedFile = new File(['jpeg data'], 'photo.jpg', { type: 'image/jpeg' });
      mockProcessFileForUpload.mockImplementationOnce(
        async (_file: File, _quality?: number, onProgress?: (progress: number) => void) => {
          onProgress?.(1);
          return convertedFile;
        },
      );

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const heicFile = new File(['heic data'], 'photo.bin', { type: 'image/heic' });

      await act(async () => {
        await result.current.handleFiles([heicFile]);
      });

      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_info_heic_converting',
        status: 'info',
        duration: 3000,
      });
      expect(mockProcessFileForUpload).toHaveBeenCalledWith(heicFile, 0.9, expect.any(Function));
      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      const uploadedFile = formData.get('file') as File;
      expect(uploadedFile.name).toBe('photo.jpg');
      expect(uploadedFile.type).toBe('image/jpeg');
    });
  });
});
