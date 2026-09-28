import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, fireEvent } from '@testing-library/react';
import { EToolResources } from 'librechat-data-provider';
import type { TFileConfig } from 'librechat-data-provider';
import DragDropModal from '../DragDropModal';

let mockFileConfig: TFileConfig = {};

jest.mock('~/data-provider', () => ({
  useGetFileConfig: ({ select }) => ({ data: select(mockFileConfig) }),
  useGetEndpointsQuery: () => ({ data: {} }),
  useGetAgentByIdQuery: () => ({ data: undefined }),
}));

jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => ({}),
}));

jest.mock('~/Providers', () => ({
  useDragDropContext: () => ({ endpoint: 'openAI', conversationId: 'new' }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGetAgentsConfig: () => ({ agentsConfig: undefined }),
  useAgentCapabilities: jest.requireActual('~/hooks/Agents/useAgentCapabilities').default,
  useAgentToolPermissions: () => ({
    fileSearchAllowedByAgent: true,
    codeAllowedByAgent: true,
  }),
}));

jest.mock('~/store', () => ({
  ephemeralAgentByConvoId: jest.requireActual('recoil').atomFamily({
    key: 'upload-menu-test-agent',
    default: {},
  }),
}));

const document = new File(['docx'], 'document.docx', {
  type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});
const pdf = new File(['pdf'], 'document.pdf', { type: 'application/pdf' });

function renderMenu(files: File[]) {
  const onOptionSelect = jest.fn();
  render(
    <RecoilRoot>
      <DragDropModal
        files={files}
        isVisible={true}
        setShowModal={jest.fn()}
        onOptionSelect={onOptionSelect}
      />
    </RecoilRoot>,
  );
  return onOptionSelect;
}

describe('drag and drop upload options', () => {
  beforeEach(() => {
    mockFileConfig = {};
  });

  it('offers provider first for office documents with a permissive configuration', () => {
    mockFileConfig = { endpoints: { openAI: { supportedMimeTypes: ['.*'] } } };
    const onSelect = renderMenu([document]);
    const provider = screen.getByRole('button', { name: 'com_ui_upload_provider' });
    const text = screen.getByRole('button', { name: 'com_ui_upload_ocr_text' });
    expect(provider.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(provider);
    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it('retains provider first for mixed provider/text batches', () => {
    const onSelect = renderMenu([pdf, document]);
    const provider = screen.getByRole('button', { name: 'com_ui_upload_provider' });
    fireEvent.click(provider);
    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it('offers text before other tools when no file supports provider upload', () => {
    const onSelect = renderMenu([document]);
    expect(
      screen.queryByRole('button', { name: 'com_ui_upload_provider' }),
    ).not.toBeInTheDocument();
    const text = screen.getByRole('button', { name: 'com_ui_upload_ocr_text' });
    const search = screen.getByRole('button', { name: 'com_ui_upload_file_search' });
    expect(text.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(text);
    expect(onSelect).toHaveBeenCalledWith(EToolResources.context);
  });

  it('does not offer provider for a batch containing an unsupported file', () => {
    renderMenu([pdf, new File(['unknown'], 'unknown.unknown')]);
    expect(
      screen.queryByRole('button', { name: 'com_ui_upload_provider' }),
    ).not.toBeInTheDocument();
  });
});
