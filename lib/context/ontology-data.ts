/**
 * Accounting domain ontology: the data. US GAAP, small and mid-sized business.
 *
 * Code-first on purpose: every cross-reference is a typed id, so a typo fails
 * `tsc` instead of silently weakening a verification gate. Functions over this
 * data live in `ontology.ts`; relations are derived there from the fields here
 * so there is a single source of truth.
 */
import type { JournalEntryType } from '@/lib/engine/types';

// ─── Core types ──────────────────────────────────────────────────────────────

export type AccountClass = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type NormalBalance = 'debit' | 'credit';

export type StatementSection =
  | 'current_asset'
  | 'noncurrent_asset'
  | 'current_liability'
  | 'noncurrent_liability'
  | 'equity'
  | 'revenue'
  | 'cost_of_revenue'
  | 'operating_expense'
  | 'other_income_expense'
  | 'income_tax';

export type ConceptKind =
  | 'account_class'
  | 'contra_class'
  | 'account_subtype'
  | 'entry_type'
  | 'schedule'
  | 'reconciliation'
  | 'txn_category'
  | 'standard'
  | 'close_task';

export const STANDARD_IDS = [
  'asc.606',
  'asc.842',
  'asc.360',
  'asc.350',
  'asc.340-40',
  'asc.340-10',
  'asc.450',
  'asc.855',
  'asc.326',
  'asc.330',
  'asc.740',
  'asc.470',
] as const;
export type StandardId = (typeof STANDARD_IDS)[number];

export const ACCOUNT_SUBTYPE_IDS = [
  // Current assets
  'cash',
  'accounts_receivable',
  'allowance_for_doubtful_accounts',
  'other_receivables',
  'inventory',
  'prepaid_expenses',
  'deferred_contract_costs',
  'other_current_assets',
  // Noncurrent assets
  'land',
  'buildings',
  'leasehold_improvements',
  'machinery_equipment',
  'furniture_fixtures',
  'computer_equipment',
  'vehicles',
  'construction_in_progress',
  'other_fixed_assets',
  'accumulated_depreciation',
  'right_of_use_asset',
  'intangible_assets',
  'goodwill',
  'accumulated_amortization',
  'other_assets',
  // Current liabilities
  'accounts_payable',
  'credit_card_payable',
  'accrued_liabilities',
  'payroll_liabilities',
  'sales_tax_payable',
  'income_tax_payable',
  'deferred_revenue',
  'short_term_debt',
  'other_current_liabilities',
  // Noncurrent liabilities
  'lease_liability',
  'long_term_debt',
  'other_long_term_liabilities',
  // Equity
  'owners_equity',
  'retained_earnings',
  'opening_balance_equity',
  'owner_distributions',
  'treasury_stock',
  // Revenue
  'revenue',
  'sales_returns_allowances',
  // Cost of revenue
  'cogs',
  // Operating expenses
  'payroll_expense',
  'payroll_tax_expense',
  'employee_benefits',
  'contract_labor',
  'rent_expense',
  'software_subscriptions',
  'professional_fees',
  'marketing_advertising',
  'travel',
  'meals_entertainment',
  'office_supplies',
  'shipping_freight',
  'utilities',
  'insurance_expense',
  'repairs_maintenance',
  'taxes_licenses',
  'bank_merchant_fees',
  'bad_debt_expense',
  'depreciation_expense',
  'amortization_expense',
  'other_operating_expense',
  // Other income / expense
  'interest_income',
  'other_income',
  'interest_expense',
  'other_expense',
  // Income tax
  'income_tax_expense',
] as const;
export type AccountSubtypeId = (typeof ACCOUNT_SUBTYPE_IDS)[number];

export type SubtypeTag =
  | 'fixed_asset'
  | 'depreciable'
  | 'intangible'
  | 'payroll_expense'
  | 'subledger_control'
  | 'debt'
  | 'lease';

export interface ConceptBase {
  id: string;
  kind: ConceptKind;
  label: string;
  /** Alternate names a person or a ledger might use. Drives `lookup`. */
  synonyms: string[];
  /** One or two sentences. The first sentence is what goes into prompts. */
  definition: string;
  standards?: StandardId[];
}

export interface StandardDef extends ConceptBase {
  kind: 'standard';
  id: StandardId;
  /** Citation form, e.g. "ASC 606". */
  code: string;
}

export interface AccountClassDef extends ConceptBase {
  kind: 'account_class';
  id: AccountClass;
  normalBalance: NormalBalance;
  /** Leading digit(s) of the conventional US chart-of-accounts number. */
  numberPrefixes: string[];
}

export interface ContraClassDef extends ConceptBase {
  kind: 'contra_class';
  id: `contra_${AccountClass}`;
  class: AccountClass;
  normalBalance: NormalBalance;
}

export interface AccountSubtypeDef extends ConceptBase {
  kind: 'account_subtype';
  id: AccountSubtypeId;
  class: AccountClass;
  normalBalance: NormalBalance;
  section: StatementSection;
  /** Present on contra accounts: the accounts whose carrying amount this reduces. */
  contraOf?: AccountSubtypeId[];
  tags?: SubtypeTag[];
}

/** Matches an account subtype if ANY listed criterion matches. */
export interface AccountSelector {
  subtypes?: AccountSubtypeId[];
  classes?: AccountClass[];
  sections?: StatementSection[];
  tags?: SubtypeTag[];
}

export interface EntryLeg {
  side: 'debit' | 'credit';
  accounts: AccountSelector;
  /** Human wording for prompts and failure messages. */
  label: string;
}

/**
 * One acceptable shape for an entry type. Every leg needs at least one line on
 * its side; when `strict`, every line must also belong to some leg.
 */
export interface EntryPattern {
  name: string;
  legs: EntryLeg[];
  strict: boolean;
}

export interface EntryTypeDef extends ConceptBase {
  kind: 'entry_type';
  id: `je.${JournalEntryType}`;
  entryType: JournalEntryType;
  /** Any one pattern satisfies the type. Empty = no account constraint. */
  patterns: EntryPattern[];
  /** Must carry `reversesOn` (accruals). */
  autoReverse: boolean;
  /** Flag lines that move an expense, revenue or accumulated-contra account against its normal balance. */
  enforceDirection: boolean;
  /** Accounts that may legitimately move against normal balance in this type. */
  allowAgainstNormal?: AccountSelector;
}

export const SCHEDULE_IDS = [
  'schedule.fixed_asset_rollforward',
  'schedule.depreciation',
  'schedule.amortization',
  'schedule.deferred_revenue',
  'schedule.prepaid',
  'schedule.accrual',
  'schedule.lease',
  'schedule.balance_sheet_rollforward',
] as const;
export type ScheduleId = (typeof SCHEDULE_IDS)[number];

/** Every schedule is opening + additions − reductions = closing. */
export interface RollForward {
  opening: string;
  additions: string[];
  reductions: string[];
  closing: string;
}

export interface ScheduleDef extends ConceptBase {
  kind: 'schedule';
  id: ScheduleId;
  rollForward: RollForward;
  /** Accounts whose GL balance the closing column must tie to. */
  supports: AccountSelector;
  /** Entry types the schedule drives. */
  entryTypes: JournalEntryType[];
  /** Fields each schedule row needs. */
  requiredFields: string[];
  dependsOn?: ScheduleId[];
}

export const RECONCILIATION_IDS = ['rec.bank', 'rec.credit_card', 'rec.gl_subledger', 'rec.stripe_payout'] as const;
export type ReconciliationId = (typeof RECONCILIATION_IDS)[number];

export interface ReconciliationSide {
  name: string;
  /** SourceRef.system the side's records come from. */
  system: string;
  requiredFields: string[];
}

export interface ReconciliationDef extends ConceptBase {
  kind: 'reconciliation';
  id: ReconciliationId;
  sides: [ReconciliationSide, ReconciliationSide];
  accounts: AccountSelector;
  matchOn: string[];
  reconcilingItems: string[];
  /** The equation that must hold for the rec to be done. */
  proof: string;
}

export interface TxnCategoryDef extends ConceptBase {
  kind: 'txn_category';
  id: `txn.${string}`;
  subtype: AccountSubtypeId;
  /** Sign convention: negative amount = money out of the bank/card holder. */
  direction: 'outflow' | 'inflow' | 'either';
  /** Merchant / description phrases, matched as whole words after normalizing. */
  keywords: string[];
}

export const CLOSE_TASK_IDS = [
  'close.sync_sources',
  'close.txn_coding',
  'close.bank_rec',
  'close.card_rec',
  'close.stripe_payout_rec',
  'close.ar_tieout',
  'close.ap_tieout',
  'close.payroll',
  'close.accruals',
  'close.prepaids',
  'close.fixed_assets',
  'close.depreciation',
  'close.amortization',
  'close.revenue_recognition',
  'close.leases',
  'close.post_entries',
  'close.schedule_tieouts',
  'close.gl_review',
  'close.tb_flux',
  'close.subsequent_events',
  'close.consolidation',
  'close.financial_statements',
  'close.lock_period',
] as const;
export type CloseTaskId = (typeof CLOSE_TASK_IDS)[number];

export interface CloseTaskDef extends ConceptBase {
  kind: 'close_task';
  id: CloseTaskId;
  dependsOn: CloseTaskId[];
  /** Ontology concepts (recs, schedules, entry types) the task works with. */
  uses: string[];
}

export type Concept =
  | AccountClassDef
  | ContraClassDef
  | AccountSubtypeDef
  | EntryTypeDef
  | ScheduleDef
  | ReconciliationDef
  | TxnCategoryDef
  | StandardDef
  | CloseTaskDef;

export type RelationKind = 'contra_of' | 'rolls_forward_to' | 'reconciles_to' | 'posts_to' | 'governed_by' | 'depends_on';

export interface Relation {
  from: string;
  kind: RelationKind;
  to: string;
}

// ─── Standards ───────────────────────────────────────────────────────────────

export const STANDARDS: StandardDef[] = [
  {
    kind: 'standard',
    id: 'asc.606',
    code: 'ASC 606',
    label: 'Revenue from Contracts with Customers',
    synonyms: ['606', 'topic 606', 'revenue recognition standard', 'five step model', 'ifrs 15'],
    definition:
      'Recognize revenue when (or as) control of promised goods or services transfers to the customer, at the consideration expected. Five steps: contract, performance obligations, transaction price, allocation, recognition.',
  },
  {
    kind: 'standard',
    id: 'asc.842',
    code: 'ASC 842',
    label: 'Leases',
    synonyms: ['842', 'topic 842', 'lease accounting', 'ifrs 16'],
    definition:
      'Lessees recognize a right-of-use asset and a lease liability for leases over 12 months. Operating leases expense a single straight-line cost; finance leases split amortization and interest.',
  },
  {
    kind: 'standard',
    id: 'asc.360',
    code: 'ASC 360',
    label: 'Property, Plant, and Equipment',
    synonyms: ['360', 'topic 360', 'fixed asset accounting', 'pp and e standard', 'impairment of long lived assets'],
    definition:
      'Capitalize the cost to acquire and ready long-lived tangible assets, depreciate cost less salvage over the useful life, and derecognize on disposal with a gain or loss. Test for impairment when indicators exist.',
  },
  {
    kind: 'standard',
    id: 'asc.350',
    code: 'ASC 350',
    label: 'Intangibles — Goodwill and Other',
    synonyms: ['350', 'topic 350', 'asc 350 40', 'internal use software', 'goodwill impairment'],
    definition:
      'Finite-lived intangibles amortize over their useful life; goodwill and indefinite-lived intangibles are tested for impairment instead (private companies may elect to amortize goodwill). 350-40 capitalizes internal-use software development costs.',
  },
  {
    kind: 'standard',
    id: 'asc.340-40',
    code: 'ASC 340-40',
    label: 'Contract Costs',
    synonyms: ['340 40', 'capitalized commissions', 'costs to obtain a contract', 'contract costs standard'],
    definition:
      'Incremental costs to obtain a customer contract (e.g. sales commissions) are capitalized and amortized consistent with the transfer of the related goods or services. Practical expedient: expense when the amortization period is one year or less.',
  },
  {
    kind: 'standard',
    id: 'asc.340-10',
    code: 'ASC 340-10',
    label: 'Other Assets and Deferred Costs',
    synonyms: ['340 10', 'prepaid expense guidance'],
    definition: 'Payments for goods or services not yet received are assets, expensed as the benefit is consumed.',
  },
  {
    kind: 'standard',
    id: 'asc.450',
    code: 'ASC 450',
    label: 'Contingencies',
    synonyms: ['450', 'topic 450', 'loss contingency', 'contingent liabilities'],
    definition:
      'Accrue a loss contingency when a loss is probable and reasonably estimable; disclose it when reasonably possible. Gain contingencies are not recognized until realized.',
  },
  {
    kind: 'standard',
    id: 'asc.855',
    code: 'ASC 855',
    label: 'Subsequent Events',
    synonyms: ['855', 'topic 855', 'subsequent events review', 'recognized and nonrecognized subsequent events'],
    definition:
      'Events after the balance-sheet date but before issuance are recognized if they give evidence of conditions that existed at the balance-sheet date, and disclosed if the conditions arose afterward.',
  },
  {
    kind: 'standard',
    id: 'asc.326',
    code: 'ASC 326',
    label: 'Credit Losses (CECL)',
    synonyms: ['326', 'topic 326', 'cecl', 'current expected credit losses'],
    definition: 'Estimate expected credit losses on receivables over their life and record them through an allowance.',
  },
  {
    kind: 'standard',
    id: 'asc.330',
    code: 'ASC 330',
    label: 'Inventory',
    synonyms: ['330', 'topic 330', 'inventory costing', 'lower of cost and net realizable value'],
    definition:
      'Carry inventory at cost (FIFO, average or LIFO) and write it down to net realizable value when lower; cost flows to COGS on sale.',
  },
  {
    kind: 'standard',
    id: 'asc.740',
    code: 'ASC 740',
    label: 'Income Taxes',
    synonyms: ['740', 'topic 740', 'tax provision', 'deferred taxes'],
    definition:
      'Record current taxes payable plus deferred tax assets and liabilities for temporary differences, with a valuation allowance when realization is not more likely than not.',
  },
  {
    kind: 'standard',
    id: 'asc.470',
    code: 'ASC 470',
    label: 'Debt',
    synonyms: ['470', 'topic 470', 'debt classification'],
    definition:
      'Classify debt as current or noncurrent by maturity and covenant status; issuance costs reduce the carrying amount and amortize to interest expense.',
  },
];

