import type { Provenance, ToolName } from '@/lib/domain/types';

export interface ToolContext {
  runId: string;
  stepId: string;
  /**
   * Resolves an approval for a mutating tool. The orchestrator supplies a real
   * gate; nothing may post to the ledger without one.
   */
  approvals: ApprovalGate;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
}

export interface ApprovalGate {
  /** Returns the approval for this run, or null when no human has signed off. */
  find(runId: string): ApprovalRecord | null;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  summary: string;
  data: T;
  provenance: Provenance[];
}

export interface Tool<Args, Out> {
  name: ToolName;
  mutating: boolean;
  run(args: Args, ctx: ToolContext): Promise<ToolResult<Out>>;
}

export class ApprovalRequiredError extends Error {
  readonly code = 'APPROVAL_REQUIRED';
  constructor(tool: ToolName, runId: string) {
    super(`${tool} is gated: run ${runId} has no human approval on file.`);
    this.name = 'ApprovalRequiredError';
  }
}

let provSeq = 0;
export function provenance(
  ctx: ToolContext,
  tool: ToolName,
  toolCallId: string,
  label: string,
  value: string,
  note?: string,
): Provenance {
  return { id: `prov_${ctx.runId}_${++provSeq}`, label, value, stepId: ctx.stepId, tool, toolCallId, note };
}
