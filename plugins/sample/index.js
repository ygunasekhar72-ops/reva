// Sample REVA plugin. Demonstrates the two plugin capabilities:
//  - registering a tool the model can call (plugin__sample__word_count)
//  - subscribing to lifecycle events
export function activate(ctx) {
  ctx.log('sample plugin activating with permissions:', ctx.permissions.join(', '));

  ctx.registerTool({
    name: 'word_count',
    description: 'Count words, lines and characters of a given text.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to analyze' },
      },
      required: ['text'],
    },
    async execute(args) {
      const text = String(args.text ?? '');
      return {
        text: `words=${text.split(/\s+/).filter(Boolean).length} lines=${text.split('\n').length} chars=${text.length}`,
      };
    },
  });

  ctx.on('message:new', (payload) => {
    ctx.log(`session ${payload.session} got a ${payload.text.length}-char message`);
  });

  ctx.on('tool:after', (payload) => {
    if (!payload.ok) ctx.log(`tool ${payload.tool} failed: ${payload.error}`);
  });
}
