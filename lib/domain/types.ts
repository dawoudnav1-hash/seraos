import { z } from 'zod';

/** The explicit lifecycle of a run. Status is stored, never inferred. */
export const RUN_STATUSES = [
  'queued',
  'planning',
  'executing',
  'blocked',
  'review_ready',
  'viewed',
  'approved',
  'rejected',
  'archived',
  'failed',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const SPECIALISTS = [
  'LedgerAgent',
  'ReconciliationAgent',
  'TechnicalAccountingAgent',
  'TaxAgent',
  'ReportingAgent',
  'CashAgent',
  'QualityControlAgent',
] as const;
export type SpecialistName = (typeof SPECIALISTS)[number];

export const TOOL_NAMES = [
  'fetchTrialBalance',
  'fetchSubledger',
  'parseDocument',
  'postJournalEntry',
  'buildWorkbook',
  'renderPdf',
  'requestHumanInput',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Tools that mutate the ledger or leave the building. Gated on human approval. */
export const MUTATING_TOOLS: readonly ToolName[] = ['postJournalEntry'];

export const stepSchema = z.object({
  id: z.string(),
  title: z.string(),
  agent: z.enum(SPECIALISTS),
  tools: z.array(z.enum(TOOL_NAMES)),
  status: z.enum(['pending', 'running', 'blocked', 'completed', 'failed']).default('pending'),
});
export type Step = z.infer<typeof stepSchema>;

export const blockerSchema = z.object({
  id: z.string(),
  stepId: z.string().optional(),
  reason: z.enum(['missing_document', 'approval_required', 'policy_decision', 'low_confidence']),
  title: z.string(),
  detail: z.string(),
  resolution: z.object({
    kind: z.enum(['upload_file', 'confirm', 'answer_question', 'approve']),
    label: z.string(),
    /** Optional secondary action, e.g. "Confirm goods receipt" next to an upload. */
    secondaryLabel: z.string().optional(),
  }),
});
export type Blocker = z.infer<typeof blockerSchema>;

export const artifactSchema = z.object({
  id: z.string(),
  filename: z.string(),
  kind: z.enum(['xlsx', 'pdf', 'docx', 'csv']),
  sizeBytes: z.number(),
  url: z.string(),
  generatedBy: z.enum(SPECIALISTS),
});
export type Artifact = z.infer<typeof artifactSchema>;

/** Every figure an agent reports links back to the tool result that produced it. */
export const provenanceSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
  stepId: z.string(),
  tool: z.enum(TOOL_NAMES),
  toolCallId: z.string(),
  note: z.string().optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/** Common tail of every specialist's typed output. */
export const specialistOutputBase = z.object({
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  openQuestions: z.array(z.string()),
  provenance: z.array(provenanceSchema),
});

/** Below this, the run routes to `blocked` instead of `review_ready`. */
export const CONFIDENCE_FLOOR = 0.7;

export type AgentEvent =
  | { type: 'plan_created'; steps: Step[] }
  | { type: 'step_started'; stepId: string; agent: SpecialistName }
  | { type: 'tool_called'; stepId: string; tool: ToolName; args: unknown; toolCallId?: string }
  | { type: 'tool_result'; stepId: string; ok: boolean; summary: string; toolCallId?: string; provenance?: Provenance[] }
  | { type: 'progress'; stepId: string; pct: number; note: string }
  | { type: 'blocked'; blocker: Blocker }
  | { type: 'unblocked' }
  | { type: 'artifact_created'; artifact: Artifact }
  | { type: 'step_completed'; stepId: string }
  | { type: 'run_completed'; summary: string }
  | { type: 'run_failed'; error: string };

export interface RunView {
  id: string;
  title: string;
  task: string;
  status: RunStatus;
  agent: SpecialistName;
  description: string;
  progressPct: number;
  steps: Step[];
  blocker: Blocker | null;
  artifacts: Artifact[];
  provenance: Provenance[];
  confidence: number | null;
  openQuestions: string[];
  rejectionReason: string | null;
  createdAt: number;
  updatedAt: number;
}
