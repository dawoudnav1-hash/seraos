/**
 * Process memory: reusable workflow templates across engagements.
 */

import { MemoryStore, MemoryScope } from './store';

export interface ProcessTemplate {
  id: string;
  client: string;
  name: string;
  skillIds: string[];
  params: Record<string, unknown>;
  answers: Record<string, string>;
  sourceRunId: string;
  hits: number;
}

export interface SaveTemplateInput {
  client: string;
  name: string;
  skillIds: string[];
  params: Record<string, unknown>;
  answers: Record<string, string>;
  sourceRunId: string;
}

export interface FindTemplatesInput {
  text?: string;
  skillIds?: string[];
  client: string;
}

/**
 * Simple token overlap scoring for text search.
 * Splits query into tokens, counts matches in name/description, normalizes by length.
 */
function tokenOverlapScore(query: string, text: string): number {
  const queryTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const textTokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 0);

  let matches = 0;
  for (const q of queryTokens) {
    for (const t of textTokens) {
      if (t.includes(q) || q.includes(t)) {
        matches += 1;
        break;
      }
    }
  }

  return queryTokens.length > 0 ? matches / queryTokens.length : 0;
}

/**
 * Substitutes period tokens in strings.
 * Handles YYYY-MM, month names, and "April 2026" style strings.
 * Replaces all period patterns with targetPeriod in YYYY-MM format.
 */
function substitutePeriodTokens(value: unknown, targetPeriod: string): unknown {
  if (typeof value === 'string') {
    // Replace common period patterns with targetPeriod (YYYY-MM)
    let result = value
      .replace(/\d{4}-\d{2}/g, targetPeriod) // YYYY-MM
      .replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/gi, targetPeriod) // "April 2026"
      .replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/gi, targetPeriod); // just month name
    return result;
  }
  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.map((v) => substitutePeriodTokens(v, targetPeriod));
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substitutePeriodTokens(v, targetPeriod);
    }
    return result;
  }
  return value;
}

export class ProcessMemory {
  constructor(private store: MemoryStore) {}

  async saveTemplate(input: SaveTemplateInput): Promise<string> {
    const scope: MemoryScope = { client: input.client };
    const templateId = `tpl_${input.sourceRunId}_${Date.now()}`;

    const record = await this.store.put({
      kind: 'process',
      client: input.client,
      userId: '',
      key: `template:${templateId}`,
      value: {
        name: input.name,
        skillIds: input.skillIds,
        params: input.params,
        answers: input.answers,
        sourceRunId: input.sourceRunId,
      },
      confidence: 0.95,
      source: input.sourceRunId,
    });

    return record.id;
  }

  async findTemplates(input: FindTemplatesInput): Promise<ProcessTemplate[]> {
    const scope: MemoryScope = { client: input.client };
    const records = await this.store.list('process', scope, 'template:');

    const candidates: Array<{ template: ProcessTemplate; score: number }> = [];

    for (const record of records) {
      const value = record.value as {
        name: string;
        skillIds: string[];
        params: Record<string, unknown>;
        answers: Record<string, string>;
        sourceRunId: string;
      };

      let score = 0;

      // Text search: token overlap on name
      if (input.text) {
        score += tokenOverlapScore(input.text, value.name);
      }

      // Skill match: bonus if all input skillIds are in template
      if (input.skillIds && input.skillIds.length > 0) {
        const matched = input.skillIds.filter((s) => value.skillIds.includes(s)).length;
        score += (matched / input.skillIds.length) * 10;
      }

      // Hits bonus: templates with more usage are ranked higher
      score += record.hits * 0.1;

      candidates.push({
        template: {
          id: record.id,
          client: record.client,
          name: value.name,
          skillIds: value.skillIds,
          params: value.params,
          answers: value.answers,
          sourceRunId: value.sourceRunId,
          hits: record.hits,
        },
        score,
      });
    }

    return candidates
      .sort((a, b) => b.score - a.score)
      .map((c) => c.template);
  }

  async instantiate(template: ProcessTemplate, options: { client: string; period: string }): Promise<ProcessTemplate> {
    const substitutedParams = substitutePeriodTokens(template.params, options.period) as Record<string, unknown>;
    const substitutedAnswers = Object.fromEntries(
      Object.entries(template.answers).map(([k, v]) => [k, substitutePeriodTokens(v, options.period)]),
    ) as Record<string, string>;

    return {
      ...template,
      params: substitutedParams,
      answers: substitutedAnswers,
    };
  }
}