// ─── Account classes ─────────────────────────────────────────────────────────

export const CLASS_NORMAL_BALANCE: Record<AccountClass, NormalBalance> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

export const ACCOUNT_CLASSES: AccountClassDef[] = [
  {
    kind: 'account_class',
    id: 'asset',
    label: 'Asset',
    synonyms: ['assets'],
    definition: 'A resource the entity controls from which future economic benefit is expected.',
    normalBalance: 'debit',
    numberPrefixes: ['1'],
  },
  {
    kind: 'account_class',
    id: 'liability',
    label: 'Liability',
    synonyms: ['liabilities', 'obligations'],
    definition: 'A present obligation to transfer resources as a result of past events.',
    normalBalance: 'credit',
    numberPrefixes: ['2'],
  },
  {
    kind: 'account_class',
    id: 'equity',
    label: 'Equity',
    synonyms: ['net assets', 'stockholders equity', 'shareholders equity', 'net worth', 'capital'],
    definition: 'The residual interest in assets after deducting liabilities.',
    normalBalance: 'credit',
    numberPrefixes: ['3'],
  },
  {
    kind: 'account_class',
    id: 'revenue',
    label: 'Revenue',
    synonyms: ['income', 'sales', 'turnover'],
    definition: 'Inflows from delivering goods or services in ordinary activities, plus other income.',
    normalBalance: 'credit',
    numberPrefixes: ['4'],
  },
  {
    kind: 'account_class',
    id: 'expense',
    label: 'Expense',
    synonyms: ['expenses', 'costs', 'cost'],
    definition: 'Outflows or consumption of assets from delivering goods or services and running the business.',
    normalBalance: 'debit',
    numberPrefixes: ['5', '6', '7'],
  },
];

export const CONTRA_CLASSES: ContraClassDef[] = [
  {
    kind: 'contra_class',
    id: 'contra_asset',
    class: 'asset',
    normalBalance: 'credit',
    label: 'Contra-asset',
    synonyms: ['contra asset', 'valuation account'],
    definition: 'An asset-side account with a credit balance that reduces a related asset, e.g. accumulated depreciation.',
  },
  {
    kind: 'contra_class',
    id: 'contra_liability',
    class: 'liability',
    normalBalance: 'debit',
    label: 'Contra-liability',
    synonyms: ['contra liability', 'debt discount', 'unamortized debt issuance costs'],
    definition: 'A liability-side account with a debit balance that reduces a related liability, e.g. debt discount.',
  },
  {
    kind: 'contra_class',
    id: 'contra_equity',
    class: 'equity',
    normalBalance: 'debit',
    label: 'Contra-equity',
    synonyms: ['contra equity'],
    definition: 'An equity account with a debit balance, e.g. treasury stock or owner distributions.',
  },
  {
    kind: 'contra_class',
    id: 'contra_revenue',
    class: 'revenue',
    normalBalance: 'debit',
    label: 'Contra-revenue',
    synonyms: ['contra revenue'],
    definition: 'A revenue account with a debit balance that reduces gross revenue, e.g. returns and discounts.',
  },
  {
    kind: 'contra_class',
    id: 'contra_expense',
    class: 'expense',
    normalBalance: 'credit',
    label: 'Contra-expense',
    synonyms: ['contra expense', 'expense recovery'],
    definition: 'An expense account with a credit balance that offsets an expense, e.g. purchase discounts.',
  },
];

// ─── Account subtypes ────────────────────────────────────────────────────────

const flip = (b: NormalBalance): NormalBalance => (b === 'debit' ? 'credit' : 'debit');

/** Normal balance is derived, never typed in: class normal, flipped for contras. */
function sub(
  id: AccountSubtypeId,
  cls: AccountClass,
  section: StatementSection,
  label: string,
  synonyms: string[],
  definition: string,
  extra: Pick<AccountSubtypeDef, 'contraOf' | 'tags' | 'standards'> = {},
): AccountSubtypeDef {
  const normal = CLASS_NORMAL_BALANCE[cls];
  return {
    kind: 'account_subtype',
    id,
    class: cls,
    section,
    label,
    synonyms,
    definition,
    normalBalance: extra.contraOf?.length ? flip(normal) : normal,
    ...extra,
  };
}

export const FIXED_ASSET_SUBTYPES: AccountSubtypeId[] = [
  'land',
  'buildings',
  'leasehold_improvements',
  'machinery_equipment',
  'furniture_fixtures',
  'computer_equipment',
  'vehicles',
  'construction_in_progress',
  'other_fixed_assets',
];
// Land is not depreciated; CIP starts depreciating only when placed in service.
const DEPRECIABLE: AccountSubtypeId[] = FIXED_ASSET_SUBTYPES.filter((s) => s !== 'land' && s !== 'construction_in_progress');
const FA = { tags: ['fixed_asset', 'depreciable'] as SubtypeTag[], standards: ['asc.360'] as StandardId[] };

