import type { Effect, ModelTier } from './types';

/**
 * The capability catalog the product must support. Each entry becomes a skill
 * (with a SKILL.md playbook) as implementations land; the catalog fixes the id,
 * the scheduling effect and the model tier up front.
 *
 * Model rule: 'none' for anything computational, matching, posting or parsing;
 * 'small' for extraction, OCR and categorization fallback; 'frontier' only for
 * planning, ambiguity and narrative.
 *
 * Effect rule: 'read' has no side effects and may run in parallel; 'propose'
 * produces a reviewable artifact (entry, rec, schedule, workpaper); 'write'
 * mutates an external system and only ever acts on approved proposals.
 *
 * `dependsOn` lists capabilities whose output this one consumes, so a planner
 * can assemble a close DAG from the catalog alone.
 */

export const CAPABILITY_FAMILIES = [
  'transaction_processing',
  'reconciliations',
  'journal_entries',
  'schedules',
  'analysis',
  'documents',
  'reuse',
] as const;
export type CapabilityFamily = (typeof CAPABILITY_FAMILIES)[number];

export interface CapabilityEntry {
  id: string;
  family: CapabilityFamily;
  name: string;
  effect: Effect;
  model: ModelTier;
  dependsOn?: readonly string[];
}

const c = (
  family: CapabilityFamily,
  id: string,
  name: string,
  effect: Effect,
  model: ModelTier,
  dependsOn?: readonly string[],
): CapabilityEntry => (dependsOn ? { id, family, name, effect, model, dependsOn } : { id, family, name, effect, model });

export const CAPABILITY_CATALOG: readonly CapabilityEntry[] = Object.freeze([
  // Transaction processing: rules first; a small model only when no rule codes the line.
  c('transaction_processing', 'code-bank-transactions', 'Code bank transactions', 'propose', 'small'),
  c('transaction_processing', 'categorize-expenses', 'Categorize expenses', 'propose', 'small'),
  c('transaction_processing', 'detect-unmatched', 'Detect unmatched transactions', 'read', 'none'),
  c('transaction_processing', 'exclude-invalid-transactions', 'Exclude invalid transactions', 'propose', 'none', ['detect-unmatched']),
  c('transaction_processing', 'sync-approved-transactions', 'Sync approved transactions', 'write', 'none', ['code-bank-transactions', 'categorize-expenses']),

  // Reconciliations: one matching engine, no model.
  c('reconciliations', 'bank-reconciliation', 'Bank reconciliation', 'propose', 'none', ['exclude-invalid-transactions']),
  c('reconciliations', 'credit-card-reconciliation', 'Credit card reconciliation', 'propose', 'none', ['exclude-invalid-transactions']),
  c('reconciliations', 'gl-reconciliation', 'GL reconciliation', 'propose', 'none'),
  c('reconciliations', 'stripe-reconciliation', 'Stripe reconciliation', 'propose', 'none'),
  c('reconciliations', 'flag-exceptions', 'Flag reconciliation exceptions', 'read', 'none', ['detect-unmatched']),

  // Journal entries: one validated builder, no model; posting is a separate write.
  c('journal_entries', 'manual-je', 'Manual journal entry', 'propose', 'none'),
  c('journal_entries', 'accrual-je', 'Accrual journal entry', 'propose', 'none', ['accrual-schedule']),
  c('journal_entries', 'reversing-je', 'Reversing journal entry', 'propose', 'none', ['accrual-je']),
  c('journal_entries', 'payroll-je', 'Payroll journal entry', 'propose', 'none'),
  c('journal_entries', 'revenue-recognition-je', 'Revenue recognition entry', 'propose', 'none', ['deferred-revenue-schedule']),
  c('journal_entries', 'depreciation-je', 'Depreciation entry', 'propose', 'none', ['depreciation-schedule']),
  c('journal_entries', 'amortization-je', 'Amortization entry', 'propose', 'none', ['amortization-schedule']),
  c('journal_entries', 'prepaid-je', 'Prepaid expense entry', 'propose', 'none', ['prepaid-schedule']),
  c('journal_entries', 'fixed-asset-je', 'Fixed-asset capitalization and disposal entry', 'propose', 'none', ['fixed-asset-rollforward']),
  c('journal_entries', 'attach-evidence', 'Attach evidence to entries', 'propose', 'none'),
  c('journal_entries', 'sync-approved-jes', 'Sync approved journal entries', 'write', 'none', ['attach-evidence']),

  // Schedules: opening + additions − reductions = closing, per-type calculators.
  c('schedules', 'fixed-asset-rollforward', 'Fixed-asset roll-forward', 'propose', 'none', ['depreciation-schedule']),
  c('schedules', 'depreciation-schedule', 'Depreciation schedule', 'propose', 'none'),
  c('schedules', 'amortization-schedule', 'Amortization schedule', 'propose', 'none'),
  c('schedules', 'deferred-revenue-schedule', 'Deferred revenue schedule', 'propose', 'none'),
  c('schedules', 'prepaid-schedule', 'Prepaid schedule', 'propose', 'none'),
  c('schedules', 'accrual-schedule', 'Accrual schedule', 'propose', 'none'),
  c('schedules', 'balance-sheet-rollforward', 'Balance sheet roll-forward', 'propose', 'none'),

  // Analysis: one comparison engine; the frontier model only writes the narrative.
  c('analysis', 'data-analysis', 'Data analysis', 'read', 'none'),
  c('analysis', 'flux-analysis', 'Flux analysis', 'read', 'none'),
  c('analysis', 'variance-analysis', 'Variance analysis with explanations', 'read', 'frontier'),
  c('analysis', 'budget-vs-actual', 'Budget vs actual', 'read', 'none'),
  c('analysis', 'period-over-period', 'Period-over-period comparison', 'read', 'none'),
  c('analysis', 'revenue-analysis', 'Revenue analysis', 'read', 'none'),
  c('analysis', 'expense-analysis', 'Expense analysis', 'read', 'none'),
  c('analysis', 'waterfall-analysis', 'Waterfall analysis', 'read', 'none'),
  c('analysis', 'management-commentary', 'Management commentary', 'propose', 'frontier', ['flux-analysis', 'variance-analysis']),

  // Documents: digital files parse deterministically; OCR and table extraction use a small model.
  c('documents', 'read-pdf', 'Read PDF', 'read', 'none'),
  c('documents', 'ocr-document', 'OCR document', 'read', 'small'),
  c('documents', 'extract-tables', 'Extract tables', 'read', 'small'),
  c('documents', 'read-excel', 'Read Excel workbook', 'read', 'none'),
  c('documents', 'create-spreadsheet', 'Create spreadsheet', 'propose', 'none'),
  c('documents', 'modify-spreadsheet', 'Modify spreadsheet', 'propose', 'none'),
  c('documents', 'merge-split-pdf', 'Merge or split PDF', 'propose', 'none'),
  c('documents', 'generate-workpaper', 'Generate workpaper', 'propose', 'none'),

  // Reuse: adapting a saved workflow to a new engagement is planning.
  c('reuse', 'reuse-workflow', 'Reuse a saved workflow', 'read', 'frontier'),
]);

export const CAPABILITY_IDS = CAPABILITY_CATALOG.map((e) => e.id);

export function capability(id: string): CapabilityEntry | undefined {
  return CAPABILITY_CATALOG.find((e) => e.id === id);
}

export function capabilitiesIn(family: CapabilityFamily): CapabilityEntry[] {
  return CAPABILITY_CATALOG.filter((e) => e.family === family);
}
