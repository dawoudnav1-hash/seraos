/**
 * Where a client's connection to a provider lives: which company/tenant,
 * its encrypted tokens, and sync bookkeeping. In-memory by default; the
 * Postgres-backed implementation (table `integrations`) slots in through
 * `setConnectionStore` without any caller needing to change.
 */

import type { Provider } from './oauth';

export type { Provider };

export type ConnectionStatus = 'connected' | 'disconnected' | 'error';

export interface Connection {
  provider: Provider;
  /** Our internal client/org id — the tenant of *our* platform, not theirs. */
  client: string;
  /** QBO realmId or Xero tenantId. */
  externalId: string;
  /** AES-256-GCM encrypted TokenSet, see lib/integrations/oauth.ts. */
  tokensEnc: string;
  status: ConnectionStatus;
  scopes: string[];
  connectedAt: string;
  updatedAt: string;
  lastSyncAt: string | null;
}

export interface ConnectionStore {
  get(provider: Provider, client: string): Promise<Connection | null>;
  put(connection: Connection): Promise<void>;
  delete(provider: Provider, client: string): Promise<void>;
}

function key(provider: Provider, client: string): string {
  return `${provider}:${client}`;
}

export class InMemoryConnectionStore implements ConnectionStore {
  private readonly rows = new Map<string, Connection>();

  async get(provider: Provider, client: string): Promise<Connection | null> {
    return this.rows.get(key(provider, client)) ?? null;
  }

  async put(connection: Connection): Promise<void> {
    this.rows.set(key(connection.provider, connection.client), connection);
  }

  async delete(provider: Provider, client: string): Promise<void> {
    this.rows.delete(key(provider, client));
  }
}

let store: ConnectionStore = new InMemoryConnectionStore();

/** Swap the backing store — the lead's Postgres implementation calls this once at startup. */
export function setConnectionStore(next: ConnectionStore): void {
  store = next;
}

export function getConnectionStore(): ConnectionStore {
  return store;
}