export const ACCOUNT_SUBTYPES: AccountSubtypeDef[] = [
  sub('cash', 'asset', 'current_asset', 'Cash and cash equivalents', ['cash', 'bank', 'checking', 'savings', 'money market', 'petty cash', 'operating account', 'undeposited funds', 'cash equivalents'], 'Currency, demand deposits and highly liquid investments maturing within three months of purchase.'),
  sub('accounts_receivable', 'asset', 'current_asset', 'Accounts receivable', ['ar', 'a/r', 'trade receivables', 'receivables', 'debtors', 'unbilled receivables', 'contract asset', 'accrued revenue'], 'Amounts customers owe for goods or services already delivered, including unbilled contract assets.', { tags: ['subledger_control'], standards: ['asc.606', 'asc.326'] }),
  sub('allowance_for_doubtful_accounts', 'asset', 'current_asset', 'Allowance for doubtful accounts', ['allowance for bad debts', 'bad debt reserve', 'allowance for credit losses', 'doubtful accounts'], 'Contra-asset for receivables not expected to be collected.', { contraOf: ['accounts_receivable'], standards: ['asc.326'] }),
  sub('other_receivables', 'asset', 'current_asset', 'Other receivables', ['employee advances', 'loans to officers', 'notes receivable', 'due from related party', 'interest receivable'], 'Non-trade amounts owed to the entity: employee advances, officer loans, refunds and interest receivable.'),
  sub('inventory', 'asset', 'current_asset', 'Inventory', ['stock', 'merchandise', 'finished goods', 'raw materials', 'work in process', 'inventory asset'], 'Goods held for sale or used in production, at the lower of cost and net realizable value.', { tags: ['subledger_control'], standards: ['asc.330'] }),
  sub('prepaid_expenses', 'asset', 'current_asset', 'Prepaid expenses', ['prepaids', 'prepayments', 'prepaid insurance', 'prepaid rent', 'prepaid software', 'deferred expenses'], 'Payments made in advance for goods or services to be received, expensed as consumed.', { standards: ['asc.340-10'] }),
  sub('deferred_contract_costs', 'asset', 'current_asset', 'Deferred contract costs', ['capitalized commissions', 'deferred commissions', 'costs to obtain a contract'], 'Capitalized incremental costs of obtaining customer contracts, amortized over the benefit period.', { standards: ['asc.340-40'] }),
  sub('other_current_assets', 'asset', 'current_asset', 'Other current assets', ['other current asset', 'short term investments'], 'Current assets not classified elsewhere.'),

  sub('land', 'asset', 'noncurrent_asset', 'Land', ['land'], 'Land owned for use in operations; not depreciated.', { tags: ['fixed_asset'], standards: ['asc.360'] }),
  sub('buildings', 'asset', 'noncurrent_asset', 'Buildings', ['building', 'real property'], 'Owned buildings and building improvements.', FA),
  sub('leasehold_improvements', 'asset', 'noncurrent_asset', 'Leasehold improvements', ['tenant improvements', 'leasehold'], 'Improvements to leased space, depreciated over the shorter of useful life and lease term.', FA),
  sub('machinery_equipment', 'asset', 'noncurrent_asset', 'Machinery and equipment', ['equipment', 'machinery', 'office equipment', 'tools and equipment'], 'Machinery, tools and general equipment used in operations.', FA),
  sub('furniture_fixtures', 'asset', 'noncurrent_asset', 'Furniture and fixtures', ['furniture', 'fixtures', 'f and f'], 'Office furniture, fixtures and furnishings.', FA),
  sub('computer_equipment', 'asset', 'noncurrent_asset', 'Computer equipment', ['computers', 'computer hardware', 'it equipment', 'laptops', 'servers'], 'Computers, servers and related hardware.', FA),
  sub('vehicles', 'asset', 'noncurrent_asset', 'Vehicles', ['vehicle', 'trucks', 'automobiles', 'autos', 'fleet'], 'Cars, trucks and other vehicles owned for operations.', FA),
  sub('construction_in_progress', 'asset', 'noncurrent_asset', 'Construction in progress', ['cip', 'assets under construction'], 'Costs of assets not yet placed in service; not depreciated until then.', { tags: ['fixed_asset'], standards: ['asc.360'] }),
  sub('other_fixed_assets', 'asset', 'noncurrent_asset', 'Other fixed assets', ['fixed assets', 'property plant and equipment', 'pp and e', 'ppe'], 'Property and equipment not classified elsewhere.', FA),
  sub('accumulated_depreciation', 'asset', 'noncurrent_asset', 'Accumulated depreciation', ['accum depr', 'a/d', 'accumulated depreciation'], 'Contra-asset holding depreciation recognized to date on fixed assets.', { contraOf: DEPRECIABLE, standards: ['asc.360'] }),
  sub('right_of_use_asset', 'asset', 'noncurrent_asset', 'Right-of-use asset', ['rou asset', 'right of use', 'operating lease asset', 'finance lease asset'], "A lessee's right to use a leased asset over the lease term.", { tags: ['lease'], standards: ['asc.842'] }),
  sub('intangible_assets', 'asset', 'noncurrent_asset', 'Intangible assets', ['intangibles', 'patents', 'trademarks', 'capitalized software', 'internal use software', 'customer relationships'], 'Identifiable non-physical assets such as software, patents and customer lists.', { tags: ['intangible'], standards: ['asc.350'] }),
  sub('goodwill', 'asset', 'noncurrent_asset', 'Goodwill', ['goodwill'], 'Excess of acquisition price over identifiable net assets; tested for impairment.', { tags: ['intangible'], standards: ['asc.350'] }),
  sub('accumulated_amortization', 'asset', 'noncurrent_asset', 'Accumulated amortization', ['accum amort', 'accumulated amortisation'], 'Contra-asset holding amortization recognized to date on intangibles.', { contraOf: ['intangible_assets', 'right_of_use_asset'], standards: ['asc.350'] }),
  sub('other_assets', 'asset', 'noncurrent_asset', 'Other assets', ['security deposits', 'deposits', 'long term investments', 'other noncurrent assets'], 'Noncurrent assets not classified elsewhere, such as security deposits.'),

  sub('accounts_payable', 'liability', 'current_liability', 'Accounts payable', ['ap', 'a/p', 'trade payables', 'creditors', 'vendor payables'], 'Amounts owed to vendors for invoices received.', { tags: ['subledger_control'] }),
  sub('credit_card_payable', 'liability', 'current_liability', 'Credit card payable', ['credit card', 'corporate card', 'charge card', 'amex', 'card payable'], 'Balances owed on company credit and charge cards.'),
  sub('accrued_liabilities', 'liability', 'current_liability', 'Accrued liabilities', ['accrued expenses', 'accruals', 'accrued liabilities', 'accrued interest'], 'Expenses incurred but not yet invoiced or paid.', { standards: ['asc.450'] }),
  sub('payroll_liabilities', 'liability', 'current_liability', 'Payroll liabilities', ['accrued payroll', 'wages payable', 'payroll taxes payable', 'withholdings', 'accrued vacation', 'payroll clearing'], 'Wages, withholdings, employer taxes and benefits owed but not yet paid.'),
  sub('sales_tax_payable', 'liability', 'current_liability', 'Sales tax payable', ['sales tax', 'use tax', 'vat payable', 'gst payable'], 'Sales and use tax collected or owed, not yet remitted.'),
  sub('income_tax_payable', 'liability', 'current_liability', 'Income tax payable', ['taxes payable', 'federal income tax payable', 'state income tax payable'], 'Current income taxes owed to tax authorities.', { standards: ['asc.740'] }),
  sub('deferred_revenue', 'liability', 'current_liability', 'Deferred revenue', ['unearned revenue', 'contract liability', 'customer deposits', 'deferred income'], 'Consideration received or billed before the related performance obligation is satisfied.', { standards: ['asc.606'] }),
  sub('short_term_debt', 'liability', 'current_liability', 'Short-term debt', ['line of credit', 'loc', 'revolver', 'current portion of long term debt'], 'Borrowings due within a year, including lines of credit and current maturities.', { tags: ['debt'], standards: ['asc.470'] }),
  sub('other_current_liabilities', 'liability', 'current_liability', 'Other current liabilities', ['other current liability', 'due to related party'], 'Current obligations not classified elsewhere.'),

  sub('lease_liability', 'liability', 'noncurrent_liability', 'Lease liability', ['lease obligation', 'operating lease liability', 'finance lease liability'], 'Present value of remaining lease payments.', { tags: ['lease'], standards: ['asc.842'] }),
  sub('long_term_debt', 'liability', 'noncurrent_liability', 'Long-term debt', ['notes payable', 'term loan', 'loans payable', 'mortgage', 'sba loan', 'convertible notes'], 'Borrowings due after more than one year.', { tags: ['debt'], standards: ['asc.470'] }),
  sub('other_long_term_liabilities', 'liability', 'noncurrent_liability', 'Other long-term liabilities', ['other noncurrent liabilities', 'long term liabilities'], 'Noncurrent obligations not classified elsewhere.'),

  sub('owners_equity', 'equity', 'equity', "Owners' equity / paid-in capital", ['common stock', 'additional paid in capital', 'apic', 'paid in capital', 'owners capital', 'partner capital', 'member contributions', 'capital contributions', 'preferred stock'], 'Capital contributed by owners: stock at par, APIC, owner, partner or member capital.'),
  sub('retained_earnings', 'equity', 'equity', 'Retained earnings', ['accumulated deficit', 'accumulated earnings', 'prior year earnings'], 'Cumulative net income less distributions; closed into from the income statement each year.'),
  sub('opening_balance_equity', 'equity', 'equity', 'Opening balance equity', ['obe', 'opening balance'], 'Ledger-software plug for opening balances; should be reclassified to zero.'),
  sub('owner_distributions', 'equity', 'equity', 'Owner distributions / draws', ['owner draws', 'drawings', 'distributions', 'dividends paid', 'partner distributions'], 'Contra-equity for amounts distributed to owners.', { contraOf: ['owners_equity', 'retained_earnings'] }),
  sub('treasury_stock', 'equity', 'equity', 'Treasury stock', ['treasury shares', 'repurchased stock'], 'Contra-equity for the cost of shares repurchased and held.', { contraOf: ['owners_equity'] }),

  sub('revenue', 'revenue', 'revenue', 'Revenue', ['sales', 'income', 'product revenue', 'service revenue', 'subscription revenue', 'fees earned'], 'Revenue from contracts with customers, recognized as performance obligations are satisfied.', { standards: ['asc.606'] }),
  sub('sales_returns_allowances', 'revenue', 'revenue', 'Sales returns, discounts and allowances', ['returns', 'refunds', 'sales discounts', 'discounts given', 'chargebacks'], 'Contra-revenue reducing gross sales for returns, refunds and discounts.', { contraOf: ['revenue'], standards: ['asc.606'] }),

  sub('cogs', 'expense', 'cost_of_revenue', 'Cost of goods sold', ['cost of sales', 'cost of revenue', 'cost of goods sold', 'direct costs', 'cos'], 'Direct cost of goods sold or services delivered.', { standards: ['asc.330'] }),

  sub('payroll_expense', 'expense', 'operating_expense', 'Wages and salaries', ['salaries', 'wages', 'payroll', 'compensation', 'bonuses', 'commissions'], 'Gross compensation of employees.', { tags: ['payroll_expense'] }),
  sub('payroll_tax_expense', 'expense', 'operating_expense', 'Payroll tax expense', ['employer taxes', 'fica', 'futa', 'suta', 'payroll taxes'], 'Employer share of payroll taxes.', { tags: ['payroll_expense'] }),
  sub('employee_benefits', 'expense', 'operating_expense', 'Employee benefits', ['benefits', 'health insurance', '401k match', 'workers compensation', 'retirement contributions'], 'Employer-paid health, retirement and other benefits.', { tags: ['payroll_expense'] }),
  sub('contract_labor', 'expense', 'operating_expense', 'Contract labor', ['contractors', '1099 contractors', 'freelancers', 'outsourced services', 'subcontractors'], 'Payments to independent contractors.'),
  sub('rent_expense', 'expense', 'operating_expense', 'Rent and occupancy', ['rent', 'occupancy', 'operating lease cost', 'lease expense', 'coworking'], 'Rent, occupancy and operating lease cost.', { standards: ['asc.842'] }),
  sub('software_subscriptions', 'expense', 'operating_expense', 'Software and subscriptions', ['software', 'saas', 'subscriptions', 'hosting', 'cloud services', 'dues and subscriptions'], 'SaaS, hosting and software licenses expensed as incurred.'),
  sub('professional_fees', 'expense', 'operating_expense', 'Professional fees', ['legal fees', 'accounting fees', 'audit fees', 'consulting fees', 'legal and professional'], 'Legal, accounting, audit and consulting services.'),
  sub('marketing_advertising', 'expense', 'operating_expense', 'Marketing and advertising', ['advertising', 'marketing', 'promotion', 'paid ads', 'sponsorships'], 'Advertising, promotion and marketing programs.'),
  sub('travel', 'expense', 'operating_expense', 'Travel', ['airfare', 'lodging', 'hotels', 'mileage', 'auto expense', 'ground transportation'], 'Business travel: airfare, lodging, ground transport and vehicle running costs.'),
  sub('meals_entertainment', 'expense', 'operating_expense', 'Meals and entertainment', ['meals', 'entertainment', 'business meals', 'travel meals'], 'Business meals and entertainment (tax-deductibility limits apply).'),
  sub('office_supplies', 'expense', 'operating_expense', 'Office supplies and expenses', ['office expenses', 'supplies', 'printing', 'small equipment'], 'Consumable office supplies and small equipment below the capitalization threshold.'),
  sub('shipping_freight', 'expense', 'operating_expense', 'Shipping and freight', ['shipping', 'postage', 'freight out', 'delivery', 'fulfillment'], 'Outbound shipping, postage and delivery (freight-in belongs in inventory/COGS).'),
  sub('utilities', 'expense', 'operating_expense', 'Utilities and telecom', ['utilities', 'electricity', 'water', 'internet', 'telephone', 'telecom'], 'Electricity, water, internet and phone service.'),
  sub('insurance_expense', 'expense', 'operating_expense', 'Insurance', ['insurance', 'general liability insurance', 'd and o insurance'], 'Business insurance premiums for the period (prepaid portion stays an asset).'),
  sub('repairs_maintenance', 'expense', 'operating_expense', 'Repairs and maintenance', ['repairs', 'maintenance', 'janitorial', 'cleaning'], 'Routine repairs and upkeep that do not extend useful life.'),
  sub('taxes_licenses', 'expense', 'operating_expense', 'Taxes and licenses', ['licenses and permits', 'franchise tax', 'property tax', 'business licenses'], 'Non-income taxes, licenses and permits.'),
  sub('bank_merchant_fees', 'expense', 'operating_expense', 'Bank and merchant fees', ['bank fees', 'bank charges', 'merchant fees', 'stripe fees', 'processing fees'], 'Bank service charges and payment-processing fees.'),
  sub('bad_debt_expense', 'expense', 'operating_expense', 'Bad debt expense', ['bad debts', 'credit loss expense', 'provision for doubtful accounts'], 'Expense for expected or actual uncollectible receivables.', { standards: ['asc.326'] }),
  sub('depreciation_expense', 'expense', 'operating_expense', 'Depreciation expense', ['depreciation', 'depreciation expense'], 'Periodic allocation of fixed-asset cost over useful life.', { standards: ['asc.360'] }),
  sub('amortization_expense', 'expense', 'operating_expense', 'Amortization expense', ['amortization', 'amortisation'], 'Periodic allocation of intangible or right-of-use asset cost.', { standards: ['asc.350'] }),
  sub('other_operating_expense', 'expense', 'operating_expense', 'Other operating expense', ['general and administrative', 'g and a', 'miscellaneous expense', 'uncategorized expense'], 'Operating expenses not classified elsewhere.'),

  sub('interest_income', 'revenue', 'other_income_expense', 'Interest and dividend income', ['interest income', 'interest earned', 'dividend income'], 'Interest and dividends earned on cash and investments.'),
  sub('other_income', 'revenue', 'other_income_expense', 'Other income', ['gain on sale', 'miscellaneous income', 'grant income', 'non operating income'], 'Non-operating income and gains, e.g. gain on asset disposal.'),
  sub('interest_expense', 'expense', 'other_income_expense', 'Interest expense', ['interest', 'finance charges', 'interest paid'], 'Interest on debt, finance leases and card balances.', { standards: ['asc.470'] }),
  sub('other_expense', 'expense', 'other_income_expense', 'Other expense', ['loss on disposal', 'penalties', 'fx loss', 'charitable contributions', 'non operating expense'], 'Non-operating expenses and losses.'),

  sub('income_tax_expense', 'expense', 'income_tax', 'Income tax expense', ['provision for income taxes', 'income taxes', 'tax provision'], 'Current and deferred income tax expense.', { standards: ['asc.740'] }),
];

// ─── Journal entry types ─────────────────────────────────────────────────────

const EXPENSE_ACCOUNTS: AccountSelector = { classes: ['expense'] };
// Only operating revenue: crediting contra-revenue or other income is not a recognition entry.
const REVENUE_ACCOUNTS: AccountSelector = { subtypes: ['revenue'] };

