import React, { useState } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import userEvent from '@testing-library/user-event';
import { dataService, EModelEndpoint, EToolResources } from 'librechat-data-provider';
import type {
  FileConfig,
  TFileConfig,
  TFileUpload,
  TConversation,
  TEndpointsConfig,
} from 'librechat-data-provider';
import type { FileHandlingState } from '~/hooks/Files/useFileHandling';
import type { ExtendedFile } from '~/common';
import { render, screen, fireEvent, waitFor, cleanup } from 'test/layout-test-utils';
import AttachFiles from '../AttachFiles';
import DragDropWrapper from '../DragDropWrapper';

let mockFileConfig: TFileConfig = {};
let mockEndpointsConfig: TEndpointsConfig = {};
let mockSharePointEnabled = false;
let mockConversation = { endpoint: EModelEndpoint.openAI, conversationId: 'new' } as TConversation;
let mockFileState: FileHandlingState;
const mockShowToast = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, uploadFile: jest.fn() },
  };
});

jest.mock('~/hooks/AuthContext', () => ({
  AuthContextProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuthContext: () => ({ user: undefined }),
}));

jest.mock('~/data-provider', () => ({
  useGetFileConfig: ({ select }: { select: (config: TFileConfig) => FileConfig }) => ({
    data: select(mockFileConfig),
  }),
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
  useGetAgentByIdQuery: () => ({ data: undefined }),
  useGetStartupConfig: () => ({ data: { sharePointFilePickerEnabled: mockSharePointEnabled } }),
  useGraphTokenQuery: () => ({ data: undefined, isLoading: false }),
  useUploadFileMutation: jest.requireActual('~/data-provider/Files/mutations')
    .useUploadFileMutation,
}));

jest.mock('~/Providers/AgentsMapContext', () => ({ useAgentsMapContext: () => ({}) }));
jest.mock('~/Providers/ChatContext', () => ({ useChatContext: () => mockFileState }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useSharePointPicker: () => ({
    openSharePointPicker: jest.fn(),
    closeSharePointPicker: jest.fn(),
    cleanup: jest.fn(),
  }),
}));
jest.mock('~/hooks/useLocalize', () => ({ __esModule: true, default: () => (key: string) => key }));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

const pdf = new File(['pdf'], 'document.pdf', { type: 'application/pdf' });
const docx = new File(['docx'], 'document.docx', {
  type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});
const unknownFile = new File(['unknown'], 'unknown.file', { type: 'application/x-unsupported' });

function Uploads({ disabled = false }: { disabled?: boolean }) {
  const [files, setFiles] = useState<Map<string, ExtendedFile>>(new Map());
  const [filesLoading, setFilesLoading] = useState(false);
  mockFileState = { files, setFiles, setFilesLoading, conversation: mockConversation };

  return (
    <DndProvider backend={HTML5Backend}>
      <DragDropWrapper>
        <div data-testid="drop-target">
          <AttachFiles
            disabled={disabled}
            conversationId="new"
            conversation={mockConversation}
            files={files}
            setFiles={setFiles}
            setFilesLoading={setFilesLoading}
          />
          <output data-testid="loading">{String(filesLoading)}</output>
        </div>
      </DragDropWrapper>
    </DndProvider>
  );
}

function selectFiles(method: 'picker' | 'drop', files: File[]) {
  if (method === 'drop') {
    const target = screen.getByTestId('drop-target');
    const dataTransfer = { files, types: ['Files'], items: [], getData: () => '' };
    fireEvent.dragEnter(target, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    return;
  }
  fireEvent.click(screen.getByRole('button', { name: 'com_sidepanel_attach_files' }));
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error('The paperclip did not render a file input');
  }
  fireEvent.change(input, { target: { files } });
}

function assertNoUploadMenu() {
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_upload_provider')).not.toBeInTheDocument();
  expect(screen.queryByText('com_ui_upload_ocr_text')).not.toBeInTheDocument();
}

