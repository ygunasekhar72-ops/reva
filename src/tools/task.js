// task tool: spawns a subagent (child AgentSession) for delegated work.
// Multi-agent orchestration emerges from the parent issuing several task calls
// in one turn — they execute concurrently (bounded by max_concurrent_subagents).
export const taskTool = {
  name: 'task',
  description: 'Spawn a subagent to handle a self-contained piece of work and report back. Use for parallel exploration, research, or isolating a risky step. The subagent sees the same workspace and tools (mode=explore gives it read-only tools).',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Full, self-contained task description for the subagent' },
      mode: { type: 'string', enum: ['general', 'explore'], description: 'explore = read-only investigation' },
      model: { type: 'string', description: 'Optional model override for this subagent' },
    },
    required: ['prompt'],
  },
  async execute(args, ctx) {
    const session = ctx.session;
    if (!session || typeof session.spawnSubagent !== 'function') {
      throw new Error('subagents are not available in this context');
    }
    if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
      throw new Error('prompt is required');
    }
    ctx.emit?.({ type: 'spawning_subagent', mode: args.mode ?? 'general' });
    const result = await session.spawnSubagent({
      prompt: args.prompt,
      mode: args.mode === 'explore' ? 'explore' : 'general',
      model: typeof args.model === 'string' && args.model.length > 0 ? args.model : undefined,
    });
    return {
      text: result.text,
      iterations: result.iterations,
      usage: result.usage,
    };
  },
};