export const ENTRY_TYPES: Record<JournalEntryType, EntryTypeDef> = {
  manual: {
    kind: 'entry_type',
    id: 'je.manual',
    entryType: 'manual',
    label: 'Manual journal entry',
    synonyms: ['manual je', 'general journal entry', 'adjusting entry', 'aje'],
    definition: 'A one-off entry with no fixed account pattern; still must balance and cite a source on every line.',
    patterns: [],
    autoReverse: false,
    enforceDirection: false,
  },
  accrual: {
    kind: 'entry_type',
    id: 'je.accrual',
    entryType: 'accrual',
    label: 'Accrual entry',
    synonyms: ['accrue', 'expense accrual', 'revenue accrual', 'accrued expense entry'],
    definition: 'Recognizes an expense incurred (or revenue earned) but not yet invoiced; reverses on the first day of the next period.',
    patterns: [
      {
        name: 'expense accrual',
        strict: true,
        legs: [
          { side: 'debit', accounts: EXPENSE_ACCOUNTS, label: 'an expense' },
          { side: 'credit', accounts: { subtypes: ['accrued_liabilities', 'payroll_liabilities', 'income_tax_payable'] }, label: 'accrued liabilities' },
        ],
      },
      {
        name: 'revenue accrual',
        strict: true,
        legs: [
          { side: 'debit', accounts: { subtypes: ['accounts_receivable', 'other_receivables'] }, label: 'accounts receivable (unbilled)' },
          { side: 'credit', accounts: REVENUE_ACCOUNTS, label: 'revenue' },
        ],
      },
    ],
    autoReverse: true,
    enforceDirection: true,
    standards: ['asc.450'],
  },
  reversing: {
    kind: 'entry_type',
    id: 'je.reversing',
    entryType: 'reversing',
    label: 'Reversing entry',
    synonyms: ['reversal', 'auto reversal', 'reverse accrual'],
    definition: 'The mirror of a prior entry (usually an accrual), posted on its reversal date; lines should cite the original entry.',
    patterns: [],
    autoReverse: false,
    enforceDirection: false,
  },
  payroll: {
    kind: 'entry_type',
    id: 'je.payroll',
    entryType: 'payroll',
    label: 'Payroll entry',
    synonyms: ['payroll je', 'payroll journal', 'record payroll'],
    definition: 'Records gross wages, employer taxes and benefits against net pay (cash) and withholdings/employer taxes owed (payroll liabilities).',
    patterns: [
      {
        name: 'payroll',
        strict: false,
        legs: [
          { side: 'debit', accounts: { tags: ['payroll_expense'], subtypes: ['cogs'] }, label: 'wages, payroll taxes or benefits expense' },
          { side: 'credit', accounts: { subtypes: ['payroll_liabilities', 'cash'] }, label: 'payroll liabilities and/or cash' },
        ],
      },
    ],
    autoReverse: false,
    enforceDirection: true,
  },
  revenue_recognition: {
    kind: 'entry_type',
    id: 'je.revenue_recognition',
    entryType: 'revenue_recognition',
    label: 'Revenue recognition entry',
    synonyms: ['rev rec', 'recognize revenue', 'deferred revenue release', 'revenue release'],
    definition: 'Moves consideration from deferred revenue (or an unbilled contract asset) into revenue as performance obligations are satisfied.',
    patterns: [
      {
        name: 'release deferred revenue',
        strict: true,
        legs: [
          { side: 'debit', accounts: { subtypes: ['deferred_revenue'] }, label: 'deferred revenue' },
          { side: 'credit', accounts: REVENUE_ACCOUNTS, label: 'revenue' },
        ],
      },
      {
        name: 'recognize unbilled revenue',
        strict: true,
        legs: [
          { side: 'debit', accounts: { subtypes: ['accounts_receivable'] }, label: 'contract asset / unbilled receivable' },
          { side: 'credit', accounts: REVENUE_ACCOUNTS, label: 'revenue' },
        ],
      },
    ],
    autoReverse: false,
    enforceDirection: true,
    standards: ['asc.606'],
  },
  depreciation: {
    kind: 'entry_type',
    id: 'je.depreciation',
    entryType: 'depreciation',
    label: 'Depreciation entry',
    synonyms: ['monthly depreciation', 'book depreciation', 'depreciation je'],
    definition: "Allocates the period's share of fixed-asset cost to expense.",
    patterns: [
      {
        name: 'depreciation',
        strict: true,
        legs: [
          // COGS is allowed because manufacturers absorb production depreciation into cost.
          { side: 'debit', accounts: { subtypes: ['depreciation_expense', 'cogs'] }, label: 'depreciation expense' },
          { side: 'credit', accounts: { subtypes: ['accumulated_depreciation'] }, label: 'accumulated depreciation' },
        ],
      },
    ],
    autoReverse: false,
    enforceDirection: true,
    standards: ['asc.360'],
  },
  amortization: {
    kind: 'entry_type',
    id: 'je.amortization',
    entryType: 'amortization',
    label: 'Amortization entry',
    synonyms: ['intangible amortization', 'commission amortization', 'amortization je'],
    definition: 'Allocates the cost of intangibles, finance-lease ROU assets or capitalized contract costs to expense.',
    patterns: [
      {
        name: 'intangible or ROU amortization',
        strict: true,
        legs: [
          { side: 'debit', accounts: { subtypes: ['amortization_expense', 'cogs'] }, label: 'amortization expense' },
          { side: 'credit', accounts: { subtypes: ['accumulated_amortization', 'intangible_assets', 'right_of_use_asset'] }, label: 'accumulated amortization (or the asset)' },
        ],
      },
      {
        name: 'contract cost amortization',
        strict: true,
        legs: [
          { side: 'debit', accounts: EXPENSE_ACCOUNTS, label: 'an expense (e.g. commissions)' },
          { side: 'credit', accounts: { subtypes: ['deferred_contract_costs'] }, label: 'deferred contract costs' },
        ],
      },
    ],
    autoReverse: false,
    enforceDirection: true,
    standards: ['asc.350', 'asc.340-40'],
  },
  prepaid: {
    kind: 'entry_type',
    id: 'je.prepaid',
    entryType: 'prepaid',
    label: 'Prepaid amortization entry',
    synonyms: ['prepaid amortization', 'prepaid release', 'expense prepaid', 'prepaid expense entry'],
    definition: 'Expenses the portion of a prepaid consumed in the period; also used to set up a new prepaid paid in cash or on account.',
    patterns: [
      {
        name: 'amortize prepaid',
        strict: true,
        legs: [
          { side: 'debit', accounts: EXPENSE_ACCOUNTS, label: 'an expense' },
          { side: 'credit', accounts: { subtypes: ['prepaid_expenses'] }, label: 'prepaid expenses' },
        ],
      },
      {
        name: 'record prepayment',
        strict: true,
        legs: [
          { side: 'debit', accounts: { subtypes: ['prepaid_expenses'] }, label: 'prepaid expenses' },
          { side: 'credit', accounts: { subtypes: ['cash', 'accounts_payable', 'credit_card_payable'] }, label: 'cash, AP or card' },
        ],
      },
    ],
    autoReverse: false,
    enforceDirection: true,
    standards: ['asc.340-10'],
  },
  fixed_asset: {
    kind: 'entry_type',
    id: 'je.fixed_asset',
    entryType: 'fixed_asset',
    label: 'Fixed-asset entry',
    synonyms: ['capitalization', 'capitalize asset', 'asset addition', 'asset disposal', 'fixed asset addition'],
    definition: 'Capitalizes an asset purchase (including reclassing an expensed purchase) or derecognizes a disposed asset with its accumulated depreciation.',
    patterns: [
      {
        name: 'capitalize',
        strict: true,
        legs: [
          { side: 'debit', accounts: { tags: ['fixed_asset'] }, label: 'a fixed-asset account' },
          {
            side: 'credit',
            accounts: { subtypes: ['cash', 'accounts_payable', 'credit_card_payable', 'short_term_debt', 'long_term_debt', 'construction_in_progress', 'other_current_liabilities'], classes: ['expense'] },
            label: 'cash, AP, card, debt, CIP or the expense it was miscoded to',
          },
        ],
      },
      {
        name: 'dispose',
        strict: false,
        legs: [
          { side: 'debit', accounts: { subtypes: ['accumulated_depreciation'] }, label: 'accumulated depreciation' },
          { side: 'credit', accounts: { tags: ['fixed_asset'] }, label: 'the fixed-asset account (at cost)' },
        ],
      },
    ],
    autoReverse: false,
    enforceDirection: true,
    // Disposals relieve accumulated depreciation; capitalizing a miscoded purchase credits expense.
    allowAgainstNormal: { subtypes: ['accumulated_depreciation'], classes: ['expense'] },
    standards: ['asc.360'],
  },
  reclass: {
    kind: 'entry_type',
    id: 'je.reclass',
    entryType: 'reclass',
    label: 'Reclassification entry',
    synonyms: ['reclassification', 'recode', 'miscoding correction'],
    definition: 'Moves an amount between accounts to correct classification; net effect on totals is zero.',
    patterns: [],
    autoReverse: false,
    enforceDirection: false,
  },
};

// ─── Schedules ───────────────────────────────────────────────────────────────

export const SCHEDULES: ScheduleDef[] = [
  {
    kind: 'schedule',
    id: 'schedule.fixed_asset_rollforward',
    label: 'Fixed-asset roll-forward',
    synonyms: ['fixed asset register', 'fa rollforward', 'pp and e rollforward', 'asset register'],
    definition: 'Cost roll-forward of property and equipment by asset class; ending cost ties to each fixed-asset GL account.',
    rollForward: {
      opening: 'beginning cost',
      additions: ['additions (capitalized)', 'transfers in from CIP'],
      reductions: ['disposals at cost', 'impairments', 'transfers out'],
      closing: 'ending cost',
    },
    supports: { tags: ['fixed_asset'] },
    entryTypes: ['fixed_asset'],
    requiredFields: ['assetId', 'class', 'placedInService', 'costCents', 'salvageCents', 'lifeMonths', 'method'],
    standards: ['asc.360'],
  },
  {
    kind: 'schedule',
    id: 'schedule.depreciation',
    label: 'Depreciation schedule',
    synonyms: ['depreciation', 'depreciation schedule', 'accumulated depreciation rollforward'],
    definition: 'Per-asset depreciation for the period and accumulated depreciation roll-forward.',
    rollForward: {
      opening: 'beginning accumulated depreciation',
      additions: ['depreciation expense'],
      reductions: ['accumulated depreciation on disposals'],
      closing: 'ending accumulated depreciation',
    },
    supports: { subtypes: ['accumulated_depreciation', 'depreciation_expense'] },
    entryTypes: ['depreciation'],
    requiredFields: ['assetId', 'costCents', 'salvageCents', 'lifeMonths', 'method', 'openingAccumCents', 'periodCents'],
    dependsOn: ['schedule.fixed_asset_rollforward'],
    standards: ['asc.360'],
  },
  {
    kind: 'schedule',
    id: 'schedule.amortization',
    label: 'Amortization schedule',
    synonyms: ['amortization', 'intangibles rollforward', 'commission amortization schedule'],
    definition: 'Amortization of intangibles and capitalized contract costs with the accumulated amortization roll-forward.',
    rollForward: {
      opening: 'beginning balance',
      additions: ['additions (capitalized)'],
      reductions: ['amortization for the period', 'impairments / write-offs'],
      closing: 'ending balance',
    },
    supports: { subtypes: ['intangible_assets', 'accumulated_amortization', 'amortization_expense', 'deferred_contract_costs'] },
    entryTypes: ['amortization'],
    requiredFields: ['itemId', 'costCents', 'startDate', 'lifeMonths', 'openingCents', 'periodCents'],
    standards: ['asc.350', 'asc.340-40'],
  },
  {
    kind: 'schedule',
    id: 'schedule.deferred_revenue',
    label: 'Deferred revenue waterfall',
    synonyms: ['deferred revenue', 'deferred revenue schedule', 'revenue waterfall', 'unearned revenue rollforward'],
    definition: 'Contract-level billings and revenue recognized; ending balance ties to deferred revenue.',
    rollForward: {
      opening: 'beginning deferred revenue',
      additions: ['billings / cash received in advance'],
      reductions: ['revenue recognized', 'refunds and credits'],
      closing: 'ending deferred revenue',
    },
    supports: { subtypes: ['deferred_revenue'] },
    entryTypes: ['revenue_recognition'],
    requiredFields: ['contractId', 'customer', 'billedCents', 'serviceStart', 'serviceEnd', 'recognizedCents'],
    standards: ['asc.606'],
  },
  {
    kind: 'schedule',
    id: 'schedule.prepaid',
    label: 'Prepaid schedule',
    synonyms: ['prepaid', 'prepaid schedule', 'prepaid amortization schedule', 'prepaids rollforward'],
    definition: 'Prepaid items with their coverage period and monthly release to expense.',
    rollForward: {
      opening: 'beginning prepaid',
      additions: ['prepayments made'],
      reductions: ['amortized to expense'],
      closing: 'ending prepaid',
    },
    supports: { subtypes: ['prepaid_expenses'] },
    entryTypes: ['prepaid'],
    requiredFields: ['itemId', 'vendor', 'amountCents', 'coverageStart', 'coverageEnd', 'expenseAccount'],
    standards: ['asc.340-10'],
  },
  {
    kind: 'schedule',
    id: 'schedule.accrual',
    label: 'Accrual schedule',
    synonyms: ['accruals', 'accrual schedule', 'accrued expenses rollforward'],
    definition: 'Open accruals with basis and reversal date; ending balance ties to accrued liabilities.',
    rollForward: {
      opening: 'beginning accruals',
      additions: ['accruals booked'],
      reductions: ['prior accruals reversed', 'settled by invoice or payment'],
      closing: 'ending accruals',
    },
    supports: { subtypes: ['accrued_liabilities', 'payroll_liabilities'] },
    entryTypes: ['accrual', 'reversing'],
    requiredFields: ['itemId', 'vendor', 'amountCents', 'basis', 'expenseAccount', 'reversesOn'],
    standards: ['asc.450'],
  },
  {
    kind: 'schedule',
    id: 'schedule.lease',
    label: 'Lease schedule',
    synonyms: ['lease', 'lease schedule', 'asc 842 schedule', 'lease liability rollforward'],
    definition: 'Lease liability and ROU asset roll-forward per lease.',
    rollForward: {
      opening: 'beginning lease liability',
      additions: ['new leases / remeasurements', 'interest accretion'],
      reductions: ['lease payments'],
      closing: 'ending lease liability',
    },
    supports: { tags: ['lease'] },
    entryTypes: ['amortization', 'manual'],
    requiredFields: ['leaseId', 'commencement', 'termMonths', 'paymentCents', 'discountRate', 'classification'],
    standards: ['asc.842'],
  },
  {
    kind: 'schedule',
    id: 'schedule.balance_sheet_rollforward',
    label: 'Balance-sheet roll-forward',
    synonyms: ['rollforward', 'roll forward', 'account rollforward', 'balance sheet rollforward'],
    definition: 'Generic opening-activity-closing roll-forward for any balance-sheet account; closing ties to the GL.',
    rollForward: {
      opening: 'opening balance',
      additions: ['increases (normal-balance side)'],
      reductions: ['decreases'],
      closing: 'closing balance',
    },
    supports: { classes: ['asset', 'liability', 'equity'] },
    entryTypes: [],
    requiredFields: ['account', 'openingCents', 'increasesCents', 'decreasesCents', 'closingCents'],
  },
];

// ─── Reconciliations ─────────────────────────────────────────────────────────

