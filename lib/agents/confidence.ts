import { CONFIDENCE_FLOOR, type AgentEvent, type Blocker } from '@/lib/domain/types';

export interface Finalization {
  runId: string;
  stepId: string;
  summary: string;
  confidence: number;
  openQuestions: string[];
}

/**
 * An agent that is unsure does not hand in work: below the confidence floor the
 * run routes to `blocked` with its open questions, never to `review_ready`.
 */
export function finalizeEvent(f: Finalization): AgentEvent {
  if (f.confidence >= CONFIDENCE_FLOOR && f.openQuestions.length === 0) {
    return { type: 'run_completed', summary: f.summary };
  }
  if (f.confidence < CONFIDENCE_FLOOR) {
    const blocker: Blocker = {
      id: `blk_${f.runId}_confidence`,
      stepId: f.stepId,
      reason: 'low_confidence',
      title: 'Agent is not confident enough to submit',
      detail:
        `Confidence ${(f.confidence * 100).toFixed(0)}% is below the ${(CONFIDENCE_FLOOR * 100).toFixed(0)}% floor. ` +
        (f.openQuestions[0] ?? 'Judgment call needed before this can go to review.'),
      resolution: { kind: 'answer_question', label: 'Answer and resume' },
    };
    return { type: 'blocked', blocker };
  }
  return { type: 'run_completed', summary: `${f.summary} Open questions: ${f.openQuestions.join('; ')}` };
}
