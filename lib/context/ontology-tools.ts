/**
 * The ontology as agent tools. Each definition carries the JSON schema the
 * model sees and a pure handler; the orchestrator executes them. Handlers
 * re-validate input with zod because the model's arguments are untrusted.
 */
import { z } from 'zod';
import { JOURNAL_ENTRY_TYPES, type JournalEntry } from '@/lib/engine/types';
import { classifyAccount, closeOrder, explain, lookup, validateEntry } from './ontology';

/** JSON Schema subset; structurally compatible with Anthropic's `Tool['input_schema']`. */
export interface JsonObjectSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export type OntologyToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export interface OntologyTool {
  name: string;
  description: string;
  input_schema: JsonObjectSchema;
  handler: (input: unknown) => OntologyToolResult;
}

function withSchema<S extends z.ZodTypeAny>(schema: S, run: (input: z.infer<S>) => unknown): (input: unknown) => OntologyToolResult {
  return (input) => {
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') };
    }
    try {
      return { ok: true, data: run(parsed.data) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

const sourceRefSchema = z.object({ system: z.string(), id: z.string(), label: z.string().optional() });

const entrySchema = z.object({
  id: z.string(),
  date: z.string(),
  type: z.enum(JOURNAL_ENTRY_TYPES),
  memo: z.string().default(''),
  lines: z.array(
    z.object({
      account: z.string(),
      description: z.string().default(''),
      debitCents: z.number(),
      creditCents: z.number(),
      sources: z.array(sourceRefSchema).default([]),
      dimensions: z.record(z.string()).optional(),
    }),
  ),
  attachments: z.array(sourceRefSchema).default([]),
  reversesOn: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

const chartSchema = z.array(z.object({ code: z.string(), name: z.string(), subtype: z.string().nullish() }));

const SOURCE_REF_JSON = {
  type: 'object',
  required: ['system', 'id'],
  properties: { system: { type: 'string' }, id: { type: 'string' }, label: { type: 'string' } },
};

export const ontologyLookupTool: OntologyTool = {
  name: 'ontology_lookup',
  description:
    'Find accounting concepts (account subtypes, entry types, schedules, reconciliations, standards, close tasks) by name or synonym. Use it to get the canonical id before classifying, validating or explaining.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['term'],
    properties: {
      term: { type: 'string', description: 'Free text, e.g. "unearned revenue", "A/R", "ASC 842".' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum matches (default 5).' },
    },
  },
  handler: withSchema(z.object({ term: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }), ({ term, limit }) =>
    lookup(term, limit ?? 5).map((m) => ({
      id: m.concept.id,
      kind: m.concept.kind,
      label: m.concept.label,
      score: m.score,
      matched: m.matched,
      definition: m.concept.definition,
    })),
  ),
};

export const ontologyClassifyAccountTool: OntologyTool = {
  name: 'ontology_classify_account',
  description:
    'Classify a ledger account into an ontology subtype with class, normal balance, confidence and rationale. Pass the QuickBooks or Xero type fields when you have them; they outrank name and number heuristics. A null subtype means "unknown" — ask, do not guess.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: { type: 'string' },
      number: { type: 'string', description: 'Account number / code, e.g. "6410".' },
      qboType: { type: 'string', description: 'QuickBooks Online AccountType, e.g. "Other Current Asset".' },
      qboSubType: { type: 'string', description: 'QuickBooks Online AccountSubType, e.g. "PrepaidExpenses".' },
      xeroType: { type: 'string', description: 'Xero account Type, e.g. "FIXED".' },
      xeroClass: { type: 'string', description: 'Xero account Class, e.g. "ASSET".' },
      xeroSystemAccount: { type: 'string', description: 'Xero SystemAccount, e.g. "DEBTORS".' },
    },
  },
  handler: withSchema(
    z.object({
      name: z.string(),
      number: z.string().optional(),
      qboType: z.string().optional(),
      qboSubType: z.string().optional(),
      xeroType: z.string().optional(),
      xeroClass: z.string().optional(),
      xeroSystemAccount: z.string().optional(),
    }),
    (input) => classifyAccount(input),
  ),
};

export const ontologyValidateEntryTool: OntologyTool = {
  name: 'ontology_validate_entry',
  description:
    'Run the structural checks on a proposed journal entry against the chart of accounts: accounts exist, debits equal credits, one side per line in integer cents, every line has a source, the account pattern fits the entry type, accruals carry reversesOn, and lines move accounts in a sane direction. Fix every failing check before proposing.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['entry', 'chart'],
    properties: {
      entry: {
        type: 'object',
        required: ['id', 'date', 'type', 'lines'],
        properties: {
          id: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          type: { type: 'string', enum: [...JOURNAL_ENTRY_TYPES] },
          memo: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              required: ['account', 'debitCents', 'creditCents', 'sources'],
              properties: {
                account: { type: 'string', description: 'Chart-of-accounts code.' },
                description: { type: 'string' },
                debitCents: { type: 'integer', minimum: 0 },
                creditCents: { type: 'integer', minimum: 0 },
                sources: { type: 'array', items: SOURCE_REF_JSON },
              },
            },
          },
          attachments: { type: 'array', items: SOURCE_REF_JSON },
          reversesOn: { type: 'string', description: 'YYYY-MM-DD; required for accruals.' },
          idempotencyKey: { type: 'string' },
        },
      },
      chart: {
        type: 'array',
        description: 'Accounts the entry may use. subtype is an ontology subtype id when known; omit it to classify by name.',
        items: {
          type: 'object',
          required: ['code', 'name'],
          properties: { code: { type: 'string' }, name: { type: 'string' }, subtype: { type: 'string' } },
        },
      },
    },
  },
  handler: withSchema(z.object({ entry: entrySchema, chart: chartSchema }), ({ entry, chart }) => {
    const je: JournalEntry = { ...entry, idempotencyKey: entry.idempotencyKey ?? entry.id };
    const checks = validateEntry(je, chart);
    return { pass: checks.every((c) => c.pass), checks };
  }),
};

export const ontologyExplainTool: OntologyTool = {
  name: 'ontology_explain',
  description: 'Explain a concept in a few lines: definition, normal balance or pattern, related schedules and reconciliations, and governing ASC references.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['conceptId'],
    properties: { conceptId: { type: 'string', description: 'Concept id (from ontology_lookup) or a term.' } },
  },
  handler: withSchema(z.object({ conceptId: z.string().min(1) }), ({ conceptId }) => ({ text: explain(conceptId) })),
};

export const ontologyCloseOrderTool: OntologyTool = {
  name: 'ontology_close_order',
  description:
    'Month-end close tasks in dependency order with their level (same level = can run in parallel). Pass include to get only those tasks plus everything they depend on.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      include: { type: 'array', items: { type: 'string' }, description: 'Close task ids, e.g. ["close.tb_flux"].' },
    },
  },
  handler: withSchema(z.object({ include: z.array(z.string()).optional() }), ({ include }) => closeOrder({ include })),
};

export const ONTOLOGY_TOOLS: readonly OntologyTool[] = [
  ontologyLookupTool,
  ontologyClassifyAccountTool,
  ontologyValidateEntryTool,
  ontologyExplainTool,
  ontologyCloseOrderTool,
];

export function runOntologyTool(name: string, input: unknown): OntologyToolResult {
  const tool = ONTOLOGY_TOOLS.find((t) => t.name === name);
  return tool ? tool.handler(input) : { ok: false, error: `Unknown ontology tool "${name}".` };
}
