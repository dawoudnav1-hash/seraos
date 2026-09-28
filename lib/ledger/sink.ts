/**
 * Two implementations of `LedgerSink`:
 *
 * - `PostgresLedgerSink` — the real thing. The QuickBooks/Xero sync writes
 *   through this. Upserts are idempotent on (companyId, externalId); an
 *   entry's lines are replaced atomically inside one transaction per entry;
 *   an entry whose lines don't balance is refused before anything is written.
 * - `InMemoryLedgerSink` — same contract, no database, for tests of modules
 *   that depend on `LedgerSink` but don't want to stand up Postgres.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import {
  UnbalancedEntryError,
  UnknownReferenceError,
  type LedgerSink,
  type WhAccount,
  type WhBankTxn,
  type WhCompany,
  type WhContact,
  type WhDocument,
  type WhEntry,
} from './types';

/** Works against either the PGlite or the node-postgres drizzle driver. */
export type LedgerDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Refuses (throws) rather than write an entry whose debits and credits don't sum equal. */
export function assertEntryBalances(entry: WhEntry): void {
  let debit = 0;
  let credit = 0;
  for (const line of entry.lines) {
    debit += line.debitCents;
    credit += line.creditCents;
  }
  if (debit !== credit) throw new UnbalancedEntryError(entry.externalId, debit, credit);
}

/**
 * Best-effort account classification from the provider's own raw type string,
 * until the ontology classifier (`lib/context/ontology.ts`) fills `ontologySubtype`.
 * Unrecognized types resolve to nulls rather than guessing.
 */
export function inferAccountClassification(
  providerType: string,
): { class: string | null; normalBalance: 'debit' | 'credit' | null } {
  const t = providerType.trim().toLowerCase();
  const debitAsset = [
    'bank',
    'accounts receivable',
    'other current asset',
    'fixed asset',
    'other asset',
    'current',
    'fixed',
    'inventory',
    'noncurrent',
  ];
  const creditLiability = [
    'accounts payable',
    'credit card',
    'other current liability',
    'long term liability',
    'currliab',
    'termliab',
    'liability',
  ];
  const creditEquity = ['equity'];
  const creditRevenue = ['income', 'other income', 'revenue', 'sales'];
  const debitExpense = [
    'expense',
    'other expense',
    'cost of goods sold',
    'expenses',
    'directcosts',
    'overheads',
  ];
  if (debitAsset.some((k) => t.includes(k))) return { class: 'asset', normalBalance: 'debit' };
  if (creditLiability.some((k) => t.includes(k))) return { class: 'liability', normalBalance: 'credit' };
  if (creditEquity.some((k) => t.includes(k))) return { class: 'equity', normalBalance: 'credit' };
  if (creditRevenue.some((k) => t.includes(k))) return { class: 'revenue', normalBalance: 'credit' };
  if (debitExpense.some((k) => t.includes(k))) return { class: 'expense', normalBalance: 'debit' };
  return { class: null, normalBalance: null };
}

export class PostgresLedgerSink implements LedgerSink {
  constructor(private readonly db: LedgerDb) {}

  async upsertCompany(c: WhCompany): Promise<void> {
    await this.db
      .insert(schema.ledgerCompanies)
      .values({
        id: c.id,
        client: c.client,
        provider: c.provider,
        externalId: c.externalId,
        name: c.name,
        baseCurrency: c.baseCurrency,
        fiscalYearStartMonth: c.fiscalYearStartMonth,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.ledgerCompanies.id,
        set: {
          client: c.client,
          provider: c.provider,
          externalId: c.externalId,
          name: c.name,
          baseCurrency: c.baseCurrency,
          fiscalYearStartMonth: c.fiscalYearStartMonth,
          updatedAt: new Date(),
        },
      });
  }

  private async companyProvider(companyId: string): Promise<string> {
    const [row] = await this.db
      .select({ provider: schema.ledgerCompanies.provider })
      .from(schema.ledgerCompanies)
      .where(eq(schema.ledgerCompanies.id, companyId));
    if (!row) throw new Error(`unknown ledger company "${companyId}" — upsertCompany must run first`);
    return row.provider;
  }

