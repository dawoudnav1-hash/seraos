import { z } from 'zod';

/** The explicit lifecycle of a run. Status is stored, never inferred. */
export const RUN_STATUSES = [
  'queued',
  'clarifying',
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
  'renderDocx',
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

export const sheetPreviewSchema = z.object({
  name: z.string(),
  rows: z.array(z.array(z.union([z.string(), z.number()]))),
});
export type SheetPreview = z.infer<typeof sheetPreviewSchema>;

export const artifactSchema = z.object({
  id: z.string(),
  filename: z.string(),
  kind: z.enum(['xlsx', 'pdf', 'docx', 'csv']),
  sizeBytes: z.number(),
  url: z.string(),
  generatedBy: z.enum(SPECIALISTS),
  /** The same rows/paragraphs the file was written from, for in-app preview. */
  sheets: z.array(sheetPreviewSchema).optional(),
  paragraphs: z.array(z.string()).optional(),
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

/** A question Vert asks before it plans, the way a preparer would. */
export const clarificationSchema = z.object({
  id: z.string(),
  phase: z.enum(['Understanding', 'Scope', 'Data', 'Outputs', 'Review']),
  question: z.string(),
  help: z.string(),
  /** How the answer reads once it is known, e.g. "Reporting currency: USD". */
  known: z.string(),
});
export type Clarification = z.infer<typeof clarificationSchema>;

/**
 * A table an agent built from tool results. Each cell that carries a figure
 * points at the source record, so the plan document stays auditable.
 */
export interface EvidenceTable {
  id: string;
  title: string;
  /** Tables sharing a section render under one heading. */
  section?: string;
  caption?: string;
  /** Filled in by the provider: which step and tool produced the table. */
  stepId?: string;
  tool?: ToolName;
  columns: string[];
  rows: { cells: (string | number)[]; source?: string; emphasis?: boolean }[];
}

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
  | { type: 'clarification_requested'; questions: Clarification[]; intro: string; why?: string }
  | { type: 'plan_created'; steps: Step[]; scope?: string; reasoning?: string[] }
  | { type: 'step_started'; stepId: string; agent: SpecialistName }
  | { type: 'tool_called'; stepId: string; tool: ToolName; args: unknown; toolCallId?: string }
  | {
      type: 'tool_result';
      stepId: string;
      ok: boolean;
      summary: string;
      toolCallId?: string;
      provenance?: Provenance[];
      table?: EvidenceTable;
    }
  | { type: 'progress'; stepId: string; pct: number; note: string }
  | { type: 'blocked'; blocker: Blocker }
  | { type: 'unblocked' }
  | { type: 'artifact_created'; artifact: Artifact }
  | { type: 'step_completed'; stepId: string }
  | { type: 'run_completed'; summary: string; findings?: string[]; assumptions?: string[] }
  | { type: 'run_failed'; error: string };

export interface ClarificationView extends Clarification {
  askedAt: number;
  answer: string | null;
  answeredAt: number | null;
}

export interface ApprovalView {
  by: string;
  role: string;
  at: number;
}

/** Nothing finalizes until two different people have approved it. */
export const APPROVALS_REQUIRED = 2;

export interface RunView {
  id: string;
  title: string;
  task: string;
  /** The client entity the work is for, e.g. "Brevard Logistics". */
  client: string;
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
  clarificationIntro: string;
  /** Why the answers matter, shown beside the questions. */
  clarificationWhy: string;
  clarifications: ClarificationView[];
  contextFiles: string[];
  scope: string;
  reasoning: string[];
  tables: EvidenceTable[];
  findings: string[];
  assumptions: string[];
  approvals: ApprovalView[];
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
