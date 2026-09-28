/**
 * Semantic memory: client facts with typed accessors.
 * Vendor→account coding rules, account mappings, materiality, capitalization policy, fiscal year.
 * Each value keeps its source.
 */

import { MemoryStore, MemoryScope } from './store';

export interface VendorAccountRule {
  vendor: string;
  account: string;
  source: string;
}

export interface AccountMapping {
  providerAccountId: string;
  chartCode: string;
  source: string;
}

export interface Materiality {
  absoluteCents: number;
  percentOfBase: number;
  source: string;
}

export interface CapitalizationPolicy {
  thresholdCents: number;
  minLifeMonths: number;
  source: string;
}

export interface FiscalYearStart {
  month: number; // 1-12
  source: string;
}

export class SemanticMemory {
  constructor(private store: MemoryStore) {}

  async getVendorAccountRule(scope: MemoryScope, vendor: string): Promise<VendorAccountRule | null> {
    const record = await this.store.get('semantic', scope, `vendor_account:${vendor.toLowerCase()}`);
    if (!record) return null;
    const value = record.value as { account: string };
    return {
      vendor,
      account: value.account,
      source: record.source,
    };
  }

  async setVendorAccountRule(scope: MemoryScope, vendor: string, account: string, source: string): Promise<void> {
    await this.store.put({
      kind: 'semantic',
      client: scope.client,
      userId: scope.userId ?? '',
      key: `vendor_account:${vendor.toLowerCase()}`,
      value: { account },
      confidence: 0.95,
      source,
    });
  }

  /** Withdraws a promoted vendor rule, e.g. when a later correction contradicts it. */
  async deleteVendorAccountRule(scope: MemoryScope, vendor: string): Promise<void> {
    const record = await this.store.get('semantic', scope, `vendor_account:${vendor.toLowerCase()}`);
    if (record) await this.store.delete(record.id);
  }

  async listVendorAccountRules(scope: MemoryScope): Promise<VendorAccountRule[]> {
    const records = await this.store.list('semantic', scope, 'vendor_account:');
    return records.map((r) => {
      const value = r.value as { account: string };
      return {
        vendor: r.key.replace('vendor_account:', ''),
        account: value.account,
        source: r.source,
      };
    });
  }

  async getAccountMapping(scope: MemoryScope, providerAccountId: string): Promise<AccountMapping | null> {
    const record = await this.store.get('semantic', scope, `account_mapping:${providerAccountId}`);
    if (!record) return null;
    const value = record.value as { chartCode: string };
    return {
      providerAccountId,
      chartCode: value.chartCode,
      source: record.source,
    };
  }

  async setAccountMapping(scope: MemoryScope, providerAccountId: string, chartCode: string, source: string): Promise<void> {
    await this.store.put({
      kind: 'semantic',
      client: scope.client,
      userId: scope.userId ?? '',
      key: `account_mapping:${providerAccountId}`,
      value: { chartCode },
      confidence: 0.95,
      source,
    });
  }

  async listAccountMappings(scope: MemoryScope): Promise<AccountMapping[]> {
    const records = await this.store.list('semantic', scope, 'account_mapping:');
    return records.map((r) => {
      const value = r.value as { chartCode: string };
      return {
        providerAccountId: r.key.replace('account_mapping:', ''),
        chartCode: value.chartCode,
        source: r.source,
      };
    });
  }

  async getMateriality(scope: MemoryScope): Promise<Materiality | null> {
    const record = await this.store.get('semantic', scope, '_materiality');
    if (!record) return null;
    const value = record.value as { absoluteCents: number; percentOfBase: number };
    return {
      absoluteCents: value.absoluteCents,
      percentOfBase: value.percentOfBase,
      source: record.source,
    };
  }

  async setMateriality(scope: MemoryScope, materiality: Omit<Materiality, 'source'>, source: string): Promise<void> {
    await this.store.put({
      kind: 'semantic',
      client: scope.client,
      userId: scope.userId ?? '',
      key: '_materiality',
      value: materiality,
      confidence: 0.95,
      source,
    });
  }

  async getCapitalizationPolicy(scope: MemoryScope): Promise<CapitalizationPolicy | null> {
    const record = await this.store.get('semantic', scope, '_capitalization');
    if (!record) return null;
    const value = record.value as { thresholdCents: number; minLifeMonths: number };
    return {
      thresholdCents: value.thresholdCents,
      minLifeMonths: value.minLifeMonths,
      source: record.source,
    };
  }

  async setCapitalizationPolicy(scope: MemoryScope, policy: Omit<CapitalizationPolicy, 'source'>, source: string): Promise<void> {
    await this.store.put({
      kind: 'semantic',
      client: scope.client,
      userId: scope.userId ?? '',
      key: '_capitalization',
      value: policy,
      confidence: 0.95,
      source,
    });
  }

  async getFiscalYearStart(scope: MemoryScope): Promise<FiscalYearStart | null> {
    const record = await this.store.get('semantic', scope, '_fiscal_year_start');
    if (!record) return null;
    const value = record.value as { month: number };
    return {
      month: value.month,
      source: record.source,
    };
  }

  async setFiscalYearStart(scope: MemoryScope, month: number, source: string): Promise<void> {
    if (month < 1 || month > 12) {
      throw new Error('Fiscal year start month must be 1-12');
    }
    await this.store.put({
      kind: 'semantic',
      client: scope.client,
      userId: scope.userId ?? '',
      key: '_fiscal_year_start',
      value: { month },
      confidence: 0.95,
      source,
    });
  }
}