  async upsertAccounts(companyId: string, rows: WhAccount[]): Promise<number> {
    if (rows.length === 0) return 0;
    const provider = await this.companyProvider(companyId);
    for (const r of rows) {
      const { class: cls, normalBalance } = inferAccountClassification(r.providerType);
      await this.db
        .insert(schema.ledgerAccounts)
        .values({
          id: randomUUID(),
          companyId,
          provider,
          externalId: r.externalId,
          code: r.code,
          name: r.name,
          providerType: r.providerType,
          providerSubtype: r.providerSubtype,
          class: cls,
          normalBalance,
          currency: r.currency,
          active: r.active,
          currentBalanceCents: r.currentBalanceCents,
          providerUpdatedAt: r.updatedAt,
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.ledgerAccounts.companyId, schema.ledgerAccounts.externalId],
          set: {
            code: r.code,
            name: r.name,
            providerType: r.providerType,
            providerSubtype: r.providerSubtype,
            class: cls,
            normalBalance,
            currency: r.currency,
            active: r.active,
            currentBalanceCents: r.currentBalanceCents,
            providerUpdatedAt: r.updatedAt,
            syncedAt: new Date(),
          },
        });
    }
    // Second pass: resolve parentExternalId -> parentAccountId now that every
    // account in this page (parents and children, in any order) has a row.
    const withParent = rows.filter((r) => r.parentExternalId);
    if (withParent.length > 0) {
      const all = await this.db
        .select({ id: schema.ledgerAccounts.id, externalId: schema.ledgerAccounts.externalId })
        .from(schema.ledgerAccounts)
        .where(eq(schema.ledgerAccounts.companyId, companyId));
      const idByExternal = new Map(all.map((a) => [a.externalId, a.id]));
      for (const r of withParent) {
        const parentId = idByExternal.get(r.parentExternalId!);
        if (!parentId) continue; // parent not synced yet; left null until it is
        await this.db
          .update(schema.ledgerAccounts)
          .set({ parentAccountId: parentId })
          .where(
            and(
              eq(schema.ledgerAccounts.companyId, companyId),
              eq(schema.ledgerAccounts.externalId, r.externalId),
            ),
          );
      }
    }
    return rows.length;
  }

  async upsertContacts(companyId: string, rows: WhContact[]): Promise<number> {
    if (rows.length === 0) return 0;
    const provider = await this.companyProvider(companyId);
    for (const r of rows) {
      await this.db
        .insert(schema.ledgerContacts)
        .values({
          id: randomUUID(),
          companyId,
          provider,
          externalId: r.externalId,
          kind: r.kind,
          name: r.name,
          email: r.email,
          active: r.active,
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.ledgerContacts.companyId, schema.ledgerContacts.externalId],
          set: { kind: r.kind, name: r.name, email: r.email, active: r.active, syncedAt: new Date() },
        });
    }
    return rows.length;
  }

  async upsertEntries(companyId: string, rows: WhEntry[]): Promise<number> {
    if (rows.length === 0) return 0;
    // Refuse the whole batch before writing anything if any entry is unbalanced
    // or references an account/contact we haven't synced.
    for (const entry of rows) assertEntryBalances(entry);
    const provider = await this.companyProvider(companyId);
    const accountRows = await this.db
      .select({ id: schema.ledgerAccounts.id, externalId: schema.ledgerAccounts.externalId })
      .from(schema.ledgerAccounts)
      .where(eq(schema.ledgerAccounts.companyId, companyId));
    const accountId = new Map(accountRows.map((a) => [a.externalId, a.id]));
    const contactRows = await this.db
      .select({ id: schema.ledgerContacts.id, externalId: schema.ledgerContacts.externalId })
      .from(schema.ledgerContacts)
      .where(eq(schema.ledgerContacts.companyId, companyId));
    const contactId = new Map(contactRows.map((c) => [c.externalId, c.id]));

    const resolved = rows.map((entry) => ({
      entry,
      lines: entry.lines.map((line) => {
        const resolvedAccountId = accountId.get(line.accountExternalId);
        if (!resolvedAccountId) {
          throw new UnknownReferenceError(entry.externalId, 'account', line.accountExternalId);
        }
        let resolvedContactId: string | null = null;
        if (line.contactExternalId) {
          const found = contactId.get(line.contactExternalId);
          if (!found) throw new UnknownReferenceError(entry.externalId, 'contact', line.contactExternalId);
          resolvedContactId = found;
        }
        return { ...line, accountId: resolvedAccountId, contactId: resolvedContactId };
      }),
    }));

    for (const { entry, lines } of resolved) {
      await this.db.transaction(async (tx) => {
        const [entryRow] = await tx
          .insert(schema.ledgerEntries)
          .values({
            id: randomUUID(),
            companyId,
            provider,
            externalId: entry.externalId,
            sourceType: entry.sourceType,
            number: entry.number,
            date: entry.date,
            memo: entry.memo,
            currency: entry.currency,
            status: entry.status,
            providerUpdatedAt: entry.updatedAt,
            syncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [schema.ledgerEntries.companyId, schema.ledgerEntries.externalId],
            set: {
              sourceType: entry.sourceType,
              number: entry.number,
              date: entry.date,
              memo: entry.memo,
              currency: entry.currency,
              status: entry.status,
              providerUpdatedAt: entry.updatedAt,
              syncedAt: new Date(),
            },
          })
          .returning({ id: schema.ledgerEntries.id });

        await tx.delete(schema.ledgerLines).where(eq(schema.ledgerLines.entryId, entryRow.id));
        if (lines.length > 0) {
          await tx.insert(schema.ledgerLines).values(
            lines.map((l) => ({
              id: randomUUID(),
              entryId: entryRow.id,
              lineNo: l.lineNo,
              accountId: l.accountId,
              contactId: l.contactId,
              description: l.description,
              debitCents: l.debitCents,
              creditCents: l.creditCents,
              dimensions: l.dimensions,
            })),
          );
        }
      });
    }
    return rows.length;
  }

  async upsertBankTransactions(companyId: string, rows: WhBankTxn[]): Promise<number> {
    if (rows.length === 0) return 0;
    const provider = await this.companyProvider(companyId);
    const accountRows = await this.db
      .select({ id: schema.ledgerAccounts.id, externalId: schema.ledgerAccounts.externalId })
      .from(schema.ledgerAccounts)
      .where(eq(schema.ledgerAccounts.companyId, companyId));
    const accountId = new Map(accountRows.map((a) => [a.externalId, a.id]));

    for (const r of rows) {
      const bankAccountId = accountId.get(r.bankAccountExternalId);
      if (!bankAccountId) throw new UnknownReferenceError(r.externalId, 'account', r.bankAccountExternalId);
      const categoryAccountId = r.categoryAccountExternalId
        ? accountId.get(r.categoryAccountExternalId) ?? null
        : null;
      await this.db
        .insert(schema.ledgerBankTransactions)
        .values({
          id: randomUUID(),
          companyId,
          provider,
          externalId: r.externalId,
          bankAccountId,
          date: r.date,
          amountCents: r.amountCents,
          description: r.description,
          counterparty: r.counterparty,
          reference: r.reference,
          status: r.status,
          categoryAccountId,
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.ledgerBankTransactions.companyId, schema.ledgerBankTransactions.externalId],
          set: {
            bankAccountId,
            date: r.date,
            amountCents: r.amountCents,
            description: r.description,
            counterparty: r.counterparty,
            reference: r.reference,
            status: r.status,
            categoryAccountId,
            syncedAt: new Date(),
          },
        });
    }
    return rows.length;
  }

  async upsertDocuments(companyId: string, rows: WhDocument[]): Promise<number> {
    if (rows.length === 0) return 0;
    const provider = await this.companyProvider(companyId);
    const contactRows = await this.db
      .select({ id: schema.ledgerContacts.id, externalId: schema.ledgerContacts.externalId })
      .from(schema.ledgerContacts)
      .where(eq(schema.ledgerContacts.companyId, companyId));
    const contactId = new Map(contactRows.map((c) => [c.externalId, c.id]));

    for (const r of rows) {
      const resolvedContactId = r.contactExternalId ? contactId.get(r.contactExternalId) ?? null : null;
      await this.db
        .insert(schema.ledgerDocuments)
        .values({
          id: randomUUID(),
          companyId,
          provider,
          externalId: r.externalId,
          kind: r.kind,
          contactId: resolvedContactId,
          number: r.number,
          date: r.date,
          dueDate: r.dueDate,
          totalCents: r.totalCents,
          balanceCents: r.balanceCents,
          status: r.status,
          currency: r.currency,
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.ledgerDocuments.companyId, schema.ledgerDocuments.externalId],
          set: {
            kind: r.kind,
            contactId: resolvedContactId,
            number: r.number,
            date: r.date,
            dueDate: r.dueDate,
            totalCents: r.totalCents,
            balanceCents: r.balanceCents,
            status: r.status,
            currency: r.currency,
            syncedAt: new Date(),
          },
        });
    }
    return rows.length;
  }

  async getSyncCursor(companyId: string, entity: string): Promise<string | null> {
    const [row] = await this.db
      .select({ cursor: schema.ledgerSyncState.cursor })
      .from(schema.ledgerSyncState)
      .where(and(eq(schema.ledgerSyncState.companyId, companyId), eq(schema.ledgerSyncState.entity, entity)));
    return row?.cursor ?? null;
  }

  async setSyncCursor(companyId: string, entity: string, cursor: string, rowsUpserted: number): Promise<void> {
    await this.db
      .insert(schema.ledgerSyncState)
      .values({
        companyId,
        entity,
        cursor,
        rowsUpserted,
        status: 'ok',
        lastRunAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.ledgerSyncState.companyId, schema.ledgerSyncState.entity],
        set: { cursor, rowsUpserted, status: 'ok', lastRunAt: new Date(), error: sql`NULL` },
      });
  }
}

