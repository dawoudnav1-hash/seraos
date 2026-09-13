import type { SpecialistName } from '@/lib/domain/types';
import type { Specialist } from './base';
import { LedgerAgent } from './ledger';
import { ReconciliationAgent } from './reconciliation';
import { TechnicalAccountingAgent } from './technical-accounting';
import { TaxAgent } from './tax';
import { ReportingAgent } from './reporting';
import { CashAgent } from './cash';
import { QualityControlAgent } from './quality-control';

export const SPECIALIST_REGISTRY: Record<SpecialistName, Specialist> = {
  LedgerAgent,
  ReconciliationAgent,
  TechnicalAccountingAgent,
  TaxAgent,
  ReportingAgent,
  CashAgent,
  QualityControlAgent,
};

/** Picks the specialist that owns a task, from its wording. */
export function routeTask(task: string): SpecialistName {
  const t = task.toLowerCase();
  if (/(three-way|reconcil|bank rec|subledger rec|match)/.test(t)) return 'ReconciliationAgent';
  if (/(asc 606|asc 842|asc 450|asc 855|revenue recognition|lease|memo|disclosure)/.test(t)) return 'TechnicalAccountingAgent';
  if (/(163\(j\)|1065|k-1|tax|provision|add-back)/.test(t)) return 'TaxAgent';
  if (/(board|reporting pack|flux|p&l|financial statements? for quality|quality control)/.test(t) && /quality/.test(t))
    return 'QualityControlAgent';
  if (/(board|reporting pack|flux|consolidat)/.test(t)) return 'ReportingAgent';
  if (/(cash flow|runway|13-week|forecast)/.test(t)) return 'CashAgent';
  if (/(journal entry|payroll|accrual|reclass|book )/.test(t)) return 'LedgerAgent';
  if (/(quality|footing|tie out|completeness)/.test(t)) return 'QualityControlAgent';
  return 'ReportingAgent';
}

export type { Specialist };
export { LedgerAgent, ReconciliationAgent, TechnicalAccountingAgent, TaxAgent, ReportingAgent, CashAgent, QualityControlAgent };
