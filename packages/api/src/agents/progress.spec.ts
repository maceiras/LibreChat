import { Readable } from 'node:stream';
import { Response as NodeResponse } from 'node-fetch';
import { Providers, initializeModel } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import type { ResponseProgress } from 'librechat-data-provider';
import { createResponseProgress, observeResponsesFetch, withResponseProgress } from './progress';
import { getOpenAIConfig } from '../endpoints/openai/config';

const endpoint = 'https://api.openai.com/v1/responses';
const sse = (type: string, data: object = {}) =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, ...data })}\r\n\r\n`;

function setup() {
  const snapshots: ResponseProgress[] = [];
  let time = 1000;
  const progress = createResponseProgress(
    (value) => {
      snapshots.push(value);
    },
    () => time,
  );
  const controller = new AbortController();
  progress.bind('message-1', controller.signal);
  return {
    progress,
    snapshots,
    controller,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('Responses progress', () => {
  it('deduplicates deltas, keeps immutable real steps, and waits for local files before finishing', async () => {
    const { progress, snapshots, advance } = setup();
    await progress.stage('preparing');
    advance(2000);
    await progress.event('response.code_interpreter_call.in_progress');
    await progress.event('response.code_interpreter_call_code.delta');
    advance(3000);
    await progress.event('response.code_interpreter_call.interpreting');
    await progress.event('response.code_interpreter_call_code.delta');
    await progress.event('response.completed');
    expect(progress.snapshot()?.status).toBe('running');
    advance(1000);
    await progress.stage('files');
    advance(1500);
    await progress.finish('completed');
    expect(snapshots).toHaveLength(5);
    expect(snapshots[0].steps[0].endedAt).toBeUndefined();
    expect(progress.snapshot()).toMatchObject({
      status: 'completed',
      startedAt: 1000,
      endedAt: 8500,
    });
    expect(progress.snapshot()?.steps.map((step) => step.stage)).toEqual([
      'preparing',
      'coding',
      'executing',
      'files',
    ]);
  });

  it.each(['response.failed', 'response.incomplete', 'error'])(
    'preserves terminal %s despite cleanup',
    async (event) => {
      const { progress } = setup();
      await progress.stage('preparing');
      await progress.event(event);
      await progress.stage('files');
      await progress.finish('completed');
      expect(progress.snapshot()?.status).toBe(
        event === 'response.incomplete' ? 'incomplete' : 'failed',
      );
    },
  );

  it('freezes immediately on abort and bounds history', async () => {
    const { progress, controller, advance } = setup();
    for (let index = 0; index < 100; index++) {
      await progress.stage(index % 2 ? 'coding' : 'executing');
      advance(100);
    }
    controller.abort();
    const stopped = progress.snapshot();
    advance(5000);
    await progress.finish('completed');
    expect(progress.snapshot()).toEqual(stopped);
    expect(stopped?.status).toBe('cancelled');
    expect(stopped?.steps).toHaveLength(64);
  });

  it('passes split CRLF SSE bytes through unchanged without retaining large data lines', async () => {
    const { progress, snapshots } = setup();
    const raw =
      sse('response.web_search_call.searching', { ignored: 'x'.repeat(10000) }) +
      sse('response.code_interpreter_call.interpreting');
    const bytes = new TextEncoder().encode(raw);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, ++offset));
      },
    });
    const transport = jest.fn().mockResolvedValue(
      new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-1' },
      }),
    );
    const response = await observeResponsesFetch(transport, progress)(endpoint, { method: 'POST' });
    expect(await response.text()).toBe(raw);
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(snapshots.map((item) => item.steps[item.steps.length - 1].stage)).toEqual([
      'preparing',
      'searching',
      'executing',
    ]);
  });

  it('supports the configured node-fetch transport and preserves request options', async () => {
    const { progress, controller } = setup();
    const raw = sse('response.code_interpreter_call.interpreting');
    const transport = jest.fn().mockResolvedValue(
      new NodeResponse(Readable.from([Buffer.from(raw)]), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const init = { method: 'POST', signal: controller.signal, headers: { 'x-custom': 'kept' } };
    const response = await observeResponsesFetch(transport, progress)(endpoint, init);
    expect(await response.text()).toBe(raw);
    expect(transport).toHaveBeenCalledWith(endpoint, init);
    expect(progress.snapshot()?.steps[1].stage).toBe('executing');
  });

  it('does not fail generation if the progress sink fails', async () => {
    const progress = createResponseProgress(async () => {
      throw new Error('Status transport unavailable');
    });
    progress.bind('message-1', new AbortController().signal);
    const raw = sse('response.code_interpreter_call.interpreting');
    const transport = jest
      .fn()
      .mockResolvedValue(new Response(raw, { headers: { 'content-type': 'text/event-stream' } }));
    const response = await observeResponsesFetch(transport, progress)(endpoint, { method: 'POST' });
    expect(await response.text()).toBe(raw);
    await expect(progress.finish('completed')).resolves.toBeUndefined();
  });

  it('propagates cancellation to the original reader', async () => {
    const { progress } = setup();
    const cancel = jest.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'text/event-stream' },
    });
    const wrapped = await observeResponsesFetch(jest.fn().mockResolvedValue(response), progress)(
      endpoint,
      { method: 'POST' },
    );
    await wrapped.body?.cancel('stopped');
    expect(cancel).toHaveBeenCalledWith('stopped');
  });

  it('leaves unrelated endpoints and non-SSE responses intact', async () => {
    const { progress } = setup();
    const response = new Response('{}', { headers: { 'content-type': 'application/json' } });
    const transport = observeResponsesFetch(jest.fn().mockResolvedValue(response), progress);
    expect(await transport('https://api.openai.com/v1/chat/completions', { method: 'POST' })).toBe(
      response,
    );
    expect(progress.snapshot()).toBeUndefined();
    expect(await transport(endpoint, { method: 'POST' })).toBe(response);
  });

  it('observes native events discarded by the real SDK without changing its answer or usage', async () => {
    const { progress, snapshots, controller } = setup();
    const response = {
      id: 'resp-1',
      object: 'response',
      status: 'completed',
      model: 'gpt-4.1',
      output: [],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    };
    const raw =
      sse('response.created', { response }) +
      sse('response.web_search_call.searching') +
      sse('response.code_interpreter_call.in_progress') +
      sse('response.code_interpreter_call.interpreting') +
      sse('response.output_item.added', {
        output_index: 0,
        item: { type: 'message', id: 'msg-1' },
      }) +
      sse('response.output_text.delta', {
        item_id: 'msg-1',
        output_index: 0,
        content_index: 0,
        delta: '42',
      }) +
      sse('response.completed', { response });
    const fetch = jest
      .fn()
      .mockResolvedValue(new Response(raw, { headers: { 'content-type': 'text/event-stream' } }));
    const { llmConfig, configOptions, tools } = getOpenAIConfig('test-key', {
      streaming: true,
      modelOptions: { model: 'gpt-4.1', code_execution: true },
    });
    const original = {
      provider: Providers.OPENAI,
      model_parameters: { ...llmConfig, configuration: { ...configOptions, fetch } },
    };
    const agent = withResponseProgress(original, progress, 'message-1', controller.signal);
    expect(original.model_parameters.configuration.fetch).toBe(fetch);
    const model = initializeModel({
      provider: agent.provider,
      clientOptions: agent.model_parameters,
      tools,
    });
    const result = await model.invoke([new HumanMessage('Calculate six times seven.')]);
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: '42' })]),
    );
    expect(result.usage_metadata?.total_tokens).toBe(12);
    expect(snapshots.map((item) => item.steps[item.steps.length - 1].stage)).toEqual([
      'preparing',
      'searching',
      'coding',
      'executing',
      'responding',
    ]);
    expect(progress.snapshot()?.status).toBe('running');
  });
});
