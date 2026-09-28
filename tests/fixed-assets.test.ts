import { describe, expect, it } from 'vitest';
import {
  afterClose,
  aprilDepreciation,
  currentState,
  depreciationEntry,
  disposalEntry,
  isBalanced,
  misclassified,
  reclassEntry,
} from '@/lib/accounting/fixed-assets';

describe('fixed assets — April 2026 close', () => {
  it('reproduces the balance sheet as of April 30 from the register', () => {
    const { rows, total } = currentState();
    const computers = rows.find((r) => r.class === 'Computer, Software & Accessories')!;
    const truck = rows.find((r) => r.class === 'Truck')!;
    expect([computers.costCents, computers.accumCents, computers.nbvCents]).toEqual([4580455, 117330, 4463125]);
    expect([truck.costCents, truck.accumCents, truck.nbvCents]).toEqual([1349500, 67484, 1282016]);
    expect([total.costCents, total.accumCents, total.nbvCents]).toEqual([5929955, 184814, 5745141]);
  });

  it('flags only purchases that meet the capitalization policy', () => {
    expect(misclassified().map((l) => l.vendor)).toEqual(['Best Buy – Laptop', 'Home Depot – Shelving', 'Walmart – Mower']);
  });

  it('does not depreciate an asset in the month it is disposed of', () => {
    const server = aprilDepreciation().find((r) => r.asset.id === 'FA-2203')!;
    expect(server.aprilCents).toBe(0);
  });

  it('drafts journal entries that balance to the cent', () => {
    for (const je of [reclassEntry(), depreciationEntry(), disposalEntry()!]) {
      expect(isBalanced(je), je.memo).toBe(true);
    }
    expect(reclassEntry().lines.reduce((s, l) => s + l.debitCents, 0)).toBe(1637499);
  });

  it('rolls the balance sheet forward consistently', () => {
    const after = afterClose();
    const before = currentState().total;
    const dep = depreciationEntry().lines[0].debitCents;
    expect(after.aprilDepreciationCents).toBe(dep);
    expect(after.costCents).toBe(before.costCents + 1637499 - 891437);
    expect(after.nbvCents).toBe(after.costCents - after.accumCents);
  });
});
