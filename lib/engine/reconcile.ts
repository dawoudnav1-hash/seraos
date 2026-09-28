import type { Cents, Txn } from './types';
import { DEFAULT_MATCH_CONFIG, type MatchConfig, type ReconciliationResult, reconcile } from './matching';

/**
 * Thin, named configurations over the matching engine — one function per
 * recurring reconciliation shape. All arithmetic stays in `matching.ts`;
 * these only pick the right sources, tolerances and labels.
 */

/** Bank statement lines vs the cash account detail in the GL. */
export function bankVsGl(bankLines: Txn[], glLines: Txn[], currency: string, config: Partial<MatchConfig> = {}): ReconciliationResult {
  return reconcile(bankLines, glLines, 'bank_vs_gl', currency, { dateToleranceDays: 3, ...config });
}

/** Credit-card statement lines vs the card liability/expense detail in the GL. */
export function creditCardVsGl(cardLines: Txn[], glLines: Txn[], currency: string, config: Partial<MatchConfig> = {}): ReconciliationResult {
  return reconcile(cardLines, glLines, 'credit_card_vs_gl', currency, { dateToleranceDays: 5, ...config });
}

/**
 * GL control account vs a subledger's detail (AR, AP, fixed assets, etc). This
 * is a balance tie-out plus a detail match: the caller supplies the GL balance
 * separately (via `reconciliationSummary`) since the GL side here is transaction
 * detail, not a single balance figure.
 */
export function glVsSubledger(glDetail: Txn[], subledgerDetail: Txn[], currency: string, config: Partial<MatchConfig> = {}): ReconciliationResult {
  return reconcile(glDetail, subledgerDetail, 'gl_vs_subledger', currency, { dateToleranceDays: 1, amountToleranceCents: 0, ...config });
}

/**
 * Stripe payouts vs bank deposits. A payout amount on the bank statement equals
 * charges minus fees minus refunds for the payout's balance-transaction group,
 * so this is inherently many-to-one: many Stripe balance transactions roll up
 * into one bank deposit. Fees are classified as Bank Fee variance.
 */
export function stripePayoutsVsBank(stripeBalanceTxns: Txn[], bankDeposits: Txn[], currency: string, config: Partial<MatchConfig> = {}): ReconciliationResult {
  const result = reconcile(stripeBalanceTxns, bankDeposits, 'stripe_payouts_vs_bank', currency, {
    maxGroupSize: 200,
    groupDateWindowDays: 5,
    amountToleranceCents: 2,
    ...config,
  });
  const byId = new Map(stripeBalanceTxns.map((t) => [t.id, t]));
  // A payout = charges − fees − refunds, so a fully-explained many-to-one
  // match nets to zero variance; the fee is still real, it is just internal
  // to the group. Surface it explicitly: label the match Bank Fee whenever
  // its Stripe-side legs include a fee line, and total those fee legs for
  // the metric (rather than relying on a nonzero match-level variance).
  let bankFeeVariance = 0;
  for (const m of result.matches) {
    if (!m.matchingBasis.includes('group_aggregation')) continue;
    const feeLines = m.sourceAIds.map((id) => byId.get(id)).filter((t): t is Txn => Boolean(t) && /\bfee\b/i.test(t!.description));
    if (feeLines.length === 0) continue;
    m.variance.category = 'Bank Fee';
    bankFeeVariance += feeLines.reduce((s, t) => s + Math.abs(t.amountCents), 0);
  }
  result.metrics.bankFeeVariance = bankFeeVariance;
  return result;
}

export interface BankRecInputs {
  /** GL cash balance as of the statement date, in cents. */
  glBalance: Cents;
  /** Bank statement ending balance, in cents. */
  statementBalance: Cents;
}

export interface BankRecSummary {
  bookBalanceCents: Cents;
  bankBalanceCents: Cents;
  /** GL items with no bank-side match yet (outstanding checks, unrecorded bank items). */
  depositsInTransitCents: Cents;
  outstandingChecksCents: Cents;
  /** Bank balance adjusted for items not yet cleared, expected to equal the book balance side. */
  adjustedBankBalanceCents: Cents;
  /** Book balance adjusted for bank-only items (fees, interest) not yet recorded in the GL. */
  adjustedBookBalanceCents: Cents;
  differenceCents: Cents;
  reconciles: boolean;
}

/**
 * Classic bank-reconciliation roll-forward: adjusted bank balance (statement
 * balance + deposits in transit − outstanding checks) should equal the
 * adjusted book balance (GL balance + bank-only credits − bank-only debits
 * not yet booked). Uses the matching result's exceptions to source each item.
 */
export function reconciliationSummary(result: ReconciliationResult, inputs: BankRecInputs): BankRecSummary {
  const { glBalance, statementBalance } = inputs;

  // Deposits in transit: recorded in the GL (source A, by convention) but not
  // yet on the bank statement — i.e. "Missing from Source B" exceptions with a
  // positive (debit/deposit) amount.
  const depositsInTransitCents = result.exceptions
    .filter((e) => e.side === 'A' && e.category === 'Missing from Source B' && e.amountCents > 0)
    .reduce((s, e) => s + e.amountCents, 0);

  // Outstanding checks: recorded in the GL but not yet cleared the bank —
  // negative-amount "Missing from Source B" exceptions.
  const outstandingChecksCents = Math.abs(
    result.exceptions
      .filter((e) => e.side === 'A' && e.category === 'Missing from Source B' && e.amountCents < 0)
      .reduce((s, e) => s + e.amountCents, 0),
  );

  // Bank-only items not yet booked to the GL (fees, interest, etc): "Missing
  // from Source A" exceptions, net.
  const bankOnlyNetCents = result.exceptions
    .filter((e) => e.side === 'B' && e.category === 'Missing from Source A')
    .reduce((s, e) => s + e.amountCents, 0);

  const adjustedBankBalanceCents = statementBalance + depositsInTransitCents - outstandingChecksCents;
  const adjustedBookBalanceCents = glBalance + bankOnlyNetCents;
  const differenceCents = adjustedBankBalanceCents - adjustedBookBalanceCents;

  return {
    bookBalanceCents: glBalance,
    bankBalanceCents: statementBalance,
    depositsInTransitCents,
    outstandingChecksCents,
    adjustedBankBalanceCents,
    adjustedBookBalanceCents,
    differenceCents,
    reconciles: differenceCents === 0,
  };
}

export { DEFAULT_MATCH_CONFIG };
export type { MatchConfig, ReconciliationResult };
