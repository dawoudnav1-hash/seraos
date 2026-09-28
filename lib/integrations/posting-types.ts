/**
 * Approval shape used by the posting gate and both provider clients. Split
 * out from posting.ts so quickbooks.ts/xero.ts can import the type without
 * a circular module dependency (posting.ts imports the provider clients).
 */

export interface Approver {
  name: string;
  role: string;
}

export interface Approval {
  approvalId: string;
  approvers: Approver[];
}
