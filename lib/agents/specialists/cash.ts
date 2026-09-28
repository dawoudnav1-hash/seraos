import { z } from 'zod';
import { specialistOutputBase } from '@/lib/domain/types';
import type { Specialist } from './base';

export const cashOutputSchema = specialistOutputBase.extend({
  weeks: z.number(),
  endingCashCents: z.number(),
  runwayMonths: z.number(),
});

export const CashAgent: Specialist<typeof cashOutputSchema> = {
  name: 'CashAgent',
  tools: ['fetchTrialBalance', 'fetchSubledger', 'buildWorkbook'],
  systemPrompt:
    'You build 13-week direct cash flow projections and runway estimates. ' +
    'State the burn assumption on its own line; a runway figure without its burn assumption is not an answer.',
  outputSchema: cashOutputSchema,
  plan: () => [
    { title: 'Pull opening cash and AR/AP aging', agent: 'CashAgent', tools: ['fetchTrialBalance', 'fetchSubledger'] },
    { title: 'Project 13 weeks of receipts and disbursements', agent: 'CashAgent', tools: [] },
    { title: 'Build projection workbook', agent: 'CashAgent', tools: ['buildWorkbook'] },
  ],
};
