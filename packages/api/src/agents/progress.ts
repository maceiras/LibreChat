import { z } from 'zod';
import { Readable } from 'node:stream';
import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import { StepEvents, responseProgressSchema } from 'librechat-data-provider';
import type { ResponseProgress, ResponseStage } from 'librechat-data-provider';
import type { OpenAIClientOptions } from '@librechat/agents';

type ResponsesFetch = NonNullable<NonNullable<OpenAIClientOptions['configuration']>['fetch']>;

const stages: Partial<Record<string, ResponseStage>> = {
  'response.created': 'preparing',
  'response.web_search_call.in_progress': 'searching',
  'response.web_search_call.searching': 'searching',
  'response.web_search_call.completed': 'preparing',
  'response.code_interpreter_call.in_progress': 'coding',
  'response.code_interpreter_call.interpreting': 'executing',
  'response.code_interpreter_call.completed': 'preparing',
  'response.output_text.delta': 'responding',
};

type TerminalStatus = Exclude<ResponseProgress['status'], 'running'>;

export interface ResponseProgressTracker {
  stage: (value: ResponseStage) => Promise<void>;
  finish: (status: TerminalStatus) => Promise<void>;
  snapshot: () => ResponseProgress | undefined;
  bind: (id: string, signal: AbortSignal) => void;
  event: (name: string) => Promise<void>;
}

function finishSnapshot(
  state: ResponseProgress,
  status: TerminalStatus,
  time: number,
): ResponseProgress {
  if (state.status !== 'running') return state;
  const endedAt = Math.max(time, state.updatedAt);
  return {
    ...state,
    status,
    sequence: state.sequence + 1,
    updatedAt: endedAt,
    endedAt,
    steps: state.steps.map((step) => (step.endedAt == null ? { ...step, endedAt } : step)),
  };
}

const replaySchema = z.array(z.object({ event: z.string(), data: z.unknown() }));

/** The abort route may run on another replica, so restore the latest persisted snapshot. */
export function readAbortedResponseProgress(
  replayEvents?: string | null,
): ResponseProgress | undefined {
  if (!replayEvents) return;
  try {
    const events = replaySchema.safeParse(JSON.parse(replayEvents));
    if (!events.success) return;
    let latest: ResponseProgress | undefined;
    for (const event of events.data) {
      if (event.event !== StepEvents.ON_RESPONSE_PROGRESS) continue;
      const parsed = responseProgressSchema.safeParse(event.data);
      if (parsed.success && (!latest || parsed.data.sequence > latest.sequence))
        latest = parsed.data;
    }
    return latest ? finishSnapshot(latest, 'cancelled', Date.now()) : undefined;
  } catch {
    return;
  }
}

/** Request-scoped, bounded snapshots. Never includes prompts, code or provider payloads. */
export function createResponseProgress(
  emit: (progress: ResponseProgress) => void | Promise<void>,
  now: () => number = Date.now,
): ResponseProgressTracker {
  let messageId = '';
  let state: ResponseProgress | undefined;
  let pending = Promise.resolve();
  let removeAbortListener: (() => void) | undefined;
  const publish = () => {
    if (!state) return pending;
    const snapshot = state;
    pending = pending
      .then(() => emit(snapshot))
      .catch(() => {
        logger.warn('[Response progress] Unable to publish status');
      });
    return pending;
  };
  const finish = (status: Exclude<ResponseProgress['status'], 'running'>) => {
    removeAbortListener?.();
    if (!state || state.status !== 'running') return pending;
    state = finishSnapshot(state, status, now());
    return publish();
  };
  const stage = (value: ResponseStage) => {
    if (!messageId || (state && state.status !== 'running')) return pending;
    if (state?.steps[state.steps.length - 1]?.stage === value) return pending;
    const time = Math.max(now(), state?.updatedAt ?? 0);
    const steps =
      state?.steps.map((step) => (step.endedAt == null ? { ...step, endedAt: time } : step)) ?? [];
    state = {
      messageId,
      sequence: (state?.sequence ?? 0) + 1,
      startedAt: state?.startedAt ?? time,
      updatedAt: time,
      status: 'running',
      steps: [...steps.slice(-63), { stage: value, startedAt: time }],
    };
    return publish();
  };
  return {
    stage,
    finish,
    snapshot: () => state,
    bind(id: string, signal: AbortSignal) {
      removeAbortListener?.();
      messageId = id;
      const onAbort = () => {
        void finish('cancelled');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    },
    async event(name: string) {
      if (name === 'response.failed' || name === 'error') return finish('failed');
      if (name === 'response.incomplete') return finish('incomplete');
      const next = stages[name];
      if (next) await stage(next);
    },
  };
}

/** Observe SSE event headers with bounded memory; pass through the original bytes unchanged. */
export function observeResponsesFetch(
  fetch: ResponsesFetch,
  progress: ResponseProgressTracker,
): ResponsesFetch {
  return async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (!/\/responses(?:\?|$)/.test(url) || init?.method?.toUpperCase() !== 'POST') {
      return fetch(input, init);
    }
    if (!init.signal?.aborted) await progress.stage('preparing');
    const response = await fetch(input, init);
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.includes('text/event-stream')
    ) {
      return response;
    }
    const body = response.body;
    const reader = (body instanceof Readable ? Readable.toWeb(body) : body).getReader();
    const decoder = new TextDecoder();
    let line = '';
    let overflow = false;
    let event = '';
    let afterCR = false;
    const observe = async (chunk: Uint8Array) => {
      const text = decoder.decode(chunk, { stream: true });
      for (const character of text) {
        if (character === '\n' && afterCR) {
          afterCR = false;
          continue;
        }
        afterCR = character === '\r';
        if (character !== '\n' && character !== '\r') {
          if (line.length < 256) line += character;
          else overflow = true;
          continue;
        }
        if (!overflow && line.startsWith('event:')) event = line.slice(6).trim();
        if (!overflow && line === '' && event) {
          await progress.event(event);
          event = '';
        }
        line = '';
        overflow = false;
      }
    };
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              reader.releaseLock();
              return;
            }
            await observe(value);
            controller.enqueue(value);
          } catch (error) {
            controller.error(error);
            reader.releaseLock();
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
          reader.releaseLock();
        },
      }),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  };
}

/** Clone only the visible primary agent; keep its configured transport and security controls. */
export function withResponseProgress<T extends { provider: string; model_parameters?: object }>(
  agent: T,
  progress: ResponseProgressTracker,
  messageId: string,
  signal: AbortSignal,
): T {
  const options = agent.model_parameters as OpenAIClientOptions | undefined;
  if (
    (agent.provider !== Providers.OPENAI && agent.provider !== Providers.AZURE) ||
    options?.useResponsesApi !== true
  )
    return agent;
  progress.bind(messageId, signal);
  return {
    ...agent,
    model_parameters: {
      ...options,
      configuration: {
        ...options.configuration,
        fetch: observeResponsesFetch(options.configuration?.fetch ?? globalThis.fetch, progress),
      },
    },
  };
}
