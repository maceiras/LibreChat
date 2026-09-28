import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, render, screen } from '@testing-library/react';
import type { ResponseProgress as Progress } from 'librechat-data-provider';
import { responseProgressByMessageId } from '~/store/progress';
import ResponseProgress from '../ResponseProgress';

const startedAt = new Date('2026-09-28T10:00:00Z').getTime();
const snapshot: Progress = {
  messageId: 'message-1',
  sequence: 2,
  status: 'running',
  startedAt,
  updatedAt: startedAt + 2000,
  steps: [
    { stage: 'preparing', startedAt, endedAt: startedAt + 2000 },
    { stage: 'executing', startedAt: startedAt + 2000 },
  ],
};

describe('ResponseProgress', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(startedAt + 5000);
  });
  afterEach(() => jest.useRealTimers());

  it('shows the actual live stage, ticks independently, and only lists observed stages', () => {
    render(
      <RecoilRoot
        initializeState={({ set }) => set(responseProgressByMessageId('message-1'), snapshot)}
      >
        <ResponseProgress messageId="message-1_" isSubmitting={true} />
      </RecoilRoot>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Running Python');
    expect(screen.getByLabelText('Elapsed time')).toHaveTextContent('5s');
    act(() => jest.advanceTimersByTime(3000));
    expect(screen.getByLabelText('Elapsed time')).toHaveTextContent('8s');
    expect(screen.queryByText('Searching the web')).not.toBeInTheDocument();
  });

  it.each(['completed', 'cancelled', 'failed', 'incomplete'] as const)(
    'restores and freezes %s history after reload',
    (status) => {
      render(
        <RecoilRoot>
          <ResponseProgress
            messageId="message-1"
            isSubmitting={false}
            persisted={{
              ...snapshot,
              status,
              endedAt: startedAt + 25000,
              updatedAt: startedAt + 25000,
            }}
          />
        </RecoilRoot>,
      );
      expect(screen.getByLabelText('Elapsed time')).toHaveTextContent('25s');
      act(() => jest.advanceTimersByTime(30000));
      expect(screen.getByLabelText('Elapsed time')).toHaveTextContent('25s');
      expect(document.querySelector('details')).not.toHaveAttribute('open');
    },
  );

  it('prefers saved final state over an older live snapshot', () => {
    render(
      <RecoilRoot
        initializeState={({ set }) => set(responseProgressByMessageId('message-1'), snapshot)}
      >
        <ResponseProgress
          messageId="message-1"
          isSubmitting={false}
          persisted={{ ...snapshot, sequence: 3, status: 'completed', endedAt: startedAt + 6000 }}
        />
      </RecoilRoot>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Completed');
    expect(screen.getByLabelText('Elapsed time')).toHaveTextContent('6s');
  });

  it('stops ticking if the stream ends without a final progress event', () => {
    const view = render(
      <RecoilRoot>
        <ResponseProgress messageId="message-1" persisted={snapshot} isSubmitting={true} />
      </RecoilRoot>,
    );
    view.rerender(
      <RecoilRoot>
        <ResponseProgress messageId="message-1" persisted={snapshot} isSubmitting={false} />
      </RecoilRoot>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Stopped');
    const elapsed = screen.getByLabelText('Elapsed time').textContent;
    expect(elapsed).toBe('5s');
    act(() => jest.advanceTimersByTime(30000));
    expect(screen.getByLabelText('Elapsed time')).toHaveTextContent(elapsed ?? '');
  });

  it('does not show a fabricated status for historical messages or invalid metadata', () => {
    const { container } = render(
      <RecoilRoot>
        <ResponseProgress
          messageId="message-1"
          isSubmitting={false}
          persisted={{ status: 'running' }}
        />
      </RecoilRoot>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
