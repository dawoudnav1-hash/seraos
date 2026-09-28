import fa from '@/fixtures/fixed-assets.json';

/**
 * Fixed-asset close math for the April 2026 period, computed from the register
 * and the April GL detail — nothing here is a typed-in total.
 */

export type RegisterAsset = (typeof fa.register)[number];
export type ExpenseLine = (typeof fa.aprilExpenses)[number];

export interface JournalLine {
  account: string;
  description: string;
  debitCents: number;
  creditCents: number;
  source: string;
}

export interface JournalEntry {
  id: string;
  memo: string;
  lines: JournalLine[];
}

/** Straight-line over (cost − salvage), rounded once at the total. */
export function depreciationFor(asset: Pick<RegisterAsset, 'costCents' | 'salvageCents' | 'lifeMonths'>, months: number): number {
  return Math.round(((asset.costCents - asset.salvageCents) / asset.lifeMonths) * months);
}

export function accumulatedBeforeClose(asset: RegisterAsset): number {
  return depreciationFor(asset, asset.monthsDepreciated);
}

/** Balance sheet by asset class as it stands before any April close entry. */
export function currentState() {
  const byClass = new Map<string, { cost: number; accum: number; ids: string[] }>();
  for (const a of fa.register) {
    const row = byClass.get(a.class) ?? { cost: 0, accum: 0, ids: [] };
    row.cost += a.costCents;
    row.accum += accumulatedBeforeClose(a);
    row.ids.push(a.id);
    byClass.set(a.class, row);
  }
  const rows = [...byClass.entries()].map(([cls, r]) => ({ class: cls, costCents: r.cost, accumCents: r.accum, nbvCents: r.cost - r.accum, ids: r.ids }));
  const total = rows.reduce(
    (t, r) => ({ costCents: t.costCents + r.costCents, accumCents: t.accumCents + r.accumCents, nbvCents: t.nbvCents + r.nbvCents }),
    { costCents: 0, accumCents: 0, nbvCents: 0 },
  );
  return { rows, total };
}

/** April purchases booked to expense that meet the capitalization policy. */
export function misclassified(): ExpenseLine[] {
  return fa.aprilExpenses.filter((l) => l.capital && l.amountCents >= fa.capitalizationThresholdCents);
}

export function reviewedButKept(): ExpenseLine[] {
  return fa.aprilExpenses.filter((l) => !l.capital);
}

export function disposals() {
  return fa.register
    .filter((a) => 'disposal' in a && a.disposal)
    .map((a) => {
      const d = (a as RegisterAsset & { disposal: { date: string; proceedsCents: number; note: string } }).disposal;
      const accum = accumulatedBeforeClose(a);
      const nbv = a.costCents - accum;
      return { asset: a, date: d.date, note: d.note, proceedsCents: d.proceedsCents, accumCents: accum, nbvCents: nbv, gainLossCents: d.proceedsCents - nbv };
    });
}

/** April depreciation: every asset in service, except those disposed of in April. */
export function aprilDepreciation() {
  return fa.register.map((a) => {
    const disposed = 'disposal' in a && Boolean(a.disposal);
    const opening = accumulatedBeforeClose(a);
    // Rounding once at the total keeps the schedule tying to the ledger.
    const april = disposed ? 0 : depreciationFor(a, a.monthsDepreciated + 1) - opening;
    return { asset: a, openingAccumCents: opening, aprilCents: april, closingAccumCents: opening + april, disposed };
  });
}

export function reclassEntry(): JournalEntry {
  const lines = misclassified();
  const debits: JournalLine[] = lines.map((l) => ({
    account: fa.accounts[l.assetClass as keyof typeof fa.accounts].cost,
    description: `${l.assetType} — ${l.memo}`,
    debitCents: l.amountCents,
    creditCents: 0,
    source: l.je,
  }));
  const byExpense = new Map<string, { cents: number; sources: string[] }>();
  for (const l of lines) {
    const row = byExpense.get(l.account) ?? { cents: 0, sources: [] };
    row.cents += l.amountCents;
    row.sources.push(l.je);
    byExpense.set(l.account, row);
  }
  const credits: JournalLine[] = [...byExpense.entries()].map(([account, r]) => ({
    account,
    description: `Reclass capital purchases out of ${account}`,
    debitCents: 0,
    creditCents: r.cents,
    source: r.sources.join(', '),
  }));
  return { id: 'JE-DRAFT-FA-01', memo: 'Reclassify April capital purchases from expense to fixed assets', lines: [...debits, ...credits] };
}