export const RECONCILIATIONS: ReconciliationDef[] = [
  {
    kind: 'reconciliation',
    id: 'rec.bank',
    label: 'Bank reconciliation',
    synonyms: ['bank rec', 'cash reconciliation', 'reconcile bank'],
    definition: 'Matches bank-statement activity to the GL cash account and explains every difference.',
    sides: [
      { name: 'bank statement', system: 'bank', requiredFields: ['id', 'date', 'amountCents', 'description'] },
      { name: 'GL cash register', system: 'gl', requiredFields: ['id', 'date', 'amountCents', 'description', 'account'] },
    ],
    accounts: { subtypes: ['cash'] },
    matchOn: ['amount (exact)', 'date within tolerance', 'reference / check number', 'counterparty'],
    reconcilingItems: ['outstanding checks', 'deposits in transit', 'bank fees or interest not yet booked', 'errors'],
    proof: 'statement ending balance ± reconciling items = GL ending balance',
  },
  {
    kind: 'reconciliation',
    id: 'rec.credit_card',
    label: 'Credit card reconciliation',
    synonyms: ['card rec', 'credit card rec', 'reconcile credit card', 'amex rec'],
    definition: 'Matches card-statement charges, credits and payments to the GL card liability.',
    sides: [
      { name: 'card statement', system: 'card', requiredFields: ['id', 'date', 'amountCents', 'description', 'counterparty'] },
      { name: 'GL card account', system: 'gl', requiredFields: ['id', 'date', 'amountCents', 'description', 'account'] },
    ],
    accounts: { subtypes: ['credit_card_payable'] },
    matchOn: ['amount (exact)', 'date within tolerance', 'merchant'],
    reconcilingItems: ['charges posted after statement date', 'payments in transit', 'unrecorded charges or refunds'],
    proof: 'statement balance ± reconciling items = GL card balance',
  },
  {
    kind: 'reconciliation',
    id: 'rec.gl_subledger',
    label: 'GL-to-subledger tie-out',
    synonyms: ['subledger tie out', 'subledger reconciliation', 'ar aging tie out', 'ap aging tie out', 'register tie out'],
    definition: 'Ties a subledger or schedule total (AR/AP aging, fixed-asset register, inventory, payroll register) to its GL control account.',
    sides: [
      { name: 'subledger / schedule', system: 'subledger', requiredFields: ['id', 'account', 'amountCents', 'asOf'] },
      { name: 'GL control account', system: 'gl', requiredFields: ['account', 'amountCents', 'asOf'] },
    ],
    accounts: {
      tags: ['subledger_control', 'fixed_asset'],
      subtypes: ['accumulated_depreciation', 'deferred_revenue', 'prepaid_expenses', 'accrued_liabilities', 'payroll_liabilities'],
    },
    matchOn: ['account', 'as-of date', 'total'],
    reconcilingItems: ['entries posted directly to the control account', 'timing cutoff', 'unposted subledger batches'],
    proof: 'subledger total = GL control balance at the same as-of date',
  },
  {
    kind: 'reconciliation',
    id: 'rec.stripe_payout',
    label: 'Stripe payout reconciliation',
    synonyms: ['stripe rec', 'payout reconciliation', 'processor reconciliation', 'stripe payouts'],
    definition: 'Breaks each Stripe payout into charges, refunds, fees and adjustments and matches it to the bank deposit.',
    sides: [
      { name: 'Stripe payouts and balance transactions', system: 'stripe', requiredFields: ['id', 'date', 'amountCents', 'reference'] },
      { name: 'bank deposits', system: 'bank', requiredFields: ['id', 'date', 'amountCents', 'description'] },
    ],
    accounts: { subtypes: ['cash', 'bank_merchant_fees', 'accounts_receivable', 'sales_returns_allowances'] },
    matchOn: ['payout id / reference', 'amount (exact)', 'arrival date within tolerance'],
    reconcilingItems: ['payouts in transit', 'disputes and chargebacks', 'reserve holds', 'fees not yet booked'],
    proof: 'Σ(charges − refunds − fees ± adjustments) per payout = payout amount = bank deposit',
  },
];

// ─── Transaction categories (bank/card coding) ───────────────────────────────

function cat(
  id: `txn.${string}`,
  label: string,
  subtype: AccountSubtypeId,
  direction: TxnCategoryDef['direction'],
  keywords: string[],
  definition: string,
): TxnCategoryDef {
  return { kind: 'txn_category', id, label, subtype, direction, keywords, synonyms: [], definition };
}

export const TXN_CATEGORIES: TxnCategoryDef[] = [
  cat('txn.software', 'Software / SaaS', 'software_subscriptions', 'outflow', ['aws', 'amazon web services', 'google workspace', 'gsuite', 'microsoft 365', 'office 365', 'slack', 'github', 'atlassian', 'notion', 'zoom', 'dropbox', 'adobe', 'figma', 'salesforce', 'hubspot', 'openai', 'anthropic', 'vercel', 'heroku', 'digitalocean', 'twilio', 'quickbooks', 'xero', 'intuit'], 'Recurring software and hosting charges.'),
  cat('txn.advertising', 'Advertising', 'marketing_advertising', 'outflow', ['google ads', 'facebook ads', 'facebk', 'meta ads', 'meta platforms', 'linkedin ads', 'tiktok ads', 'reddit ads', 'bing ads', 'klaviyo', 'mailchimp'], 'Paid media and marketing tools.'),
  cat('txn.meals', 'Meals', 'meals_entertainment', 'outflow', ['doordash', 'uber eats', 'grubhub', 'starbucks', 'restaurant', 'cafe', 'coffee', 'sweetgreen', 'chipotle'], 'Business meals.'),
  cat('txn.travel', 'Travel', 'travel', 'outflow', ['united airlines', 'delta air', 'american airlines', 'southwest', 'jetblue', 'alaska air', 'airbnb', 'marriott', 'hilton', 'hyatt', 'expedia', 'uber', 'lyft', 'amtrak', 'hertz', 'avis', 'shell oil', 'chevron', 'exxon'], 'Airfare, lodging, ground transport and fuel.'),
  cat('txn.office', 'Office supplies', 'office_supplies', 'outflow', ['staples', 'office depot', 'officemax', 'uline'], 'Consumable office supplies.'),
  cat('txn.shipping', 'Shipping', 'shipping_freight', 'outflow', ['ups', 'fedex', 'usps', 'dhl', 'shipstation', 'shippo', 'stamps com', 'pirate ship'], 'Outbound shipping and postage.'),
  cat('txn.rent', 'Rent', 'rent_expense', 'outflow', ['rent', 'wework', 'regus', 'landlord', 'property management'], 'Rent and coworking. Under ASC 842 a lease payment may instead reduce the lease liability.'),
  cat('txn.utilities', 'Utilities and telecom', 'utilities', 'outflow', ['comcast', 'verizon', 'at and t', 't mobile', 'pg and e', 'con edison', 'spectrum', 'electric', 'water utility'], 'Utility and telecom bills.'),
  cat('txn.insurance', 'Insurance', 'insurance_expense', 'outflow', ['insurance', 'geico', 'state farm', 'progressive', 'hiscox', 'next insurance', 'the hartford', 'embroker', 'vouch'], 'Insurance premiums; annual premiums usually go to prepaid.'),
  cat('txn.professional', 'Professional services', 'professional_fees', 'outflow', ['law firm', 'llp', 'cpa', 'attorney', 'legal', 'bookkeeping', 'pilot com', 'bench accounting'], 'Legal, accounting and advisory fees.'),
  cat('txn.contractors', 'Contractors', 'contract_labor', 'outflow', ['upwork', 'fiverr', 'toptal', 'deel', 'contractor'], 'Payments to independent contractors.'),
  cat('txn.bank_fees', 'Bank and processing fees', 'bank_merchant_fees', 'outflow', ['service charge', 'monthly fee', 'wire fee', 'overdraft', 'stripe fee', 'paypal fee', 'merchant fee', 'analysis charge', 'foreign transaction fee'], 'Bank and payment-processor fees.'),
  cat('txn.interest_expense', 'Interest paid', 'interest_expense', 'outflow', ['interest charge', 'loan interest', 'finance charge', 'interest'], 'Interest on loans and card balances.'),
  // The payroll JE books the expense; the cash debit from the provider clears the liability.
  cat('txn.payroll', 'Payroll funding', 'payroll_liabilities', 'outflow', ['gusto', 'adp', 'paychex', 'rippling', 'justworks', 'trinet', 'payroll'], 'Payroll provider debits for net pay and taxes.'),
  cat('txn.sales_tax', 'Sales tax remittance', 'sales_tax_payable', 'outflow', ['sales tax', 'avalara', 'taxjar', 'cdtfa', 'department of revenue', 'comptroller'], 'Sales tax remitted to states.'),
  // "irs" alone is ambiguous (income vs payroll tax): low-confidence by design, human confirms.
  cat('txn.income_tax', 'Income tax payment', 'income_tax_payable', 'outflow', ['irs usataxpymt', 'franchise tax board', 'irs'], 'Federal and state income tax payments.'),
  cat('txn.equipment', 'Equipment purchase', 'computer_equipment', 'outflow', ['best buy', 'apple store', 'b and h photo', 'dell', 'lenovo', 'cdw'], 'Hardware purchases; capitalize at or above the capitalization threshold, else office supplies.'),
  cat('txn.transfer', 'Internal transfer', 'cash', 'either', ['transfer', 'online transfer', 'xfer', 'internal transfer', 'sweep'], 'Movement between the entity’s own accounts; not income or expense.'),
  cat('txn.card_payment', 'Credit card payment', 'credit_card_payable', 'either', ['credit card payment', 'card payment', 'amex epayment', 'autopay', 'payment thank you', 'brex payment', 'ramp payment'], 'Paying down a card balance; not an expense.'),
  cat('txn.customer_payment', 'Customer payment', 'accounts_receivable', 'inflow', ['customer payment', 'invoice payment', 'ach credit', 'remote deposit', 'mobile deposit', 'deposit'], 'Customer receipts applied to receivables.'),
  cat('txn.processor_payout', 'Processor payout', 'cash', 'inflow', ['stripe payout', 'stripe transfer', 'shopify payout', 'shopify payments', 'paypal transfer', 'square inc'], 'Payouts from payment processors; reconcile with rec.stripe_payout.'),
  cat('txn.loan_payment', 'Loan payment', 'long_term_debt', 'outflow', ['loan payment', 'loan pmt', 'sba loan', 'principal'], 'Debt principal repayment; split interest to interest expense.'),
  cat('txn.owner_draw', 'Owner draw', 'owner_distributions', 'outflow', ['owner draw', 'distribution', 'dividend payment'], 'Distributions to owners; not an expense.'),
  cat('txn.owner_contribution', 'Owner contribution', 'owners_equity', 'inflow', ['capital contribution', 'owner contribution', 'investment from owner'], 'Capital put in by owners; not revenue.'),
  cat('txn.refund_issued', 'Customer refund', 'sales_returns_allowances', 'outflow', ['refund', 'chargeback'], 'Refunds and chargebacks to customers.'),
  cat('txn.interest_income', 'Interest earned', 'interest_income', 'inflow', ['interest earned', 'interest paid', 'interest credit', 'dividend', 'interest'], 'Interest and dividends received.'),
];

// ─── Month-end close DAG ─────────────────────────────────────────────────────

function task(id: CloseTaskId, label: string, dependsOn: CloseTaskId[], uses: string[], definition: string, standards?: StandardId[]): CloseTaskDef {
  return { kind: 'close_task', id, label, dependsOn, uses, definition, synonyms: [], ...(standards ? { standards } : {}) };
}

/**
 * The month-end close as a dependency DAG. Recs and subledger tie-outs come
 * before GL review; every period-end entry posts before TB flux; nothing is
 * consolidated or reported until entries are posted and reviewed.
 */
