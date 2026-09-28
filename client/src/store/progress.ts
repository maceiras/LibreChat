import { atomFamily } from 'recoil';
import type { ResponseProgress } from 'librechat-data-provider';

export const responseProgressByMessageId = atomFamily<ResponseProgress | undefined, string>({
  key: 'responseProgressByMessageId',
  default: undefined,
});

/** A continued response can reuse its message ID with a new timeline. */
export function latestResponseProgress(
  next?: ResponseProgress,
  previous?: ResponseProgress,
): ResponseProgress | undefined {
  if (!next) return previous;
  if (!previous) return next;
  if (next.startedAt !== previous.startedAt)
    return next.startedAt > previous.startedAt ? next : previous;
  return next.sequence > previous.sequence ? next : previous;
}
