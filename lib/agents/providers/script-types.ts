import type { Artifact, Blocker, Clarification, EvidenceTable, SpecialistName, ToolName } from '@/lib/domain/types';

export interface ScriptedCall {
  tool: ToolName;
  args: unknown;
  /** When the tool produced a file, publish it as an artifact under this name. */
  artifact?: { filename: string; kind: Artifact['kind'] };
  /** A table built from this call's result, shown in the plan document. */
  table?: EvidenceTable;
  /** Figures this call established, each traced back to it. */
  provenance?: { label: string; value: string; note?: string }[];
}

export interface ScriptedStep {
  title: string;
  agent: SpecialistName;
  notes: string[];
  calls: ScriptedCall[];
  /** Raised after this step's tool calls; the run stops until a human resolves it. */
  blocker?: Omit<Blocker, 'id' | 'stepId'>;
}

export interface Script {
  steps: ScriptedStep[];
  confidence: number;
  openQuestions: string[];
  summary: string;
  clarificationIntro?: string;
  clarificationWhy?: string;
  clarifications?: Clarification[];
  scope?: string;
  reasoning?: string[];
  findings?: string[];
  assumptions?: string[];
}
