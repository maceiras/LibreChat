import { openAISchema, tConversationSchema, tPresetSchema } from './schemas';
import { specsConfigSchema } from './models';

describe('OpenAI Code Interpreter configuration', () => {
  it.each([true, false, undefined])(
    'preserves code_execution=%s through presets and model options',
    (value) => {
      const { list } = specsConfigSchema.parse({
        list: [
          { name: 'code', label: 'Code', preset: { endpoint: 'openAI', code_execution: value } },
        ],
      });
      const preset = tPresetSchema.parse(list[0].preset);
      const conversation = tConversationSchema.parse({
        ...preset,
        conversationId: 'test',
        createdAt: '',
        updatedAt: '',
      });
      expect(openAISchema.parse(conversation).code_execution).toBe(value);
    },
  );

  it('rejects non-boolean values in YAML presets', () => {
    expect(() =>
      specsConfigSchema.parse({
        list: [
          { name: 'code', label: 'Code', preset: { endpoint: 'openAI', code_execution: 'true' } },
        ],
      }),
    ).toThrow();
  });
});