export const CLOSE_TASKS: CloseTaskDef[] = [
  task('close.sync_sources', 'Sync ledger, bank, card and subledger data', [], [], 'Pull the GL, bank and card feeds, processor payouts and subledgers for the period.'),
  task('close.txn_coding', 'Code uncategorized bank and card transactions', ['close.sync_sources'], [], 'Categorize uncoded bank/card activity to accounts before reconciling.'),
  task('close.bank_rec', 'Bank reconciliations', ['close.txn_coding'], ['rec.bank'], 'Reconcile every bank account to the statement.'),
  task('close.card_rec', 'Credit card reconciliations', ['close.txn_coding'], ['rec.credit_card'], 'Reconcile every card account to the statement.'),
  task('close.stripe_payout_rec', 'Processor payout reconciliation', ['close.sync_sources'], ['rec.stripe_payout'], 'Tie processor payouts to bank deposits and book fees and refunds.'),
  task('close.ar_tieout', 'AR aging tie-out', ['close.sync_sources'], ['rec.gl_subledger'], 'Tie the AR aging to the receivables control account.'),
  task('close.ap_tieout', 'AP aging tie-out', ['close.sync_sources'], ['rec.gl_subledger'], 'Tie the AP aging to the payables control account and confirm invoice cutoff.'),
  task('close.payroll', 'Payroll entries', ['close.sync_sources'], ['je.payroll'], 'Record payroll from the register and tie payroll liabilities.'),
  task('close.accruals', 'Expense accruals', ['close.ap_tieout', 'close.card_rec'], ['je.accrual', 'schedule.accrual'], 'Accrue expenses incurred but not invoiced; set auto-reversal.', ['asc.450']),
  task('close.prepaids', 'Prepaid amortization', ['close.ap_tieout', 'close.card_rec'], ['je.prepaid', 'schedule.prepaid'], 'Set up new prepaids and release the period portion to expense.', ['asc.340-10']),
  task('close.fixed_assets', 'Fixed-asset additions and disposals', ['close.ap_tieout', 'close.card_rec', 'close.bank_rec'], ['je.fixed_asset', 'schedule.fixed_asset_rollforward'], 'Capitalize qualifying purchases and record disposals.', ['asc.360']),
  task('close.depreciation', 'Depreciation', ['close.fixed_assets'], ['je.depreciation', 'schedule.depreciation'], 'Compute and book period depreciation from the register.', ['asc.360']),
  task('close.amortization', 'Amortization', ['close.fixed_assets'], ['je.amortization', 'schedule.amortization'], 'Book amortization of intangibles and capitalized contract costs.', ['asc.350', 'asc.340-40']),
  task('close.revenue_recognition', 'Revenue recognition', ['close.ar_tieout', 'close.stripe_payout_rec'], ['je.revenue_recognition', 'schedule.deferred_revenue'], 'Release deferred revenue and recognize unbilled revenue per contract.', ['asc.606']),
  task('close.leases', 'Lease accounting', ['close.sync_sources'], ['schedule.lease'], 'Update lease schedules and book lease entries.', ['asc.842']),
  task('close.post_entries', 'Post approved period-end entries', ['close.payroll', 'close.accruals', 'close.prepaids', 'close.fixed_assets', 'close.depreciation', 'close.amortization', 'close.revenue_recognition', 'close.leases'], [], 'Post every approved entry to the ledger through the posting service.'),
  task('close.schedule_tieouts', 'Schedule-to-GL tie-outs', ['close.post_entries'], ['rec.gl_subledger', 'schedule.balance_sheet_rollforward'], 'Tie every roll-forward schedule to its GL balance after entries post.'),
  task('close.gl_review', 'GL review', ['close.bank_rec', 'close.card_rec', 'close.stripe_payout_rec', 'close.ar_tieout', 'close.ap_tieout'], [], 'Review the GL for miscoding, suspense balances and unusual entries.'),
  task('close.tb_flux', 'Trial balance flux analysis', ['close.gl_review', 'close.post_entries', 'close.schedule_tieouts'], [], 'Explain period-over-period movements above threshold.'),
  task('close.subsequent_events', 'Subsequent events review', ['close.tb_flux'], [], 'Review events after period end for recognition or disclosure.', ['asc.855']),
  task('close.consolidation', 'Consolidation and eliminations', ['close.tb_flux', 'close.post_entries'], [], 'Consolidate entities and eliminate intercompany balances.'),
  task('close.financial_statements', 'Financial statements and reporting package', ['close.consolidation', 'close.subsequent_events'], [], 'Produce statements and the management reporting package.'),
  task('close.lock_period', 'Lock the period', ['close.financial_statements'], [], 'Close the period in the ledger so nothing posts to it.'),
];

// ─── Skills → concepts (for contextFor) ──────────────────────────────────────

/** Which concepts a skill needs in its prompt. Unknown skills fall back to lookup. */
export const SKILL_CONCEPTS: Record<string, string[]> = {
  bank_reconciliation: ['rec.bank', 'cash', 'bank_merchant_fees', 'interest_income'],
  card_reconciliation: ['rec.credit_card', 'credit_card_payable'],
  stripe_reconciliation: ['rec.stripe_payout', 'cash', 'bank_merchant_fees', 'sales_returns_allowances'],
  gl_subledger_tieout: ['rec.gl_subledger', 'accounts_receivable', 'accounts_payable'],
  transaction_coding: ['txn.software', 'txn.transfer', 'txn.card_payment', 'txn.owner_draw', 'txn.equipment', 'other_operating_expense'],
  accruals: ['je.accrual', 'je.reversing', 'schedule.accrual', 'accrued_liabilities', 'asc.450'],
  prepaid_amortization: ['je.prepaid', 'schedule.prepaid', 'prepaid_expenses'],
  fixed_assets: ['je.fixed_asset', 'schedule.fixed_asset_rollforward', 'accumulated_depreciation', 'asc.360'],
  depreciation: ['je.depreciation', 'schedule.depreciation', 'depreciation_expense', 'accumulated_depreciation'],
  amortization: ['je.amortization', 'schedule.amortization', 'amortization_expense', 'accumulated_amortization'],
  revenue_recognition: ['je.revenue_recognition', 'schedule.deferred_revenue', 'deferred_revenue', 'revenue', 'asc.606'],
  payroll: ['je.payroll', 'payroll_expense', 'payroll_tax_expense', 'payroll_liabilities'],
  leases: ['schedule.lease', 'right_of_use_asset', 'lease_liability', 'asc.842'],
  flux_analysis: ['close.tb_flux', 'schedule.balance_sheet_rollforward'],
  month_end_close: ['close.gl_review', 'close.tb_flux', 'close.post_entries'],
  journal_entry: ['je.manual', 'je.reclass'],
};

// ─── Provider mappings ───────────────────────────────────────────────────────

/** A provider account *type*: fixes the class and a fallback subtype; `refine` lets the account name narrow it. */
export interface ProviderTypeMapping {
  class: AccountClass;
  fallback: AccountSubtypeId;
  /** Accounts the name may refine to. Absent = none (the type is already specific). */
  refineWithin?: AccountSelector;
}

const WITHIN = (cls: AccountClass): AccountSelector => ({ classes: [cls] });
const FIXED_REFINE: AccountSelector = { tags: ['fixed_asset', 'intangible'], subtypes: ['accumulated_depreciation', 'accumulated_amortization'] };

/** QuickBooks Online `Account.AccountType` (API string values). Keys are matched case/space-insensitively. */
export const QBO_ACCOUNT_TYPES: Record<string, ProviderTypeMapping> = {
  Bank: { class: 'asset', fallback: 'cash' },
  'Accounts Receivable': { class: 'asset', fallback: 'accounts_receivable' },
  'Other Current Asset': { class: 'asset', fallback: 'other_current_assets', refineWithin: WITHIN('asset') },
  'Fixed Asset': { class: 'asset', fallback: 'other_fixed_assets', refineWithin: FIXED_REFINE },
  'Other Asset': { class: 'asset', fallback: 'other_assets', refineWithin: WITHIN('asset') },
  'Accounts Payable': { class: 'liability', fallback: 'accounts_payable' },
  'Credit Card': { class: 'liability', fallback: 'credit_card_payable' },
  'Other Current Liability': { class: 'liability', fallback: 'other_current_liabilities', refineWithin: WITHIN('liability') },
  'Long Term Liability': { class: 'liability', fallback: 'other_long_term_liabilities', refineWithin: WITHIN('liability') },
  Equity: { class: 'equity', fallback: 'owners_equity', refineWithin: WITHIN('equity') },
  Income: { class: 'revenue', fallback: 'revenue', refineWithin: WITHIN('revenue') },
  'Cost of Goods Sold': { class: 'expense', fallback: 'cogs' },
  Expense: { class: 'expense', fallback: 'other_operating_expense', refineWithin: WITHIN('expense') },
  'Other Income': { class: 'revenue', fallback: 'other_income', refineWithin: WITHIN('revenue') },
  'Other Expense': { class: 'expense', fallback: 'other_expense', refineWithin: WITHIN('expense') },
};

/** [subtype, generic]. Generic subtypes let the account name refine within the same class. */
export type ProviderSubtypeMapping = readonly [AccountSubtypeId, boolean?];

/** QuickBooks Online `Account.AccountSubType` enum values. Keys are matched case/punctuation-insensitively. */
export const QBO_ACCOUNT_SUBTYPES: Record<string, ProviderSubtypeMapping> = {
  // Bank
  CashOnHand: ['cash'],
  Checking: ['cash'],
  MoneyMarket: ['cash'],
  RentsHeldInTrust: ['cash'], // restricted cash held for tenants
  Savings: ['cash'],
  TrustAccounts: ['cash'],
  CashAndCashEquivalents: ['cash'], // unsure: appears in newer / non-US company files
  OtherEarMarkedBankAccounts: ['cash'], // unsure: non-US locales
  // Accounts Receivable
  AccountsReceivable: ['accounts_receivable'],
  // Other Current Asset
  AllowanceForBadDebts: ['allowance_for_doubtful_accounts'],
  DevelopmentCosts: ['other_current_assets', true],
  EmployeeCashAdvances: ['other_receivables'],
  OtherCurrentAssets: ['other_current_assets', true],
  Inventory: ['inventory'],
  Investment_MortgageRealEstateLoans: ['other_current_assets'],
  Investment_Other: ['other_current_assets'],
  Investment_TaxExemptSecurities: ['other_current_assets'],
  Investment_USGovernmentObligations: ['other_current_assets'],
  LoansToOfficers: ['other_receivables'],
  LoansToOthers: ['other_receivables'],
  LoansToStockholders: ['other_receivables'],
  PrepaidExpenses: ['prepaid_expenses'],
  Retainage: ['accounts_receivable'], // retainage receivable on construction contracts
  UndepositedFunds: ['cash'], // clearing for receipts not yet deposited; presented within cash
  // Fixed Asset
  AccumulatedDepletion: ['accumulated_depreciation'],
  AccumulatedDepreciation: ['accumulated_depreciation'],
  DepletableAssets: ['other_fixed_assets'],
  FixedAssetComputers: ['computer_equipment'],
  FixedAssetCopiers: ['machinery_equipment'],
  FixedAssetFurniture: ['furniture_fixtures'],
  FixedAssetPhone: ['computer_equipment'],
  FixedAssetPhotoVideo: ['machinery_equipment'],
  FixedAssetSoftware: ['intangible_assets'], // capitalized software is intangible under ASC 350-40
  FixedAssetOtherToolsEquipment: ['machinery_equipment'],
  FurnitureAndFixtures: ['furniture_fixtures'],
  Land: ['land'],
  LeaseholdImprovements: ['leasehold_improvements'],
  OtherFixedAssets: ['other_fixed_assets', true],
  AccumulatedAmortization: ['accumulated_amortization'],
  Buildings: ['buildings'],
  IntangibleAssets: ['intangible_assets'],
  MachineryAndEquipment: ['machinery_equipment'],
  Vehicles: ['vehicles'],
  AssetsInCourseOfConstruction: ['construction_in_progress'], // unsure: non-US locales
  // Other Asset
  LeaseBuy: ['other_assets'],
  OtherLongTermAssets: ['other_assets', true],
  SecurityDeposits: ['other_assets'],
  AccumulatedAmortizationOfOtherAssets: ['accumulated_amortization'],
  Goodwill: ['goodwill'],
  Licenses: ['intangible_assets'],
  OrganizationalCosts: ['intangible_assets'], // flag: start-up costs are generally expensed under ASC 720-15
  AssetsAvailableForSale: ['other_assets'], // unsure
  DeferredTax: ['other_assets'], // unsure
  Investments: ['other_assets'], // unsure
  // Accounts Payable / Credit Card
  AccountsPayable: ['accounts_payable'],
  CreditCard: ['credit_card_payable'],
  // Other Current Liability
  DirectDepositPayable: ['payroll_liabilities'],
  LineOfCredit: ['short_term_debt'],
  LoanPayable: ['short_term_debt'],
  GlobalTaxPayable: ['sales_tax_payable'], // VAT/GST in non-US files
  GlobalTaxSuspense: ['sales_tax_payable'],
  OtherCurrentLiabilities: ['other_current_liabilities', true],
  PayrollClearing: ['payroll_liabilities'],
  PayrollTaxPayable: ['payroll_liabilities'],
  PrepaidExpensesPayable: ['other_current_liabilities'],
  RentsInTrustLiability: ['other_current_liabilities'],
  TrustAccountsLiabilities: ['other_current_liabilities'],
  FederalIncomeTaxPayable: ['income_tax_payable'],
  InsurancePayable: ['accrued_liabilities'],
  SalesTaxPayable: ['sales_tax_payable'],
  StateLocalIncomeTaxPayable: ['income_tax_payable'],
  AccruedLiabilities: ['accrued_liabilities'], // unsure: newer subtype
  CurrentTaxLiability: ['income_tax_payable'], // unsure
  DeferredRevenue: ['deferred_revenue'], // unsure: not in every locale
  // Long Term Liability
  NotesPayable: ['long_term_debt'],
  OtherLongTermLiabilities: ['other_long_term_liabilities', true],
  ShareholderNotesPayable: ['long_term_debt'],
  AccruedNonCurrentLiabilities: ['other_long_term_liabilities'], // unsure
  LongTermBorrowings: ['long_term_debt'], // unsure
  ObligationsUnderFinanceLeases: ['lease_liability'], // unsure
  // Equity
  OpeningBalanceEquity: ['opening_balance_equity'],
  PartnersEquity: ['owners_equity', true],
  RetainedEarnings: ['retained_earnings'],
  AccumulatedAdjustment: ['retained_earnings'], // S-corp AAA
  OwnersEquity: ['owners_equity', true],
  PaidInCapitalOrSurplus: ['owners_equity'],
  PartnerContributions: ['owners_equity'],
  PartnerDistributions: ['owner_distributions'],
  PreferredStock: ['owners_equity'],
  CommonStock: ['owners_equity'],
  TreasuryStock: ['treasury_stock'],
  // Sole-prop subtypes: personal items paid from the business are draws.
  EstimatedTaxes: ['owner_distributions'],
  Healthcare: ['owner_distributions'],
  PersonalIncome: ['owners_equity'],
  PersonalExpense: ['owner_distributions'],
  // Income
  NonProfitIncome: ['revenue'],
  OtherPrimaryIncome: ['revenue', true],
  SalesOfProductIncome: ['revenue'],
  ServiceFeeIncome: ['revenue'],
  DiscountsRefundsGiven: ['sales_returns_allowances'],
  UnappliedCashPaymentIncome: ['revenue'], // QBO system account; balance usually needs review
  CashReceiptIncome: ['revenue'], // unsure
  OperatingGrants: ['other_income'], // unsure
  // Cost of Goods Sold
  EquipmentRentalCos: ['cogs'],
  OtherCostsOfServiceCos: ['cogs'],
  ShippingFreightDeliveryCos: ['cogs'],
  SuppliesMaterialsCogs: ['cogs'],
  CostOfLaborCos: ['cogs'],
  // Expense
  AdvertisingPromotional: ['marketing_advertising'],
  BadDebts: ['bad_debt_expense'],
  BankCharges: ['bank_merchant_fees'],
  CharitableContributions: ['other_expense'],
  CommissionsAndFees: ['other_operating_expense', true],
  Entertainment: ['meals_entertainment'],
  EntertainmentMeals: ['meals_entertainment'],
  EquipmentRental: ['rent_expense'],
  FinanceCosts: ['interest_expense'],
  GlobalTaxExpense: ['taxes_licenses'],
  Insurance: ['insurance_expense'],
  InterestPaid: ['interest_expense'],
  LegalProfessionalFees: ['professional_fees'],
  OfficeExpenses: ['office_supplies'],
  OfficeGeneralAdministrativeExpenses: ['other_operating_expense', true],
  OtherBusinessExpenses: ['other_operating_expense', true],
  OtherMiscellaneousServiceCost: ['other_operating_expense', true],
  PromotionalMeals: ['meals_entertainment'],
  RentOrLeaseOfBuildings: ['rent_expense'],
  RepairMaintenance: ['repairs_maintenance'],
  ShippingFreightDelivery: ['shipping_freight'],
  SuppliesMaterials: ['office_supplies'],
  Travel: ['travel'],
  TravelMeals: ['meals_entertainment'],
  Utilities: ['utilities'],
  Auto: ['travel'],
  CostOfLabor: ['payroll_expense'],
  DuesSubscriptions: ['software_subscriptions'],
  PayrollExpenses: ['payroll_expense'],
  TaxesPaid: ['taxes_licenses'],
  UnappliedCashBillPaymentExpense: ['other_operating_expense'],
  Communications: ['utilities'], // unsure
  // Other Income
  DividendIncome: ['interest_income'],
  InterestEarned: ['interest_income'],
  OtherInvestmentIncome: ['other_income'],
  OtherMiscellaneousIncome: ['other_income', true],
  TaxExemptInterest: ['interest_income'],
  GainLossOnSaleOfFixedAssets: ['other_income'], // unsure
  GainLossOnSaleOfInvestments: ['other_income'], // unsure
  // Other Expense
  Depreciation: ['depreciation_expense'],
  ExchangeGainOrLoss: ['other_expense'],
  OtherMiscellaneousExpense: ['other_expense', true],
  PenaltiesSettlements: ['other_expense'],
  Amortization: ['amortization_expense'],
  GasAndFuel: ['travel'],
  HomeOffice: ['rent_expense'],
  HomeOwnerRentalInsurance: ['insurance_expense'],
  OtherHomeOfficeExpenses: ['other_operating_expense'],
  MortgageInterest: ['interest_expense'],
  RentAndLease: ['rent_expense'],
  RepairsAndMaintenance: ['repairs_maintenance'],
  ParkingAndTolls: ['travel'],
  Vehicle: ['travel'],
  VehicleInsurance: ['insurance_expense'],
  VehicleLease: ['rent_expense'],
  VehicleLoanInterest: ['interest_expense'],
  VehicleLoan: ['other_expense'], // QBO Self-Employed subtype; principal is not an expense, review
  VehicleRegistration: ['taxes_licenses'],
  VehicleRepairs: ['repairs_maintenance'],
  OtherVehicleExpenses: ['travel'],
  WashAndRoadServices: ['travel'],
  IncomeTaxExpense: ['income_tax_expense'], // unsure
};

