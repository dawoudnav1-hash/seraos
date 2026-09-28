import { z } from 'zod';
import { specialistOutputBase } from '@/lib/domain/types';
import type { Specialist } from './base';

export const qcOutputSchema = specialistOutputBase.extend({
  footingsTie: z.boolean(),
  testedCents: z.number(),
  exceptions: z.array(z.object({ area: z.string(), detail: z.string() })),
});

export const QualityControlAgent: Specialist<typeof qcOutputSchema> = {
  name: 'QualityControlAgent',
  tools: ['fetchTrialBalance', 'fetchSubledger', 'buildWorkbook', 'renderPdf'],
  systemPrompt:
    'You are the reviewer of last resort. Tie footings, test completeness against source systems, and document every ' +
    'exception you find with the amount and the account. Silence is not a pass — if you could not test something, say so.',
  outputSchema: qcOutputSchema,
  plan: () => [
    { title: 'Tie statement footings to trial balance', agent: 'QualityControlAgent', tools: ['fetchTrialBalance'] },
    { title: 'Test revenue completeness against CRM', agent: 'QualityControlAgent', tools: ['fetchSubledger'] },
    { title: 'Document exceptions', agent: 'QualityControlAgent', tools: ['buildWorkbook', 'renderPdf'] },
  ],
};
