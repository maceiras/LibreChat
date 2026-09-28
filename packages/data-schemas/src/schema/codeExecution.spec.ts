import { model } from 'mongoose';
import presetSchema from './preset';
import convoSchema from './convo';

const Conversation = model('CodeInterpreterConversation', convoSchema);
const Preset = model('CodeInterpreterPreset', presetSchema);

describe('Code Interpreter persistence', () => {
  it.each([true, false, undefined])(
    'preserves code_execution=%s in conversations',
    (code_execution) => {
      const document = new Conversation({ conversationId: 'test', code_execution });
      const restored = new Conversation(JSON.parse(JSON.stringify(document.toObject())));
      expect(restored.get('code_execution')).toBe(code_execution);
    },
  );

  it.each([true, false, undefined])(
    'preserves code_execution=%s in saved presets',
    (code_execution) => {
      const document = new Preset({ presetId: 'test', code_execution });
      const restored = new Preset(JSON.parse(JSON.stringify(document.toObject())));
      expect(restored.get('code_execution')).toBe(code_execution);
    },
  );
});
