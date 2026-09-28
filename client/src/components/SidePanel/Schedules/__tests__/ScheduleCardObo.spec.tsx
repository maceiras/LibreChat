import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@librechat/client';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { TSchedule } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import ScheduleCard from '../ScheduleCard';

const mockAuthorize = jest.fn();
const mockRevoke = jest.fn();
const mockInspect = dataService.inspectScheduledObo as jest.MockedFunction<
  typeof dataService.inspectScheduledObo
>;

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, inspectScheduledObo: jest.fn() } };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useClockFormat: () => false,
  useWeekStart: () => 0,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({ root: { name: 'Research Agent' } }),
}));
jest.mock('~/data-provider', () => ({
  useGetAgentByIdQuery: () => ({ data: null }),
  useAuthorizeScheduledOboMutation: () => ({ mutate: mockAuthorize, isLoading: false }),
  useRevokeScheduledOboMutation: () => ({ mutate: mockRevoke, isLoading: false }),
  useDeleteScheduleMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useUpdateScheduleMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useRunScheduleNowMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

const schedule = {
  id: 'sched-1',
  name: 'Morning digest',
  agent_id: 'root',
  cadence: { frequency: 'daily', hour: 9, minute: 0 },
  timezone: 'UTC',
  enabled: false,
  runCount: 0,
  failureCount: 0,
} as TSchedule;

function renderCard() {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(MemoryRouter, null, createElement(ToastProvider, null, children));
  }
  return render(<ScheduleCard schedule={schedule} oboServers={['Files']} />, { wrapper: Wrapper });
}

describe('saved schedule OBO grant actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInspect.mockResolvedValue({
      server: 'Files',
      scopes: 'api://files/Read',
      url: 'https://mcp.example.test',
    });
  });

  it('previews the exact provider scope before authorizing the named server', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: 'com_ui_schedule_obo_authorize' }));
    expect(mockInspect).toHaveBeenCalledWith('sched-1', 'Files');
    const dialog = await screen.findByRole('dialog', { name: 'com_ui_schedule_obo_confirm_title' });
    expect(within(dialog).getByText('api://files/Read')).toBeInTheDocument();
    expect(mockAuthorize).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'com_ui_schedule_obo_authorize' }));
    await waitFor(() =>
      expect(mockAuthorize).toHaveBeenCalledWith({
        id: 'sched-1',
        server: 'Files',
        expectedScopes: 'api://files/Read',
      }),
    );
  });

  it('can revoke only the specified schedule and server', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: 'com_ui_schedule_obo_revoke' }));
    expect(mockRevoke).toHaveBeenCalledWith({ id: 'sched-1', server: 'Files' });
  });
});
