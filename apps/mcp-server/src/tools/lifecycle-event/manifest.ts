import type { ToolRegistration } from '../../framework/tool-registry.js';
import { createLifecycleEventHandler, type LifecycleEventHandlerDeps } from './handler.js';
import { type LifecycleEventInput, lifecycleEventInputSchema, lifecycleEventOutputSchema } from './schema.js';

export function createLifecycleEventToolRegistration(
  deps: LifecycleEventHandlerDeps,
): ToolRegistration<typeof lifecycleEventInputSchema, typeof lifecycleEventOutputSchema> {
  return {
    name: 'lifecycle_event',
    title: 'Coodra: lifecycle_event',
    description:
      'Call this only from Coodra-managed native agent plugin hooks, not during normal chat. Native Codex and Claude Code plugins use it to send lifecycle events through the bundled Coodra MCP server instead of the older HTTP hooks bridge. It normalizes the hook payload, resolves the current run, applies pre-tool policy checks, records lightweight activity, and returns hook JSON in hookOutput. Returns the agent-facing hook decision plus Coodra metadata for debugging.',
    inputSchema: lifecycleEventInputSchema,
    outputSchema: lifecycleEventOutputSchema,
    idempotencyKey(input: LifecycleEventInput) {
      const payload =
        input !== null && typeof input === 'object' && input.rawPayload !== null && typeof input.rawPayload === 'object'
          ? input.rawPayload
          : {};
      const eventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'Unknown';
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : 'unknown-session';
      const turnId =
        typeof payload.tool_use_id === 'string'
          ? payload.tool_use_id
          : typeof payload.tool_call_id === 'string'
            ? payload.tool_call_id
            : typeof payload.turn_id === 'string'
              ? payload.turn_id
              : 'no-turn';
      return {
        kind: 'mutating',
        key: `lifecycle_event:${input?.agentType ?? 'unknown'}:${sessionId}:${eventName}:${turnId}`.slice(0, 200),
      };
    },
    handler: createLifecycleEventHandler(deps),
  };
}
