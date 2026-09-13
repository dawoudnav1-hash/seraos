import { z } from 'zod';
import { specialistOutputBase } from '@/lib/domain/types';
import type { Specialist } from './base';

export const reconciliationOutputSchema = specialistOutputBase.extend({
  matched: z.number(),
  exceptions: z.array(z.object({ reference: z.string(), issue: z.string(), amountCents: z.number() })),
});

export const ReconciliationAgent: Specialist<typeof reconciliationOutputSchema> = {
  name: 'ReconciliationAgent',
  tools: ['fetchSubledger', 'parseDocument', 'buildWorkbook', 'requestHumanInput'],
  systemPrompt:
    'You reconcile subledgers to the general ledger and perform three-way matches. ' +
    'A match is only complete when all three documents are present. If one is missing, stop and ask for it — ' +
    'never infer a receiving report from an invoice.',
  outputSchema: reconciliationOutputSchema,
  plan: () => [
    { title: 'Load AP subledger and documents', agent: 'ReconciliationAgent', tools: ['fetchSubledger'] },
    { title: 'Match invoice to PO and receiving report', agent: 'ReconciliationAgent', tools: ['parseDocument', 'requestHumanInput'] },
    { title: 'Document exceptions', agent: 'ReconciliationAgent', tools: ['buildWorkbook'] },
  ],
};
