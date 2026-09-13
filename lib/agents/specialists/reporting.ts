import { z } from 'zod';
import { specialistOutputBase } from '@/lib/domain/types';
import type { Specialist } from './base';

export const reportingOutputSchema = specialistOutputBase.extend({
  entities: z.array(z.string()),
  statements: z.array(z.enum(['P&L', 'Balance Sheet', 'Cash Flow'])),
  fluxCommentary: z.array(z.string()),
});

export const ReportingAgent: Specialist<typeof reportingOutputSchema> = {
  name: 'ReportingAgent',
  tools: ['fetchTrialBalance', 'fetchSubledger', 'buildWorkbook', 'renderPdf'],
  systemPrompt:
    'You assemble board reporting packs: consolidated P&L, balance sheet and cash flow with intercompany eliminations, ' +
    'plus flux commentary. Eliminations must be shown as their own column, never silently netted.',
  outputSchema: reportingOutputSchema,
  plan: () => [
    { title: 'Consolidate entity trial balances', agent: 'ReportingAgent', tools: ['fetchTrialBalance'] },
    { title: 'Eliminate intercompany activity', agent: 'ReportingAgent', tools: ['fetchSubledger'] },
    { title: 'Build pack and board memo', agent: 'ReportingAgent', tools: ['buildWorkbook', 'renderPdf'] },
  ],
};
