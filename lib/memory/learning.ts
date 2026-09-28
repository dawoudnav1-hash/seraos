/**
 * Agent learning: human corrections become rule candidates, promoted after confirmation.
 */

import { RuleStore, RuleRecord } from './store';
import { SemanticMemory } from './semantic';

export type CorrectionKind = 'coding' | 'mapping' | 'je_line' | 'classification';

export interface RecordCorrectionInput {
  client: string;
  kind: CorrectionKind;
  pattern: Record<string, unknown>;
  before: unknown;
  after: unknown;
  actor: string; // who made the correction
}

export interface ApplyCodingRulesResult {
  account?: string;
  ruleId?: string;
  confidence: number;
  status: 'promoted' | 'candidate' | 'none';
}

export interface RuleWithStatus extends RuleRecord {
  explanation?: string;
}

/**
 * Compares two patterns for equality.
 */
function patternsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const LEGAL_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'the', 'plc', 'lp', 'llp']);

/** Lowercase, punctuation-free tokens with legal suffixes dropped: "Staples, Inc." → ["staples"]. */
export function vendorTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !LEGAL_SUFFIXES.has(t));
}

/** The name a coding rule keys on: the vendor if given, else counterparty, else description. */
function txnName(txn: unknown): string {
  const t = (txn ?? {}) as { vendor?: string; counterparty?: string; description?: string };
  return t.vendor ?? t.counterparty ?? t.description ?? '';
}

/**
 * How well a rule applies to a transaction. Deliberately strict: an exact
 * normalized name, or every token of the rule's vendor present in the
 * transaction's name. Loose overlap is never a match — a wrong account at
 * high confidence is worse than no suggestion.
 */
function scoreRuleMatch(rule: RuleRecord, txn: unknown): number {
  const ruleName = String((rule.pattern as { vendor?: string; counterparty?: string }).vendor ?? (rule.pattern as { counterparty?: string }).counterparty ?? '');
  const ruleTokens = vendorTokens(ruleName);
  const txnTokens = vendorTokens(txnName(txn));
  if (ruleTokens.length === 0 || txnTokens.length === 0) return 0;
  if (ruleTokens.join(' ') === txnTokens.join(' ')) return 1;
  const txnSet = new Set(txnTokens);
  return ruleTokens.every((t) => txnSet.has(t)) ? 0.9 : 0;
}

export class LearningMemory {
  constructor(
    private ruleStore: RuleStore,
    private semanticMemory: SemanticMemory,
  ) {}

  async recordCorrection(input: RecordCorrectionInput): Promise<RuleRecord> {
    // Check if a rule with the same pattern and action already exists
    const existingRules = await this.ruleStore.list(input.client, input.kind);
    const existing = existingRules.find(
      (r) =>
        patternsEqual(r.pattern, input.pattern) &&
        JSON.stringify(r.action) === JSON.stringify({ action: input.after }),
    );

    // The same pattern corrected to a different answer contradicts earlier rules:
    // count it against them, and demote any that had been promoted.
    const contradicted = existingRules.filter(
      (r) =>
        patternsEqual(r.pattern, input.pattern) &&
        r.status !== 'rejected' &&
        JSON.stringify(r.action) !== JSON.stringify({ action: input.after }),
    );
    for (const r of contradicted) {
      // Read before updating: stores may hand back the same object they mutate.
      const wasPromoted = r.status === 'promoted';
      await this.ruleStore.update(r.id, {
        rejections: r.rejections + 1,
        status: wasPromoted ? 'candidate' : r.status,
      });
      if (wasPromoted && r.kind === 'coding') {
        const vendor = (r.pattern as { vendor?: string }).vendor;
        if (vendor) await this.semanticMemory.deleteVendorAccountRule({ client: input.client }, vendor);
      }
    }

    let rule: RuleRecord;
    if (existing) {
      // Increment confirmations
      rule = await this.ruleStore.update(existing.id, {
        confirmations: existing.confirmations + 1,
      });
    } else {
      // Create a new candidate rule
      rule = await this.ruleStore.put({
        client: input.client,
        kind: input.kind,
        pattern: input.pattern,
        action: { action: input.after },
        status: 'candidate',
      });
    }

    // Auto-promote if confirmations >= 3 and rejections = 0
    if (rule.confirmations >= 3 && rule.rejections === 0 && rule.status === 'candidate') {
      return await this.promoteRule(rule.id, input.client);
    }

    return rule;
  }

  async promoteRule(ruleId: string, client: string): Promise<RuleRecord> {
    const rule = await this.ruleStore.update(ruleId, {
      status: 'promoted',
    });

    // Write the rule to semantic memory so the deterministic layer uses it
    if (rule.kind === 'coding') {
      const action = rule.action as { action: unknown };
      const account = typeof action.action === 'string' ? action.action : '';
      const pattern = rule.pattern as { vendor?: string };
      if (pattern.vendor && account) {
        await this.semanticMemory.setVendorAccountRule(
          { client },
          pattern.vendor,
          account,
          ruleId,
        );
      }
    }

    return rule;
  }

  async reject(ruleId: string): Promise<RuleRecord> {
    const rule = await this.ruleStore.get(ruleId);
    if (!rule) {
      throw new Error(`Rule not found: ${ruleId}`);
    }

    return await this.ruleStore.update(ruleId, {
      status: 'rejected',
      rejections: rule.rejections + 1,
    });
  }

  async applyCodingRules(client: string, txn: unknown): Promise<ApplyCodingRulesResult> {
    const rules = await this.ruleStore.list(client, 'coding');

    // Separate promoted and candidate rules
    const promoted = rules.filter((r) => r.status === 'promoted');
    const candidates = rules.filter((r) => r.status === 'candidate');

    // Score all rules
    const scored = [
      ...promoted.map((r) => ({ rule: r, score: scoreRuleMatch(r, txn), isPromoted: true })),
      ...candidates.map((r) => ({ rule: r, score: scoreRuleMatch(r, txn), isPromoted: false })),
    ]
      .filter((s) => s.score > 0)
      .sort((a, b) => {
        // Sort by promoted status first, then by score
        if (a.isPromoted !== b.isPromoted) {
          return a.isPromoted ? -1 : 1;
        }
        return b.score - a.score;
      });

    if (scored.length === 0) {
      return {
        confidence: 0,
        status: 'none',
      };
    }

    const best = scored[0];
    const account = typeof best.rule.action === 'object' && best.rule.action !== null
      ? (best.rule.action as { action: string }).action
      : '';

    // A partial name match never earns full confidence, even from a promoted rule.
    const base = best.isPromoted ? 0.99 : Math.min(0.9, 0.5 + (best.rule.confirmations / 10) * 0.4);
    const confidence = best.score === 1 ? base : Math.min(base, best.isPromoted ? 0.93 : 0.8);

    return {
      account,
      ruleId: best.rule.id,
      confidence,
      status: best.isPromoted ? 'promoted' : 'candidate',
    };
  }
}
