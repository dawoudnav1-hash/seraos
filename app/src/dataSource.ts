// The generated data files are imported as raw text and parsed defensively, so a malformed or
// partially-written file shows a warning instead of a blank page (and TypeScript does not have to
// infer a type for a multi-megabyte JSON literal).
import accountsText from './data/accounts.json?raw';
import outreachText from './data/outreach.json?raw';
import { normalizeAccounts, normalizeOutreach, parseJSONSafe, type OutreachData } from './lib/data';
import type { Account } from './types';

export interface LoadedData {
  accounts: Account[];
  outreach: OutreachData;
  warnings: string[];
}

export function loadData(): LoadedData {
  const warnings: string[] = [];
  const rawAccounts = parseJSONSafe(accountsText);
  if (rawAccounts === undefined) warnings.push('src/data/accounts.json could not be parsed as JSON.');
  const rawOutreach = parseJSONSafe(outreachText);
  if (rawOutreach === undefined) warnings.push('src/data/outreach.json could not be parsed as JSON.');
  const a = normalizeAccounts(rawAccounts);
  const o = normalizeOutreach(rawOutreach ?? {});
  return {
    accounts: a.accounts,
    outreach: o.outreach,
    warnings: [...warnings, ...a.warnings, ...(rawOutreach === undefined ? [] : o.warnings)],
  };
}