/** In-memory `LedgerSink` for tests of modules that depend on the interface, not on Postgres. */
export class InMemoryLedgerSink implements LedgerSink {
  readonly companies = new Map<string, WhCompany>();
  private readonly accounts = new Map<string, Map<string, WhAccount>>();
  private readonly contacts = new Map<string, Map<string, WhContact>>();
  private readonly entries = new Map<string, Map<string, WhEntry>>();
  private readonly bankTxns = new Map<string, Map<string, WhBankTxn>>();
  private readonly documents = new Map<string, Map<string, WhDocument>>();
  private readonly cursors = new Map<string, { cursor: string; rowsUpserted: number }>();

  private bucket<T>(store: Map<string, Map<string, T>>, companyId: string): Map<string, T> {
    let b = store.get(companyId);
    if (!b) {
      b = new Map();
      store.set(companyId, b);
    }
    return b;
  }

  async upsertCompany(c: WhCompany): Promise<void> {
    this.companies.set(c.id, c);
  }

  async upsertAccounts(companyId: string, rows: WhAccount[]): Promise<number> {
    const b = this.bucket(this.accounts, companyId);
    for (const r of rows) b.set(r.externalId, r);
    return rows.length;
  }

  async upsertContacts(companyId: string, rows: WhContact[]): Promise<number> {
    const b = this.bucket(this.contacts, companyId);
    for (const r of rows) b.set(r.externalId, r);
    return rows.length;
  }

