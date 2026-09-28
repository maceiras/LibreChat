import { Providers, initializeModel } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { getOpenAIConfig } from './config';

describe('OpenAI hosted Code Interpreter', () => {
  it.each([true, false, undefined])(
    'declares the native tool only when code_execution=%s is true',
    (code_execution) => {
      const { llmConfig, tools } = getOpenAIConfig('test-key', {
        modelOptions: { model: 'gpt-4.1', code_execution },
      });
      expect(tools).toEqual(
        code_execution ? [{ type: 'code_interpreter', container: { type: 'auto' } }] : [],
      );
      expect(llmConfig.useResponsesApi).toBe(code_execution ? true : undefined);
      expect(llmConfig).not.toHaveProperty('code_execution');
      expect(llmConfig.modelKwargs ?? {}).not.toHaveProperty('code_execution');
    },
  );

  it('honors defaultParams, explicit false, addParams and dropParams', () => {
    const options = {
      modelOptions: { model: 'gpt-4.1', code_execution: false },
      customParams: { paramDefinitions: [{ key: 'code_execution', default: true }] },
    };
    expect(
      getOpenAIConfig('key', { ...options, modelOptions: { model: 'gpt-4.1' } }).tools,
    ).toHaveLength(1);
    expect(getOpenAIConfig('key', options).tools).toEqual([]);
    expect(
      getOpenAIConfig('key', { ...options, addParams: { code_execution: true } }).tools,
    ).toHaveLength(1);
    expect(
      getOpenAIConfig('key', {
        ...options,
        addParams: { code_execution: true },
        dropParams: ['code_execution'],
      }).tools,
    ).toEqual([]);
  });

  it('does not send the native tool to OpenRouter', () => {
    const result = getOpenAIConfig('key', {
      reverseProxyUrl: 'https://openrouter.ai/api/v1',
      modelOptions: { model: 'openai/gpt-4.1', code_execution: true },
    });
    expect(result.tools).toEqual([]);
    expect(result.llmConfig).not.toHaveProperty('code_execution');
    expect(result.llmConfig.modelKwargs ?? {}).not.toHaveProperty('code_execution');
  });

  it.each([false, true])(
    'sends both tools and receives native results through the SDK (streaming=%s)',
    async (streaming) => {
      const annotation = {
        type: 'container_file_citation',
        file_id: 'cfile_test',
        container_id: 'cntr_test',
        filename: 'report.csv',
        start_index: 0,
        end_index: 2,
      };
      const codeResult = {
        type: 'code_interpreter_call',
        id: 'ci_test',
        code: 'print(6 * 7)',
        container_id: 'cntr_test',
        status: 'completed',
        outputs: [{ type: 'logs', logs: '42' }],
      };
      const response = {
        id: 'resp_test',
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'gpt-4.1',
        output: [
          codeResult,
          {
            type: 'message',
            id: 'msg_test',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '42', annotations: [annotation] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      const events = [
        { type: 'response.output_item.done', output_index: 0, item: codeResult },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'message', id: 'msg_test' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_test',
          output_index: 1,
          content_index: 0,
          delta: '42',
        },
        {
          type: 'response.output_text.annotation.added',
          item_id: 'msg_test',
          output_index: 1,
          content_index: 0,
          annotation_index: 0,
          annotation,
        },
        { type: 'response.completed', response },
      ];
      const fetch = jest
        .fn()
        .mockResolvedValue(
          new Response(
            streaming
              ? events
                  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                  .join('')
              : JSON.stringify(response),
            { headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' } },
          ),
        );
      const { llmConfig, tools, configOptions } = getOpenAIConfig('test-key', {
        streaming,
        modelOptions: {
          model: 'gpt-4.1',
          code_execution: true,
          web_search: true,
          useResponsesApi: false,
        },
      });
      const model = initializeModel({
        provider: Providers.OPENAI,
        tools,
        clientOptions: {
          ...llmConfig,
          configuration: { ...configOptions, fetch },
        },
      });
      const result = await model.invoke([new HumanMessage('Calculate six times seven.')]);
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: '42',
            annotations: [
              expect.objectContaining({
                source: 'container_file_citation',
                file_id: 'cfile_test',
                container_id: 'cntr_test',
                title: 'report.csv',
              }),
            ],
          }),
        ]),
      );
      expect(result.additional_kwargs.tool_outputs).toEqual(
        expect.arrayContaining([expect.objectContaining(codeResult)]),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, request] = fetch.mock.calls[0];
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(request.body);
      expect(body.tools).toEqual([
        { type: 'code_interpreter', container: { type: 'auto' } },
        { type: 'web_search' },
      ]);
      expect(body.tool_choice).toBeUndefined();
      expect(body.code_execution).toBeUndefined();
    },
  );
});
