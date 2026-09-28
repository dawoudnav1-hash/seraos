import type { z } from 'zod';
import type { SpecialistName, Step, ToolName } from '@/lib/domain/types';

export interface Specialist<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: SpecialistName;
  /** Tools this specialist is allowed to call. The orchestrator enforces it. */
  tools: readonly ToolName[];
  systemPrompt: string;
  outputSchema: Schema;
  /** What this specialist claims it will do for a task, used when planning. */
  plan(task: string): Omit<Step, 'id' | 'status'>[];
}
