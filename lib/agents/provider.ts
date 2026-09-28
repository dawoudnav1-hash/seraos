import type { AgentEvent, SpecialistName, ToolName } from '@/lib/domain/types';
import type { ToolResult } from './tools/types';

export interface AgentInput {
  runId: string;
  task: string;
  title: string;
  specialist: SpecialistName;
  /** A rejection reason fed back in, when the human reopened the run. */
  instruction?: string;
  /** Set once a human has resolved the blocker that stopped this run. */
  resolvedBlockerIds?: string[];
  /** Answers to the clarifying questions, keyed by question id. */
  answers?: Record<string, string>;
  /** Files the human attached as context. */
  contextFiles?: string[];
  /**
   * Tool execution belongs to the orchestrator, not the model: allow-listing and
   * the approval gate must hold whichever provider is in play.
   */
  callTool(stepId: string, tool: ToolName, args: unknown): Promise<ToolResult>;
}

export interface AgentProvider {
  readonly id: string;
  runAgent(input: AgentInput): AsyncIterable<AgentEvent>;
}

let cached: AgentProvider | null = null;

/** Mock unless VERT_PROVIDER=claude and a key is present. */
export async function getProvider(): Promise<AgentProvider> {
  if (cached) return cached;
  if (process.env.VERT_PROVIDER === 'claude' && process.env.ANTHROPIC_API_KEY) {
    const { ClaudeProvider } = await import('./providers/claude');
    cached = new ClaudeProvider(process.env.ANTHROPIC_API_KEY);
  } else {
    const { MockProvider } = await import('./providers/mock');
    // Paced so a person can watch a run stream in; tests construct their own at 0ms.
    cached = new MockProvider({ tickMs: Number(process.env.VERT_TICK_MS ?? 650) });
  }
  return cached;
}

export function setProvider(p: AgentProvider | null): void {
  cached = p;
}
