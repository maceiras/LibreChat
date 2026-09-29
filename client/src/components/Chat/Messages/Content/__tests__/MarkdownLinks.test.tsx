import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import { MessageContext } from '~/Providers';
import MarkdownLite from '../MarkdownLite';
import Markdown from '../Markdown';
import { markdownUrlTransform, resolveSandboxAttachment } from '../links';

jest.mock('../Parts/LogLink', () => ({
  __esModule: true,
  default: ({
    href,
    filename,
    file_id,
    user,
    source,
    children,
  }: {
    href: string;
    filename: string;
    file_id?: string;
    user?: string;
    source?: string;
    children: React.ReactNode;
  }) => (
    <a
      href={href}
      data-filename={filename}
      data-file-id={file_id}
      data-user={user}
      data-source={source}
    >
      {children}
    </a>
  ),
}));

const attachment = (file_id: string, filename: string, filepath: string): TAttachment =>
  ({
    file_id,
    filename,
    filepath,
    user: 'user-1',
    source: 'local',
    messageId: 'message-1',
    toolCallId: 'tool-1',
    conversationId: 'conversation-1',
  }) as TAttachment;

const renderWithAttachments = (children: React.ReactNode, attachments: TAttachment[]) =>
  render(
    <RecoilRoot>
      <MessageContext.Provider value={{ messageId: 'message-1', isExpanded: true, attachments }}>
        {children}
      </MessageContext.Provider>
    </RecoilRoot>,
  );

describe('sandbox markdown links', () => {
  it.each([
    [
      'Markdown',
      () => <Markdown content="[Download](sandbox:/mnt/data/deck.pptx)" isLatestMessage={false} />,
    ],
    ['MarkdownLite', () => <MarkdownLite content="[Download](sandbox:/mnt/data/deck.pptx)" />],
  ])('preserves and resolves sandbox links through %s', (_name, createComponent) => {
    renderWithAttachments(createComponent(), [
      attachment('file-1', 'deck.pptx', '/api/files/download/user-1/file-1'),
    ]);

    const link = screen.getByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute('href', '/api/files/download/user-1/file-1');
    expect(link).toHaveAttribute('data-file-id', 'file-1');
    expect(link).toHaveAttribute('data-user', 'user-1');
    expect(link).toHaveAttribute('data-source', 'local');
  });

  it('resolves a nested sandbox path by a unique current-message basename', () => {
    const file = attachment('file-2', 'render.json', '/api/files/download/user-1/file-2');
    expect(
      resolveSandboxAttachment('sandbox:/mnt/data/marmottes_valais_preview_v2/render.json', [file]),
    ).toBe(file);
  });

  it('resolves URL-encoded sandbox filenames', () => {
    const file = attachment('file-2', 'deck final.pptx', '/api/files/download/user-1/file-2');
    expect(resolveSandboxAttachment('sandbox:/mnt/data/deck%20final.pptx', [file])).toBe(file);
  });

  it('prefers an exact nested path over another attachment with the same basename', () => {
    const exact = attachment('file-1', 'current/render.json', '/api/files/download/user-1/file-1');
    const other = attachment('file-2', 'previous/render.json', '/api/files/download/user-1/file-2');
    expect(resolveSandboxAttachment('sandbox:/mnt/data/current/render.json', [other, exact])).toBe(
      exact,
    );
  });

  it('leaves a missing attachment disabled', () => {
    renderWithAttachments(
      <Markdown content="[Missing](sandbox:/mnt/data/missing.pdf)" isLatestMessage={false} />,
      [],
    );

    expect(screen.queryByRole('link', { name: 'Missing' })).not.toBeInTheDocument();
    expect(screen.getByText('Missing')).toHaveAttribute('aria-disabled', 'true');
  });

  it('leaves an ambiguous basename disabled', () => {
    renderWithAttachments(
      <Markdown
        content="[Report](sandbox:/mnt/data/current/render.json)"
        isLatestMessage={false}
      />,
      [
        attachment('file-1', 'first/render.json', '/api/files/download/user-1/file-1'),
        attachment('file-2', 'second/render.json', '/api/files/download/user-1/file-2'),
      ],
    );

    expect(screen.queryByRole('link', { name: 'Report' })).not.toBeInTheDocument();
    expect(screen.getByText('Report')).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps resolution scoped to the attachments supplied by the current message', () => {
    const first = attachment('file-1', 'report.pdf', '/api/files/download/user-1/file-1');
    const second = attachment('file-2', 'report.pdf', '/api/files/download/user-1/file-2');

    expect(resolveSandboxAttachment('sandbox:/mnt/data/report.pdf', [first])).toBe(first);
    expect(resolveSandboxAttachment('sandbox:/mnt/data/report.pdf', [second])).toBe(second);
  });

  it('continues to reject unsupported and out-of-sandbox protocols', () => {
    expect(markdownUrlTransform('javascript:alert(1)', 'href')).toBe('');
    expect(markdownUrlTransform('sandbox:/mnt/data/deck.pptx', 'src')).toBe('');

    renderWithAttachments(
      <Markdown
        content="[Outside](sandbox:/etc/passwd) [Traversal](sandbox:/mnt/data/../secret.txt)"
        isLatestMessage={false}
      />,
      [],
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('Outside')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Traversal')).toHaveAttribute('aria-disabled', 'true');
  });
});
