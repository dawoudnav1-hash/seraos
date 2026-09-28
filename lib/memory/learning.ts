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

/**
 * Extracts normalized tokens from a string for matching.
 */
function normalizeTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '') // remove non-alphanumeric
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

/**
 * Calculates token overlap between two strings.
 */
function tokenOverlap(a: string, b: string): number {
  const tokensA = normalizeTokens(a);
  const tokensB = normalizeTokens(b);
  const intersection = Array.from(tokensA).filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Scores a rule's applicability to a transaction based on pattern matching.
 */
function scoreRuleMatch(rule: RuleRecord, txn: unknown): number {
  const txnPatternStr = JSON.stringify(txn);
  const rulePatternStr = JSON.stringify(rule.pattern);

  // Exact match
  if (txnPatternStr === rulePatternStr) return 1.0;

  // Token overlap on serialized patterns
  return tokenOverlap(txnPatternStr, rulePatternStr);
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

    const confidence = best.isPromoted
      ? 0.99
      : Math.min(0.9, 0.5 + (best.rule.confirmations / 10) * 0.4); // Scale by confirmations

    return {
      account,
      ruleId: best.rule.id,
      confidence,
      status: best.isPromoted ? 'promoted' : 'candidate',
    };
  }
}