  async upsertEntries(companyId: string, rows: WhEntry[]): Promise<number> {
    for (const entry of rows) assertEntryBalances(entry);
    const accounts = this.bucket(this.accounts, companyId);
    const contacts = this.bucket(this.contacts, companyId);
    for (const entry of rows) {
      for (const line of entry.lines) {
        if (!accounts.has(line.accountExternalId)) {
          throw new UnknownReferenceError(entry.externalId, 'account', line.accountExternalId);
        }
        if (line.contactExternalId && !contacts.has(line.contactExternalId)) {
          throw new UnknownReferenceError(entry.externalId, 'contact', line.contactExternalId);
        }
      }
    }
    const b = this.bucket(this.entries, companyId);
    for (const r of rows) b.set(r.externalId, r); // replaces the entry's lines wholesale, same as the Postgres sink
    return rows.length;
  }

  async upsertBankTransactions(companyId: string, rows: WhBankTxn[]): Promise<number> {
    const b = this.bucket(this.bankTxns, companyId);
    for (const r of rows) b.set(r.externalId, r);
    return rows.length;
  }

  async upsertDocuments(companyId: string, rows: WhDocument[]): Promise<number> {
    const b = this.bucket(this.documents, companyId);
    for (const r of rows) b.set(r.externalId, r);
    return rows.length;
  }

  async getSyncCursor(companyId: string, entity: string): Promise<string | null> {
    return this.cursors.get(`${companyId}:${entity}`)?.cursor ?? null;
  }

  async setSyncCursor(companyId: string, entity: string, cursor: string, rowsUpserted: number): Promise<void> {
    this.cursors.set(`${companyId}:${entity}`, { cursor, rowsUpserted });
  }

  /** Test/inspection helpers — not part of `LedgerSink`. */
  listAccounts(companyId: string): WhAccount[] {
    return [...(this.accounts.get(companyId)?.values() ?? [])];
  }
  listEntries(companyId: string): WhEntry[] {
    return [...(this.entries.get(companyId)?.values() ?? [])];
  }
  listBankTransactions(companyId: string): WhBankTxn[] {
    return [...(this.bankTxns.get(companyId)?.values() ?? [])];
  }
  listDocuments(companyId: string): WhDocument[] {
    return [...(this.documents.get(companyId)?.values() ?? [])];
  }
}
