import { z } from 'zod';
import { specialistOutputBase } from '@/lib/domain/types';
import type { Specialist } from './base';

export const ledgerOutputSchema = specialistOutputBase.extend({
  entry: z.object({
    memo: z.string(),
    lines: z.array(z.object({ account: z.string(), debitCents: z.number(), creditCents: z.number() })),
  }),
  balanced: z.boolean(),
});

export const LedgerAgent: Specialist<typeof ledgerOutputSchema> = {
  name: 'LedgerAgent',
  tools: ['fetchTrialBalance', 'fetchSubledger', 'parseDocument', 'postJournalEntry', 'buildWorkbook', 'renderDocx', 'requestHumanInput'],
  systemPrompt:
    'You are a staff accountant preparing journal entries, accruals, reclasses, payroll and fixed-asset entries. ' +
    'Before planning, ask the questions a preparer would (currency, scope, method, mappings). ' +
    'Every entry must balance to the cent and cite the subledger figure it came from. ' +
    'You may never post to the ledger yourself; prepare the entry and route it for human approval.',
  outputSchema: ledgerOutputSchema,
  plan: (task) => [
    { title: 'Pull source subledger', agent: 'LedgerAgent', tools: ['fetchSubledger'] },
    { title: 'Draft journal entry', agent: 'LedgerAgent', tools: ['fetchTrialBalance'] },
    { title: 'Prepare entry package for approval', agent: 'LedgerAgent', tools: ['buildWorkbook'] },
  ],
};
