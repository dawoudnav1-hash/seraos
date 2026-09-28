/** The close team. Managers and controllers approve workpapers; accountants prepare them. */
export interface Person {
  id: string;
  name: string;
  initials: string;
  role: 'Finance Manager' | 'Controller' | 'Senior Accountant' | 'Staff Accountant';
  canApprove: boolean;
  /** Avatar tint — a hue, not a status. */
  tint: string;
}

export const PEOPLE: Person[] = [
  { id: 'alex', name: 'Alex Morgan', initials: 'AM', role: 'Finance Manager', canApprove: true, tint: '#7c5cff' },
  { id: 'jordan', name: 'Jordan Lee', initials: 'JL', role: 'Controller', canApprove: true, tint: '#0e9f8e' },
  { id: 'bianca', name: 'Bianca Nguyen', initials: 'BN', role: 'Senior Accountant', canApprove: false, tint: '#e0578a' },
  { id: 'brian', name: 'Brian Torres', initials: 'BT', role: 'Staff Accountant', canApprove: false, tint: '#8a63d2' },
  { id: 'tomas', name: 'Tomas Garcia', initials: 'TG', role: 'Staff Accountant', canApprove: false, tint: '#3b82c4' },
  { id: 'connor', name: 'Connor Fitz', initials: 'CF', role: 'Staff Accountant', canApprove: false, tint: '#c98a1a' },
  { id: 'luc', name: 'Luc Abara', initials: 'LA', role: 'Senior Accountant', canApprove: false, tint: '#c2572d' },
];

/** Who is signed in. */
export const CURRENT_USER = PEOPLE[0];

export function person(nameOrId: string | null | undefined): Person | null {
  if (!nameOrId) return null;
  return PEOPLE.find((p) => p.id === nameOrId || p.name === nameOrId) ?? null;
}

export const APPROVERS = PEOPLE.filter((p) => p.canApprove);
