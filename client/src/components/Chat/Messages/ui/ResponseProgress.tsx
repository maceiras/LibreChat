import { useEffect, useMemo, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { responseProgressSchema } from 'librechat-data-provider';
import { Check, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import type { ResponseStage } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { responseProgressByMessageId, latestResponseProgress } from '~/store/progress';
import useLocalize from '~/hooks/useLocalize';

const labels: Record<ResponseStage, TranslationKeys> = {
  preparing: 'com_ui_progress_preparing',
  searching: 'com_ui_progress_searching',
  coding: 'com_ui_progress_coding',
  executing: 'com_ui_progress_executing',
  responding: 'com_ui_progress_responding',
  files: 'com_ui_progress_files',
};

function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function ResponseProgress({
  messageId,
  persisted,
  isSubmitting,
}: {
  messageId: string;
  persisted?: unknown;
  isSubmitting: boolean;
}) {
  const localize = useLocalize();
  const live = useRecoilValue(responseProgressByMessageId(messageId.replace(/_+$/, '')));
  const saved = useMemo(() => {
    const result = responseProgressSchema.safeParse(persisted);
    return result.success ? result.data : undefined;
  }, [persisted]);
  const progress = latestResponseProgress(live, saved);
  const running = progress?.status === 'running' && isSubmitting;
  const [clockEnd, setClockEnd] = useState<number>();
  useEffect(() => {
    if (!running) return;
    setClockEnd(Date.now());
    const timer = window.setInterval(() => setClockEnd(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, messageId]);
  if (!progress) return null;

  const current = progress.steps[progress.steps.length - 1];
  const end = progress.endedAt ?? Math.max(clockEnd ?? 0, progress.updatedAt);
  const settledStatus = progress.status === 'running' ? 'cancelled' : progress.status;
  const status = running ? 'running' : settledStatus;
  const statusKeys = {
    completed: 'com_ui_progress_completed',
    failed: 'com_ui_progress_failed',
    cancelled: 'com_ui_progress_cancelled',
    incomplete: 'com_ui_progress_incomplete',
  } as const;
  const label = status === 'running' ? labels[current.stage] : statusKeys[status];
  const SettledIcon = status === 'completed' ? Check : CircleAlert;
  const Icon = running ? LoaderCircle : SettledIcon;

  return (
    <details className="group/progress my-2 rounded-lg border border-border-light px-3 py-2 text-sm text-text-secondary">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 ${running ? 'animate-spin motion-reduce:animate-none' : ''}`}
        />
        <span role="status" aria-live="polite" className="flex-1">
          {localize(label)}
        </span>
        <span className="tabular-nums" aria-label={localize('com_ui_progress_elapsed')}>
          {duration(end - progress.startedAt)}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="h-4 w-4 transition-transform group-open/progress:rotate-90"
        />
      </summary>
      <ol
        aria-label={localize('com_ui_progress_steps')}
        className="mt-3 space-y-2 border-t border-border-light pt-3"
      >
        {progress.steps.map((step, index) => (
          <li key={`${index}-${step.startedAt}`} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary"
            />
            <span className="flex-1">{localize(labels[step.stage])}</span>
            <span className="text-xs tabular-nums">
              {duration((step.endedAt ?? end) - step.startedAt)}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