export function depreciationEntry(): JournalEntry {
  const rows = aprilDepreciation().filter((r) => r.aprilCents > 0);
  const total = rows.reduce((s, r) => s + r.aprilCents, 0);
  const byAccum = new Map<string, { cents: number; ids: string[] }>();
  for (const r of rows) {
    const acct = fa.accounts[r.asset.class as keyof typeof fa.accounts].accum;
    const row = byAccum.get(acct) ?? { cents: 0, ids: [] };
    row.cents += r.aprilCents;
    row.ids.push(r.asset.id);
    byAccum.set(acct, row);
  }
  return {
    id: 'JE-DRAFT-FA-02',
    memo: 'April 2026 depreciation',
    lines: [
      { account: '6410', description: 'Depreciation expense', debitCents: total, creditCents: 0, source: rows.map((r) => r.asset.id).join(', ') },
      ...[...byAccum.entries()].map(([account, r]) => ({
        account,
        description: 'Accumulated depreciation',
        debitCents: 0,
        creditCents: r.cents,
        source: r.ids.join(', '),
      })),
    ],
  };
}

export function disposalEntry(): JournalEntry | null {
  const d = disposals()[0];
  if (!d) return null;
  const accts = fa.accounts[d.asset.class as keyof typeof fa.accounts];
  const loss = -d.gainLossCents;
  return {
    id: 'JE-DRAFT-FA-03',
    memo: `Dispose of ${d.asset.id} — ${d.note}`,
    lines: [
      { account: accts.accum, description: 'Remove accumulated depreciation', debitCents: d.accumCents, creditCents: 0, source: d.asset.id },
      { account: '1180', description: 'Vendor credit receivable — Dell', debitCents: d.proceedsCents, creditCents: 0, source: 'RMA 88213-D' },
      ...(loss > 0 ? [{ account: '7910', description: 'Loss on disposal of fixed assets', debitCents: loss, creditCents: 0, source: d.asset.id }] : []),
      { account: accts.cost, description: 'Remove asset cost', debitCents: 0, creditCents: d.asset.costCents, source: d.asset.id },
      ...(loss < 0 ? [{ account: '7910', description: 'Gain on disposal of fixed assets', debitCents: 0, creditCents: -loss, source: d.asset.id }] : []),
    ],
  };
}

export function isBalanced(je: JournalEntry): boolean {
  const dr = je.lines.reduce((s, l) => s + l.debitCents, 0);
  const cr = je.lines.reduce((s, l) => s + l.creditCents, 0);
  return dr === cr;
}

/** Balance sheet after every drafted entry is posted. */
export function afterClose() {
  const before = currentState().total;
  const additions = misclassified().reduce((s, l) => s + l.amountCents, 0);
  const d = disposals();
  const disposedCost = d.reduce((s, x) => s + x.asset.costCents, 0);
  const disposedAccum = d.reduce((s, x) => s + x.accumCents, 0);
  const april = aprilDepreciation().reduce((s, r) => s + r.aprilCents, 0);
  const costCents = before.costCents + additions - disposedCost;
  const accumCents = before.accumCents - disposedAccum + april;
  return { costCents, accumCents, nbvCents: costCents - accumCents, additionsCents: additions, aprilDepreciationCents: april };
}

export const FIXED_ASSETS = fa;

export function money(cents: number, opts: { parens?: boolean } = {}): string {
  const abs = Math.abs(cents) / 100;
  const s = abs.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  return cents < 0 || opts.parens ? `(${s})` : s;
}
