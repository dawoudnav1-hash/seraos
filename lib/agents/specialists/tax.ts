import { z } from 'zod';
import { specialistOutputBase } from '@/lib/domain/types';
import type { Specialist } from './base';

export const taxOutputSchema = specialistOutputBase.extend({
  form: z.string(),
  computedCents: z.number(),
  schedules: z.array(z.string()),
});

export const TaxAgent: Specialist<typeof taxOutputSchema> = {
  name: 'TaxAgent',
  tools: ['fetchTrialBalance', 'fetchSubledger', 'parseDocument', 'buildWorkbook', 'renderPdf'],
  systemPrompt:
    'You prepare tax workpapers: Section 163(j) interest add-backs, Form 1065 and K-1 allocations, and provision support. ' +
    'Tie every computed figure to the federal form line it came from. Never net across entities without saying so.',
  outputSchema: taxOutputSchema,
  plan: () => [
    { title: 'Pull federal form data', agent: 'TaxAgent', tools: ['parseDocument', 'fetchSubledger'] },
    { title: 'Compute limitation and add-backs', agent: 'TaxAgent', tools: ['fetchTrialBalance'] },
    { title: 'Build workpaper', agent: 'TaxAgent', tools: ['buildWorkbook'] },
  ],
};
