/**
 * Historical memory: per client/account/period figures for reasonableness checks.
 */

import { Cents } from '@/lib/engine/types';
import { MemoryStore, MemoryScope } from './store';

export interface RecordFigureInput {
  client: string;
  account: string;
  period: string; // YYYY-MM
  valueCents: Cents;
  source: string;
}

export interface ReasonablenessResult {
  pass: boolean;
  confidence: number;
  zScore?: number;
  changeBps?: number; // change in basis points from prior
  message: string;
  basis: string[]; // periods used for calculation
}

export class HistoricalMemory {
  constructor(private store: MemoryStore) {}

  async recordFigure(input: RecordFigureInput): Promise<void> {
    const scope: MemoryScope = { client: input.client };
    const key = `${input.account}:${input.period}`;

    await this.store.put({
      kind: 'historical',
      client: input.client,
      userId: '',
      key,
      value: {
        account: input.account,
        period: input.period,
        valueCents: input.valueCents,
      },
      confidence: 0.95,
      source: input.source,
    });
  }

  async priorPeriods(client: string, account: string, period: string, n: number): Promise<Array<{ period: string; valueCents: Cents }>> {
    const scope: MemoryScope = { client };
    const records = await this.store.list('historical', scope, `${account}:`);

    const result = records
      .map((r) => {
        const value = r.value as { period: string; valueCents: Cents };
        return {
          period: value.period,
          valueCents: value.valueCents,
        };
      })
      .filter((r) => r.period < period)
      .sort((a, b) => b.period.localeCompare(a.period))
      .slice(0, n);

    return result;
  }

  async reasonableness(
    client: string,
    account: string,
    period: string,
    valueCents: Cents,
    options?: { k?: number; pctThresholdBps?: number },
  ): Promise<ReasonablenessResult> {
    const k = options?.k ?? 3;
    const pctThresholdBps = options?.pctThresholdBps ?? 500; // 5% default

    const priors = await this.priorPeriods(client, account, period, 12);
    const basis = priors.map((p) => p.period);

    if (priors.length < 2) {
      return {
        pass: true,
        confidence: 0.4,
        message: `Insufficient history (${priors.length} period(s)). Cannot assess reasonableness.`,
        basis,
      };
    }

    const values = priors.map((p) => p.valueCents);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    // Z-score: (value - mean) / stdDev. Flat history means any departure is
    // unusual, not "0 standard deviations away".
    const zScore = stdDev > 0 ? (valueCents - mean) / stdDev : valueCents === mean ? 0 : Number.POSITIVE_INFINITY;

    // Change in basis points from prior period
    const priorValue = priors[0]?.valueCents ?? 0;
    const changeBps = priorValue !== 0 ? Math.round(((valueCents - priorValue) / priorValue) * 10000) : 0;

    const passZScore = Math.abs(zScore) <= k;
    const passChange = Math.abs(changeBps) <= pctThresholdBps;
    const pass = passZScore && passChange;

    return {
      pass,
      confidence: pass ? 0.9 : 0.85,
      zScore,
      changeBps,
      message: pass
        ? `Reasonable: z-score ${zScore.toFixed(2)}, change ${changeBps} bps`
        : `Unusual: z-score ${Number.isFinite(zScore) ? zScore.toFixed(2) : '∞ (flat history)'} (threshold ±${k}), change ${changeBps} bps (threshold ±${pctThresholdBps})`,
      basis,
    };
  }
}
