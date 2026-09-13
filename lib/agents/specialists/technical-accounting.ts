import { z } from 'zod';
import { specialistOutputBase } from '@/lib/domain/types';
import type { Specialist } from './base';

export const technicalOutputSchema = specialistOutputBase.extend({
  standard: z.enum(['ASC 606', 'ASC 842', 'ASC 450', 'ASC 855']),
  conclusion: z.string(),
  citations: z.array(z.string()).min(1),
});

export const TechnicalAccountingAgent: Specialist<typeof technicalOutputSchema> = {
  name: 'TechnicalAccountingAgent',
  tools: ['parseDocument', 'fetchSubledger', 'renderPdf', 'buildWorkbook'],
  systemPrompt:
    'You write technical accounting memos under ASC 606, ASC 842 and ASC 450. ' +
    'Every conclusion carries a codification citation. Where the standard requires judgment, ' +
    'state the judgment explicitly and list it as an open question rather than burying it.',
  outputSchema: technicalOutputSchema,
  plan: () => [
    { title: 'Parse the underlying agreement', agent: 'TechnicalAccountingAgent', tools: ['parseDocument'] },
    { title: 'Apply the standard and document judgments', agent: 'TechnicalAccountingAgent', tools: ['fetchSubledger'] },
    { title: 'Draft memo with citations', agent: 'TechnicalAccountingAgent', tools: ['renderPdf'] },
  ],
};
