/**
 * Memory storage interfaces and in-memory implementations.
 * The lead will add a Postgres store backed by tables with exactly these columns (snake_case).
 */

export type MemoryKind = 'process' | 'historical' | 'user' | 'semantic';

export interface MemoryScope {
  client: string;
  userId?: string;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  client: string;
  userId: string;
  key: string;
  value: Record<string, unknown> | string | number | boolean;
  confidence: number; // 0..1
  source: string; // where it came from, e.g. run id or 'user'
  hits: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryStore {
  // Upserts if (kind, client, userId, key) exists; otherwise creates
  put(record: Omit<MemoryRecord, 'id' | 'hits' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord>;

  // Retrieves a single record by kind, scope, and key
  get(kind: MemoryKind, scope: MemoryScope, key: string): Promise<MemoryRecord | null>;

  // Lists all records matching kind, scope, and optional prefix
  list(kind: MemoryKind, scope: MemoryScope, prefix?: string): Promise<MemoryRecord[]>;

  // Increments hits count
  touch(id: string): Promise<void>;

  // Deletes a record
  delete(id: string): Promise<void>;
}

export interface RuleRecord {
  id: string;
  client: string;
  kind: 'coding' | 'mapping' | 'je_line' | 'classification';
  pattern: Record<string, unknown>;
  action: Record<string, unknown>;
  status: 'candidate' | 'promoted' | 'rejected';
  confirmations: number;
  rejections: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RuleStore {
  // Creates a new rule or increments confirmations if it exists with same pattern+action
  put(record: Omit<RuleRecord, 'id' | 'createdAt' | 'updatedAt' | 'confirmations' | 'rejections'>): Promise<RuleRecord>;

  // Retrieves a rule by id
  get(id: string): Promise<RuleRecord | null>;

  // Lists rules by client and kind
  list(client: string, kind?: 'coding' | 'mapping' | 'je_line' | 'classification'): Promise<RuleRecord[]>;

  // Updates a rule's status and counts
  update(id: string, updates: Partial<Omit<RuleRecord, 'id' | 'client' | 'kind' | 'pattern' | 'action' | 'createdAt' | 'updatedAt'>>): Promise<RuleRecord>;

  // Deletes a rule
  delete(id: string): Promise<void>;
}

/**
 * In-memory implementation of MemoryStore.
 * Suitable for development and testing; the lead will add a Postgres store.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private records: Map<string, MemoryRecord> = new Map();
  private keyIndex: Map<string, string> = new Map();
  private nextId = 1;

  private getKeyIndexKey(kind: MemoryKind, client: string, userId: string, key: string): string {
    return `${kind}:${client}:${userId}:${key}`;
  }

  async put(record: Omit<MemoryRecord, 'id' | 'hits' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    const indexKey = this.getKeyIndexKey(record.kind, record.client, record.userId, record.key);
    const existingId = this.keyIndex.get(indexKey);

    if (existingId) {
      const existing = this.records.get(existingId)!;
      const updated = {
        ...existing,
        ...record,
        updatedAt: new Date(),
      };
      this.records.set(existingId, updated);
      return updated;
    }

    const id = `mem_${this.nextId++}`;
    const newRecord: MemoryRecord = {
      ...record,
      id,
      hits: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.records.set(id, newRecord);
    this.keyIndex.set(indexKey, id);
    return newRecord;
  }

  async get(kind: MemoryKind, scope: MemoryScope, key: string): Promise<MemoryRecord | null> {
    const indexKey = this.getKeyIndexKey(kind, scope.client, scope.userId ?? '', key);
    const id = this.keyIndex.get(indexKey);
    return id ? this.records.get(id) ?? null : null;
  }

  async list(kind: MemoryKind, scope: MemoryScope, prefix?: string): Promise<MemoryRecord[]> {
    return Array.from(this.records.values()).filter((r) => {
      if (r.kind !== kind) return false;
      if (r.client !== scope.client) return false;
      if (scope.userId && r.userId !== scope.userId) return false;
      if (prefix && !r.key.startsWith(prefix)) return false;
      return true;
    });
  }

  async touch(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.hits += 1;
      record.updatedAt = new Date();
    }
  }

  async delete(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      const indexKey = this.getKeyIndexKey(record.kind, record.client, record.userId, record.key);
      this.keyIndex.delete(indexKey);
      this.records.delete(id);
    }
  }
}

/**
 * In-memory implementation of RuleStore.
 * Suitable for development and testing; the lead will add a Postgres store.
 */
export class InMemoryRuleStore implements RuleStore {
  private rules: Map<string, RuleRecord> = new Map();
  private nextId = 1;

  async put(record: Omit<RuleRecord, 'id' | 'createdAt' | 'updatedAt' | 'confirmations' | 'rejections'>): Promise<RuleRecord> {
    // Check if a rule with same pattern and action already exists
    const existing = Array.from(this.rules.values()).find(
      (r) =>
        r.client === record.client &&
        r.kind === record.kind &&
        JSON.stringify(r.pattern) === JSON.stringify(record.pattern) &&
        JSON.stringify(r.action) === JSON.stringify(record.action),
    );

    if (existing) {
      existing.confirmations += 1;
      existing.updatedAt = new Date();
      return existing;
    }

    const id = `rule_${this.nextId++}`;
    const newRule: RuleRecord = {
      ...record,
      id,
      confirmations: 1,
      rejections: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rules.set(id, newRule);
    return newRule;
  }

  async get(id: string): Promise<RuleRecord | null> {
    return this.rules.get(id) ?? null;
  }

  async list(client: string, kind?: 'coding' | 'mapping' | 'je_line' | 'classification'): Promise<RuleRecord[]> {
    return Array.from(this.rules.values()).filter(
      (r) => r.client === client && (!kind || r.kind === kind),
    );
  }

  async update(id: string, updates: Partial<Omit<RuleRecord, 'id' | 'client' | 'kind' | 'pattern' | 'action' | 'createdAt' | 'updatedAt'>>): Promise<RuleRecord> {
    const rule = this.rules.get(id);
    if (!rule) {
      throw new Error(`Rule not found: ${id}`);
    }
    Object.assign(rule, updates);
    rule.updatedAt = new Date();
    return rule;
  }

  async delete(id: string): Promise<void> {
    this.rules.delete(id);
  }
}
