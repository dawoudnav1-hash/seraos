// Copied verbatim from DATA_CONTRACT.md — keep in sync with the contract.

export type AccountType = 'firm' | 'internal' | 'solo';
// firm     = accounting / bookkeeping / advisory practice (external firm)
// internal = company with an in-house finance team of 2+ people
// solo     = one-person setup: a company whose finance function is a single person,
//            or a practice with <= 2 staff. `typeReason` explains the classification.

export interface Contact {
  id: string;                 // stable, unique across the whole dataset
  name: string;
  title?: string;
  roleType?: string;          // 'Finance' | 'Executive' | 'Founder' | 'Other'
  email?: string;
  emailStatus?: string;       // free text from source, e.g. 'verified', 'Apollo check: not confirmed'
  emailRisk?: 'ok' | 'caution' | 'none';  // 'none' = no email; 'caution' = unconfirmed/catch-all/flagged
  linkedin?: string;          // full URL
  location?: string;
  inRoleSince?: string;
  priority?: string;
  notes?: string;
  isPrimary?: boolean;
  likelyLeft?: boolean;       // source flagged the person as possibly no longer at the company
  sources: string[];          // e.g. ['Vert_AU_finance_team_contacts', 'Attio']
  inAttio: boolean;
}

export interface Account {
  id: string;                 // stable slug, unique
  name: string;
  domain?: string;            // bare domain, e.g. 'stepone.life'
  website?: string;           // full URL
  linkedin?: string;
  logoUrl?: string;
  type: AccountType;
  typeReason: string;
  segment: string;            // 'SaaS' | 'CPG / Ecom / D2C' | 'AI startup' | 'Accounting & advisory' | 'VC / Accelerator' | 'Other'
  sector?: string;            // short sub-industry text
  description?: string;
  location?: string;          // 'Sydney, NSW, AU' etc.
  city?: string;              // normalised metro / regional centre: 'Melbourne', 'Sydney', 'Gold Coast', 'Byron Bay', ...
                              // (absent = unknown). Contacts have no city of their own: a contact's city is its account's.
  suburb?: string;            // e.g. 'Richmond', 'Burleigh Heads' (absent when the location is the city itself)
  state?: string;             // 'VIC' | 'NSW' | 'QLD' | 'WA' | 'SA' | 'TAS' | 'ACT' | 'NT' (absent outside Australia, e.g. 'Tauranga')
  cityBasis?: string;         // 'Company location' | 'Contact location (company location not recorded)' | e.g. 'Web research (Exa)'
  employees?: string;         // headcount as text
  employeeRange?: string;
  financeHeadcount?: number | null;
  headcountBasis?: string;
  revenue?: string;           // estimated revenue / online sales text
  arr?: string;               // Attio Estimated ARR band
  funding?: string;           // recent funding text
  valuation?: string;
  founded?: string;
  signalScore?: number | null;   // 1-5 parsed from Attio signal "3/5 — ..."
  signalSummary?: string;        // first line of the signal
  signal?: string;               // full alpha / research write-up (multi-line, may be long)
  serviceSignal?: string;        // accounting firms: why it fits
  fitConfidence?: string;        // 'High' | 'Medium' | 'Low'
  growth?: string;
  icpStatus?: string;
  fundingStage?: string;         // funding stage + notable investors (master prospect list)
  techStack?: string;            // evidence of tech stack, with source
  keySignals?: string;           // key info / recent signals
  whyFit?: string;               // why they fit Vert
  decisionMaker?: string;        // likely decision maker
  fitScore?: number;             // 1-5 fit score from the master prospect list
  listStatus?: string;
  sourceUrls?: string[];         // research source links
  signalSource?: string;         // 'Attio' or 'Exa web research' — provenance of `signal`
  services?: string[];           // accounting firms: services they list
  flags?: string;                // notes / flags from research
  notes?: string;
  cfo?: string;
  financeTeam?: string;
  founder?: string;
  attioId?: string;
  otherAttioIds?: string[];   // Attio has duplicate records for this company (merged here)
  otherDomains?: string[];    // additional domains seen for this company
  inAttio: boolean;
  sources: string[];
  contacts: Contact[];
}

export interface OutreachEvent {
  id: string;
  date: string;               // ISO 8601
  channel: 'email' | 'linkedin';
  kind: 'sent' | 'reply' | 'opened' | 'connection_sent' | 'connection_accepted' | 'message_sent' | 'message_seen' | 'meeting';
  source: string;             // 'hostinger' | 'gmail' | 'linkedin' | 'gmail-linkedin-notification' | 'manual'
  accountId?: string;         // resolved by the pipeline when matchable
  contactId?: string;
  counterpartyEmails?: string[];
  personName?: string;
  subject?: string;
  snippet?: string;
  seenFlag?: boolean | null;
}

export interface SourceNote { name: string; detail: string; }