async function uploadedFile(body: FormData): Promise<TFileUpload> {
  const file = body.get('file');
  if (!(file instanceof File)) {
    throw new Error('Missing upload file');
  }
  const fileId = String(body.get('file_id'));
  return {
    user: 'user-1',
    file_id: fileId,
    temp_file_id: fileId,
    bytes: file.size,
    embedded: false,
    filename: file.name,
    filepath: `/uploads/${fileId}`,
    object: 'file',
    type: file.type,
    usage: 0,
  };
}

beforeAll(() => {
  global.URL.createObjectURL = jest.fn(() => 'blob:upload-test');
  global.URL.revokeObjectURL = jest.fn();
});

beforeEach(() => {
  jest.useFakeTimers();
  mockFileConfig = {};
  mockEndpointsConfig = {};
  mockSharePointEnabled = false;
  mockConversation = { endpoint: EModelEndpoint.openAI, conversationId: 'new' } as TConversation;
  jest.mocked(dataService.uploadFile).mockImplementation(uploadedFile);
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('automatic attachment uploads', () => {
  it('keeps SharePoint accessible through a separate button when enabled', () => {
    mockSharePointEnabled = true;
    render(<Uploads />);
    expect(screen.getByRole('button', { name: 'com_sidepanel_attach_files' })).toBeEnabled();
    assertNoUploadMenu();
    fireEvent.click(screen.getByRole('button', { name: 'com_files_upload_sharepoint' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('hides SharePoint when it is not configured', () => {
    render(<Uploads />);
    expect(screen.queryByRole('button', { name: 'com_files_upload_sharepoint' })).toBeNull();
  });

  it('disables both attachment buttons when inputs are disabled', () => {
    mockSharePointEnabled = true;
    render(<Uploads disabled />);
    expect(screen.getByRole('button', { name: 'com_sidepanel_attach_files' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'com_files_upload_sharepoint' })).toBeDisabled();
  });

  it('opens the local file picker directly when clicking the paperclip', () => {
    render(<Uploads />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) {
      throw new Error('Missing file input');
    }
    const openPicker = jest.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'com_sidepanel_attach_files' }));
    expect(openPicker).toHaveBeenCalledTimes(1);
    assertNoUploadMenu();
  });

  it.each(['{Enter}', ' '])('opens the picker once when activated with %s', async (key) => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<Uploads />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) {
      throw new Error('Missing file input');
    }
    const openPicker = jest.spyOn(input, 'click');
    screen.getByRole('button', { name: 'com_sidepanel_attach_files' }).focus();
    await user.keyboard(key);
    expect(openPicker).toHaveBeenCalledTimes(1);
    assertNoUploadMenu();
  });

  describe.each(['picker', 'drop'] as const)('%s', (method) => {
    it('uploads a supported file to the provider without a mode selection', async () => {
      render(<Uploads />);
      selectFiles(method, [pdf]);
      await waitFor(() => expect(dataService.uploadFile).toHaveBeenCalledTimes(1));
      const [body] = jest.mocked(dataService.uploadFile).mock.calls[0];
      expect(body.get('tool_resource')).toBeNull();
      assertNoUploadMenu();
    });

    it('falls back to text automatically when the provider does not support the format', async () => {
      mockFileConfig = { endpoints: { openAI: { supportedMimeTypes: ['^application/pdf$'] } } };
      render(<Uploads />);
      selectFiles(method, [docx]);
      await waitFor(() => expect(dataService.uploadFile).toHaveBeenCalledTimes(1));
      const [body] = jest.mocked(dataService.uploadFile).mock.calls[0];
      expect(body.get('tool_resource')).toBe(EToolResources.context);
      const fields = Array.from(body.keys());
      expect(fields.indexOf('tool_resource')).toBeLessThan(fields.indexOf('file'));
      assertNoUploadMenu();
    });

    it('sends an explicitly supported office document to the provider', async () => {
      mockFileConfig = { endpoints: { openAI: { supportedMimeTypes: [docx.type] } } };
      render(<Uploads />);
      selectFiles(method, [docx]);
      await waitFor(() => expect(dataService.uploadFile).toHaveBeenCalledTimes(1));
      const [body] = jest.mocked(dataService.uploadFile).mock.calls[0];
      expect(body.get('tool_resource')).toBeNull();
      assertNoUploadMenu();
    });

    it('sends an image accepted only as text through the text extraction endpoint', async () => {
      mockFileConfig = {
        endpoints: { openAI: { supportedMimeTypes: ['^application/pdf$'] } },
        text: { supportedMimeTypes: ['^image/svg\\+xml$'] },
      };
      const svg = new File(
        ['<svg xmlns="http://www.w3.org/2000/svg"><text>Hello</text></svg>'],
        'diagram.svg',
        { type: 'image/svg+xml' },
      );
      render(<Uploads />);
      selectFiles(method, [svg]);
      await waitFor(() => expect(dataService.uploadFile).toHaveBeenCalledTimes(1));
      const [body] = jest.mocked(dataService.uploadFile).mock.calls[0];
      expect(body.get('tool_resource')).toBe(EToolResources.context);
      expect(body.get('width')).toBeNull();
      assertNoUploadMenu();
    });

    it('shows the server error if text extraction fails', async () => {
      jest.mocked(dataService.uploadFile).mockRejectedValueOnce({
        response: { data: { message: 'Text extraction failed' } },
      });
      jest.spyOn(console, 'error').mockImplementation(() => {});
      render(<Uploads />);
      selectFiles(method, [docx]);
      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'error', message: 'Text extraction failed' }),
        ),
      );
      expect(dataService.uploadFile).toHaveBeenCalledTimes(1);
      expect(mockFileState.files.size).toBe(0);
      assertNoUploadMenu();
    });

    it('prefers the provider for office files when the configured MIME list is permissive', async () => {
      mockFileConfig = { endpoints: { openAI: { supportedMimeTypes: ['.*'] } } };
      render(<Uploads />);
      selectFiles(method, [docx]);
      await waitFor(() => expect(dataService.uploadFile).toHaveBeenCalledTimes(1));
      const [body] = jest.mocked(dataService.uploadFile).mock.calls[0];
      expect(body.get('tool_resource')).toBeNull();
      assertNoUploadMenu();
    });

    it('routes each file independently in a mixed batch', async () => {
      render(<Uploads />);
      selectFiles(method, [pdf, docx]);
      await waitFor(() => expect(dataService.uploadFile).toHaveBeenCalledTimes(2));
      const routes = jest
        .mocked(dataService.uploadFile)
        .mock.calls.map(([body]) => body.get('tool_resource'));
      expect(routes).toEqual([null, EToolResources.context]);
      assertNoUploadMenu();
    });

    it('shows an error when neither provider nor text processing accepts the file', async () => {
      mockFileConfig = {
        text: { supportedMimeTypes: ['^text/plain$'] },
        ocr: { supportedMimeTypes: [] },
      };
      render(<Uploads />);
      selectFiles(method, [unknownFile]);
      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'error',
            message: 'Unsupported file type: application/x-unsupported',
          }),
        ),
      );
      expect(dataService.uploadFile).not.toHaveBeenCalled();
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
      assertNoUploadMenu();
    });

    it('shows an error if the required text capability is disabled', async () => {
      mockEndpointsConfig = { agents: { capabilities: [], order: 0 } };
      render(<Uploads />);
      selectFiles(method, [docx]);
      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' })),
      );
      expect(dataService.uploadFile).not.toHaveBeenCalled();
      assertNoUploadMenu();
    });

    it('rejects a mixed batch before any upload when its file limit is exceeded', async () => {
      mockFileConfig = { endpoints: { openAI: { fileLimit: 1 } } };
      render(<Uploads />);
      selectFiles(method, [pdf, docx]);
      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'error', message: 'File limit reached: 1 files' }),
        ),
      );
      expect(dataService.uploadFile).not.toHaveBeenCalled();
    });

    it('respects disabled endpoints', async () => {
      mockFileConfig = { endpoints: { openAI: { disabled: true } } };
      render(<Uploads />);
      selectFiles(method, [pdf]);
      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'error', message: 'com_ui_attach_error_disabled' }),
        ),
      );
      expect(dataService.uploadFile).not.toHaveBeenCalled();
    });
  });
});