/** Xero `Account.Type` enum values. */
export const XERO_ACCOUNT_TYPES: Record<string, ProviderTypeMapping> = {
  BANK: { class: 'asset', fallback: 'cash' },
  CURRENT: { class: 'asset', fallback: 'other_current_assets', refineWithin: WITHIN('asset') },
  CURRLIAB: { class: 'liability', fallback: 'other_current_liabilities', refineWithin: WITHIN('liability') },
  // Xero's DEPRECIATN is the depreciation *expense* type; accumulated depreciation lives under FIXED.
  DEPRECIATN: { class: 'expense', fallback: 'depreciation_expense', refineWithin: { subtypes: ['amortization_expense'] } },
  DIRECTCOSTS: { class: 'expense', fallback: 'cogs' },
  EQUITY: { class: 'equity', fallback: 'owners_equity', refineWithin: WITHIN('equity') },
  EXPENSE: { class: 'expense', fallback: 'other_operating_expense', refineWithin: WITHIN('expense') },
  FIXED: { class: 'asset', fallback: 'other_fixed_assets', refineWithin: FIXED_REFINE },
  INVENTORY: { class: 'asset', fallback: 'inventory' },
  LIABILITY: { class: 'liability', fallback: 'other_current_liabilities', refineWithin: WITHIN('liability') },
  NONCURRENT: { class: 'asset', fallback: 'other_assets', refineWithin: WITHIN('asset') },
  OTHERINCOME: { class: 'revenue', fallback: 'other_income', refineWithin: WITHIN('revenue') },
  OVERHEADS: { class: 'expense', fallback: 'other_operating_expense', refineWithin: WITHIN('expense') },
  PREPAYMENT: { class: 'asset', fallback: 'prepaid_expenses' },
  REVENUE: { class: 'revenue', fallback: 'revenue', refineWithin: WITHIN('revenue') },
  SALES: { class: 'revenue', fallback: 'revenue', refineWithin: WITHIN('revenue') },
  TERMLIAB: { class: 'liability', fallback: 'other_long_term_liabilities', refineWithin: WITHIN('liability') },
  // Payroll types used by Xero AU/NZ payroll.
  PAYGLIABILITY: { class: 'liability', fallback: 'payroll_liabilities' },
  SUPERANNUATIONEXPENSE: { class: 'expense', fallback: 'employee_benefits' },
  SUPERANNUATIONLIABILITY: { class: 'liability', fallback: 'payroll_liabilities' },
  WAGESEXPENSE: { class: 'expense', fallback: 'payroll_expense' },
};

/** Xero `Account.Class` enum values; used when only the class is known. */
export const XERO_ACCOUNT_CLASSES: Record<string, ProviderTypeMapping> = {
  ASSET: { class: 'asset', fallback: 'other_current_assets', refineWithin: WITHIN('asset') },
  EQUITY: { class: 'equity', fallback: 'owners_equity', refineWithin: WITHIN('equity') },
  EXPENSE: { class: 'expense', fallback: 'other_operating_expense', refineWithin: WITHIN('expense') },
  LIABILITY: { class: 'liability', fallback: 'other_current_liabilities', refineWithin: WITHIN('liability') },
  REVENUE: { class: 'revenue', fallback: 'revenue', refineWithin: WITHIN('revenue') },
};

/** Xero `Account.SystemAccount` values that pin the subtype outright. */
export const XERO_SYSTEM_ACCOUNTS: Record<string, AccountSubtypeId> = {
  DEBTORS: 'accounts_receivable',
  CREDITORS: 'accounts_payable',
  GST: 'sales_tax_payable',
  GSTONIMPORTS: 'sales_tax_payable',
  RETAINEDEARNINGS: 'retained_earnings',
  WAGEPAYABLES: 'payroll_liabilities',
  UNPAIDEXPCLM: 'accrued_liabilities', // unpaid expense claims owed to staff
  HISTORICAL: 'opening_balance_equity', // conversion balance adjustments
  ROUNDING: 'other_expense',
  BANKCURRENCYGAIN: 'other_expense',
  REALISEDCURRENCYGAIN: 'other_expense',
  UNREALISEDCURRENCYGAIN: 'other_expense',
};

// ─── Name heuristics ─────────────────────────────────────────────────────────

/**
 * Ordered rules over the normalized account name; the first match wins.
 * Order encodes precedence: contra and specific phrases before the generic
 * words they contain ("Accumulated depreciation – vehicles" is not a vehicle).
 */
export interface NameRule {
  pattern: RegExp;
  subtype: AccountSubtypeId;
  /** Skip the rule when this also matches, e.g. "vehicle expense" is not a vehicle. */
  unless?: RegExp;
  /** Generic words only; lower confidence. */
  weak?: boolean;
}

// Words that turn an asset noun into an expense line ("computer repairs", "equipment rental").
const EXPENSE_CONTEXT =
  /\b(expenses?|costs?|fees|repairs?|maintenance|rental|rentals|rent|lease|leasing|supplies|small|fuel|gas|insurance|registration|internet|depreciation|loss|gain|sale|disposal)\b/;

export const NAME_RULES: NameRule[] = [
  { pattern: /\baccum(ulated)?\s+(depr|depreciation|depn)\b/, subtype: 'accumulated_depreciation' },
  { pattern: /\baccum(ulated)?\s+(amort|amortization|amortisation)\b/, subtype: 'accumulated_amortization' },
  { pattern: /\b(allowance|reserve)\b.*\b(doubtful|bad debts?|credit loss(es)?|uncollectible)\b|\b(doubtful accounts|bad debts?) (allowance|reserve)\b/, subtype: 'allowance_for_doubtful_accounts' },
  { pattern: /\bbad debts?\b|\bcredit loss(es)?\b|\bprovision for doubtful\b/, subtype: 'bad_debt_expense' },
  { pattern: /\bdepreciation\b|\bdepr\b/, subtype: 'depreciation_expense' },
  { pattern: /\bamortization\b|\bamortisation\b/, subtype: 'amortization_expense' },
  { pattern: /\b(gains?) on\b|\bother income\b|\bmisc(ellaneous)? income\b|\bgrant (income|revenue)\b|\bnon ?operating income\b|\b(debt|ppp) forgiveness\b/, subtype: 'other_income' },
  { pattern: /\b(loss|losses) on\b|\b(exchange|currency|fx|foreign exchange) (gains?|loss(es)?)\b|\bpenalt(y|ies)\b|\bfines\b|\bcharitable\b|\bdonations?\b/, subtype: 'other_expense' },
  // Payroll before generic accruals and taxes: "accrued wages" is a payroll liability.
  { pattern: /\b(payroll|wages?|salar(y|ies)|compensation|bonus(es)?|commissions?|vacation|pto|401 ?k|benefits?) (payable|liabilit(y|ies)|clearing|withheld)\b|\baccrued (payroll|wages|salar(y|ies)|vacation|pto|bonus(es)?|commissions?|compensation)\b|\bpayroll tax(es)? payable\b|\bwithholdings?\b|\bdirect deposit payable\b|\bgarnishments?\b|\b(fica|futa|suta|sui|medicare|social security) payable\b/, subtype: 'payroll_liabilities' },
  { pattern: /\bpayroll tax(es)?\b|\bemployer tax(es)?\b|\b(fica|futa|suta|sui)\b|\bmedicare\b|\bsocial security\b/, subtype: 'payroll_tax_expense' },
  { pattern: /\bsales (and use )?tax(es)?\b|\buse tax\b|\bgst\b|\bhst\b|\bvat\b/, subtype: 'sales_tax_payable' },
  { pattern: /\bincome tax(es)? payable\b|\b(federal|state) (income )?tax(es)? payable\b|\btaxes payable\b/, subtype: 'income_tax_payable' },
  { pattern: /\bincome tax(es)?\b|\bprovision for (income )?taxes\b|\bdeferred tax(es)? expense\b/, subtype: 'income_tax_expense' },
  { pattern: /\binterest (income|earned|revenue)\b|\bdividend income\b|\bdividends earned\b/, subtype: 'interest_income' },
  { pattern: /\b(commission|consulting|service|services|subscription|product|licens(e|ing)|royalty|royalties|saas|contract) (income|revenue|sales)\b/, subtype: 'revenue' },
  { pattern: /\bdeferred (revenue|income|sales)\b|\bunearned\b|\bcontract liabilit(y|ies)\b|\bcustomer (deposits?|prepayments?|advances?)\b|\bgift cards? (liability|outstanding)\b/, subtype: 'deferred_revenue' },
  { pattern: /\b(deferred|capitali[sz]ed|prepaid) (commissions?|contract costs?)\b|\bcosts? to obtain (a )?contracts?\b|\bcontract (acquisition )?costs\b/, subtype: 'deferred_contract_costs' },
  { pattern: /\bprepaid\b|\bprepayments?\b|\bprepaids\b|\bdeferred (expenses?|charges)\b/, subtype: 'prepaid_expenses' },
  { pattern: /\bright of use\b|\brou\b/, subtype: 'right_of_use_asset' },
  { pattern: /\blease (liabilit(y|ies)|obligations?|payable)\b/, subtype: 'lease_liability' },
  { pattern: /\b(bank|merchant|processing|credit card|card|stripe|paypal|square|wire|transaction) (fees|charges|service charges?)\b|\bbank service charges?\b|\bmerchant (account|services)\b/, subtype: 'bank_merchant_fees' },
  { pattern: /\b(other|employee|officer|officers|shareholder|stockholder|related party|intercompany|interest|tax|refunds?) (receivables?|advances?)\b|\bemployee advances?\b|\bloans? (to|receivable)\b|\bnotes? receivable\b|\bdue from\b/, subtype: 'other_receivables' },
  { pattern: /\baccounts? receivable\b|\ba\/r\b|\bar\b|\btrade (receivables?|debtors)\b|\bdebtors\b|\bunbilled\b|\baccrued (revenue|income)\b|\bcontract assets?\b|\bretainage\b|\breceivables?\b/, subtype: 'accounts_receivable' },
  { pattern: /\baccounts? payable\b|\ba\/p\b|\bap\b|\btrade (payables?|creditors)\b|\bcreditors\b|\bvendor payables?\b/, subtype: 'accounts_payable' },
  { pattern: /\baccrued\b|\baccruals?\b/, subtype: 'accrued_liabilities' },
  { pattern: /\binterest\b|\bfinance charges?\b/, subtype: 'interest_expense' },
  { pattern: /\bcredit cards?\b|\bcharge cards?\b|\bcorporate cards?\b|\b(amex|american express|visa|mastercard|brex|ramp|divvy)\b/, subtype: 'credit_card_payable' },
  { pattern: /\blines? of credit\b|\bloc\b|\brevolv(er|ing)\b|\bshort term (debt|loans?|notes?|borrowings?)\b|\bcurrent (portion|maturities)\b/, subtype: 'short_term_debt' },
  { pattern: /\bother (long term|non ?current) liabilit(y|ies)\b|\blong term liabilit(y|ies)\b/, subtype: 'other_long_term_liabilities' },
  { pattern: /\b(notes?|loans?|mortgages?|debt|borrowings?|bonds?) payable\b|\bterm loans?\b|\bmortgage\b|\b(sba|ppp|eidl|bank|shareholder|officer|member) loans?\b|\bconvertible notes?\b|\blong term (debt|loans?|notes?)\b|\bloans?\b|\bdebt\b/, subtype: 'long_term_debt' },
  { pattern: /\bcash\b|\bchecking\b|\bchequing\b|\bsavings\b|\bmoney market\b|\bundeposited funds\b|\bbank\b|\boperating (account|acct)\b|\bsweep\b|\bpaypal\b|\bstripe\b/, subtype: 'cash' },
  { pattern: /\binventory (shrink(age)?|adjustments?|write ?(offs?|downs?)|variance)\b|\bcost of (goods|sales|revenue|services)\b|\bcogs\b|\bcos\b|\bdirect (costs?|labor|materials)\b|\bfreight in\b|\bpurchases\b/, subtype: 'cogs' },
  { pattern: /\binventory\b|\bstock on hand\b|\braw materials\b|\bfinished goods\b|\bwork in (progress|process)\b|\bwip\b|\bmerchandise\b/, subtype: 'inventory' },
  { pattern: /\bconstruction in (progress|process)\b|\bcip\b|\bassets? under construction\b/, subtype: 'construction_in_progress' },
  { pattern: /\bgoodwill\b/, subtype: 'goodwill' },
  { pattern: /\bintangibles?\b|\bpatents?\b|\btrademarks?\b|\bcopyrights?\b|\bcapitali[sz]ed (software|development)\b|\binternal use software\b|\bcustomer (lists?|relationships)\b|\bdomain names?\b|\bintellectual property\b/, subtype: 'intangible_assets', unless: EXPENSE_CONTEXT },
  { pattern: /\bfixed assets?\b|\bproperty (plant )?and equipment\b|\bpp and e\b|\bppe\b/, subtype: 'other_fixed_assets', unless: EXPENSE_CONTEXT },
  { pattern: /\bleasehold improvements?\b|\btenant improvements?\b/, subtype: 'leasehold_improvements', unless: EXPENSE_CONTEXT },
  { pattern: /\bland\b/, subtype: 'land', unless: EXPENSE_CONTEXT },
  { pattern: /\bbuildings?\b/, subtype: 'buildings', unless: EXPENSE_CONTEXT },
  { pattern: /\bfurniture\b|\bfixtures\b|\bfurnishings\b/, subtype: 'furniture_fixtures', unless: EXPENSE_CONTEXT },
  { pattern: /\bcomputers?\b|\blaptops?\b|\bservers?\b|\bit equipment\b|\bhardware\b/, subtype: 'computer_equipment', unless: EXPENSE_CONTEXT },
  { pattern: /\bvehicles?\b|\btrucks?\b|\bautos?\b|\bautomobiles?\b|\bvans?\b|\bcars?\b|\btrailers?\b|\bforklifts?\b/, subtype: 'vehicles', unless: EXPENSE_CONTEXT },
  { pattern: /\bmachinery\b|\bequipment\b|\bmachines?\b|\btools\b/, subtype: 'machinery_equipment', unless: EXPENSE_CONTEXT },
  { pattern: /\b(security|rent|rental|utility|lease) deposits?\b|\bdeposits? (paid|asset)\b|\bother (non ?current|long term) assets?\b|\bother assets\b|\blong term investments?\b|\binvestments?\b|\bdeferred tax assets?\b/, subtype: 'other_assets' },
  { pattern: /\bother current assets?\b/, subtype: 'other_current_assets' },
  { pattern: /\bopening bal(ance)?\b/, subtype: 'opening_balance_equity' },
  { pattern: /\bretained earnings\b|\baccumulated (deficit|earnings)\b|\baccumulated adjustments?\b|\bprior year earnings\b/, subtype: 'retained_earnings' },
  { pattern: /\btreasury (stock|shares)\b/, subtype: 'treasury_stock' },
  { pattern: /\b(owners?|partners?|members?|shareholders?|stockholders?) (draws?|drawings?|distributions?)\b|\bdistributions?\b|\bdividends?\b|\bdrawings?\b|\bdraws?\b/, subtype: 'owner_distributions' },
  { pattern: /\b(common|preferred|capital) stock\b|\bpaid in capital\b|\bapic\b|\bcontributed capital\b|\b(owners?|partners?|members?|shareholders?|stockholders?) (equity|capital|contributions?|investments?)\b|\bcapital contributions?\b/, subtype: 'owners_equity' },
  { pattern: /\bequity\b|\bcapital\b/, subtype: 'owners_equity', weak: true },
  { pattern: /\bother current liabilit(y|ies)\b|\bdue to\b/, subtype: 'other_current_liabilities' },
  { pattern: /\bpayables?\b|\bliabilit(y|ies)\b/, subtype: 'other_current_liabilities', weak: true },
  { pattern: /\b(sales )?returns\b|\bsales (discounts?|allowances)\b|\bdiscounts (given|allowed)\b|\brefunds\b|\bchargebacks?\b/, subtype: 'sales_returns_allowances' },
  { pattern: /\bbenefits?\b|\bhealth (insurance|care|plan)\b|\bmedical\b|\bdental\b|\bvision\b|\b401 ?k\b|\bretirement\b|\bworkers comp(ensation)?\b|\bsuperannuation\b|\bpension\b/, subtype: 'employee_benefits' },
  { pattern: /\bwages\b|\bsalar(y|ies)\b|\bpayroll\b|\bgross pay\b|\bbonus(es)?\b|\bcommissions?\b|\bcompensation\b/, subtype: 'payroll_expense' },
  { pattern: /\bcontract (labor|labour|services|workers?)\b|\bcontractors?\b|\bsubcontract(ors?|ing)?\b|\b1099\b|\bfreelanc(e|ers?)\b|\boutsourc(ed|ing)\b/, subtype: 'contract_labor' },
  { pattern: /\b(legal|accounting|audit|bookkeeping|consulting|professional|advisory)\b|\btax prep(aration)?\b/, subtype: 'professional_fees' },
  { pattern: /\badvertis(ing|ement)?\b|\bmarketing\b|\bpromotion(al|s)?\b|\bsponsorships?\b|\blead generation\b/, subtype: 'marketing_advertising' },
  { pattern: /\bmeals?\b|\bentertainment\b|\bdining\b|\bfood\b/, subtype: 'meals_entertainment' },
  // Before travel so "auto insurance" is insurance, after benefits so "health insurance" is a benefit.
  { pattern: /\binsurance\b/, subtype: 'insurance_expense' },
  { pattern: /\btravel\b|\bairfare\b|\bflights?\b|\blodging\b|\bhotels?\b|\bmileage\b|\bauto\b|\bvehicles?\b|\bcars?\b|\bfuel\b|\bgas and oil\b|\bparking\b|\btolls\b|\btransportation\b/, subtype: 'travel' },
  { pattern: /\brent\b|\brental\b|\blease (expense|cost)\b|\boccupancy\b|\bcoworking\b|\boffice space\b/, subtype: 'rent_expense' },
  { pattern: /\bsoftware\b|\bsaas\b|\bsubscriptions?\b|\bhosting\b|\bcloud\b|\bweb services\b|\bdues\b|\bcomputer and internet\b|\bit (services|expenses?)\b/, subtype: 'software_subscriptions' },
  { pattern: /\butilit(y|ies)\b|\belectric(ity)?\b|\bwater\b|\btelephone\b|\bphones?\b|\binternet\b|\btelecom(munications)?\b|\bmobile\b|\bcell(ular)?\b/, subtype: 'utilities' },
  { pattern: /\bshipping\b|\bfreight\b|\bpostage\b|\bdelivery\b|\bcouriers?\b|\bfulfill?ment\b/, subtype: 'shipping_freight' },
  { pattern: /\boffice (supplies|expenses?)\b|\bsupplies\b|\bprinting\b|\bstationery\b|\bsmall (tools|equipment)\b/, subtype: 'office_supplies' },
  { pattern: /\brepairs?\b|\bmaintenance\b|\bjanitorial\b|\bcleaning\b/, subtype: 'repairs_maintenance' },
  { pattern: /\btax(es)?\b|\blicenses?\b|\bpermits?\b|\bregistration\b/, subtype: 'taxes_licenses' },
  { pattern: /\brevenue\b|\bsales\b|\bincome\b|\bfees earned\b|\bturnover\b/, subtype: 'revenue', weak: true },
  { pattern: /\bexpenses?\b|\bgeneral and administrative\b|\bg and a\b|\bmisc(ellaneous)?\b|\boverhead\b|\btraining\b|\beducation\b/, subtype: 'other_operating_expense', weak: true },
];

/** Names that signal a suspense/clearing account: classified, but flagged for review. */
export const SUSPENSE_NAME = /\buncategori[sz]ed\b|\bsuspense\b|\bask my accountant\b|\bclearing\b/;

/**
 * Capability-catalog skill ids (lib/graph/catalog.ts) → the concept groups above.
 * Document and reuse skills are format-level, not accounting concepts, so they map
 * to nothing on purpose.
 */
export const CATALOG_SKILL_ALIASES: Record<string, keyof typeof SKILL_CONCEPTS | null> = {
  'code-bank-transactions': 'transaction_coding',
  'categorize-expenses': 'transaction_coding',
  'detect-unmatched': 'bank_reconciliation',
  'exclude-invalid-transactions': 'transaction_coding',
  'sync-approved-transactions': 'transaction_coding',
  'bank-reconciliation': 'bank_reconciliation',
  'credit-card-reconciliation': 'card_reconciliation',
  'gl-reconciliation': 'gl_subledger_tieout',
  'stripe-reconciliation': 'stripe_reconciliation',
  'flag-exceptions': 'bank_reconciliation',
  'manual-je': 'journal_entry',
  'accrual-je': 'accruals',
  'reversing-je': 'accruals',
  'payroll-je': 'payroll',
  'revenue-recognition-je': 'revenue_recognition',
  'depreciation-je': 'depreciation',
  'amortization-je': 'amortization',
  'prepaid-je': 'prepaid_amortization',
  'fixed-asset-je': 'fixed_assets',
  'attach-evidence': 'journal_entry',
  'sync-approved-jes': 'journal_entry',
  'fixed-asset-rollforward': 'fixed_assets',
  'depreciation-schedule': 'depreciation',
  'amortization-schedule': 'amortization',
  'deferred-revenue-schedule': 'revenue_recognition',
  'prepaid-schedule': 'prepaid_amortization',
  'accrual-schedule': 'accruals',
  'balance-sheet-rollforward': 'month_end_close',
  'data-analysis': 'flux_analysis',
  'flux-analysis': 'flux_analysis',
  'variance-analysis': 'flux_analysis',
  'budget-vs-actual': 'flux_analysis',
  'period-over-period': 'flux_analysis',
  'revenue-analysis': 'flux_analysis',
  'expense-analysis': 'flux_analysis',
  'waterfall-analysis': 'flux_analysis',
  'management-commentary': 'flux_analysis',
  'read-pdf': null,
  'ocr-document': null,
  'extract-tables': null,
  'read-excel': null,
  'create-spreadsheet': null,
  'modify-spreadsheet': null,
  'merge-split-pdf': null,
  'generate-workpaper': null,
  'reuse-workflow': null,
};
