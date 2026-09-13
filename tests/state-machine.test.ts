import { describe, expect, it } from 'vitest';
import { canTransition, explainRefusal, assertTransition, TransitionError } from '@/lib/domain/state-machine';

describe('run state machine', () => {
  it('lets the orchestrator move work forward', () => {
    expect(canTransition('queued', 'planning', 'orchestrator')).toBe(true);
    expect(canTransition('planning', 'executing', 'orchestrator')).toBe(true);
    expect(canTransition('executing', 'review_ready', 'orchestrator')).toBe(true);
    expect(canTransition('blocked', 'executing', 'orchestrator')).toBe(true);
  });

  it('refuses to let a human drag a run into In Progress', () => {
    expect(canTransition('blocked', 'executing', 'human')).toBe(false);
    expect(explainRefusal('blocked', 'executing', 'human')).toMatch(/Only the orchestrator/);
  });

  it('makes a human look at work before approving it', () => {
    expect(canTransition('review_ready', 'approved', 'human')).toBe(false);
    expect(canTransition('review_ready', 'viewed', 'human')).toBe(true);
    expect(canTransition('viewed', 'approved', 'human')).toBe(true);
  });

  it('lets a human send anything in flight back to blocked', () => {
    expect(canTransition('review_ready', 'blocked', 'human')).toBe(true);
    expect(canTransition('viewed', 'blocked', 'human')).toBe(true);
    expect(canTransition('executing', 'blocked', 'human')).toBe(true);
  });

  it('treats approved work as final', () => {
    expect(canTransition('approved', 'executing', 'human')).toBe(false);
    expect(() => assertTransition('approved', 'rejected', 'human')).toThrow(TransitionError);
  });

  it('cannot jump straight from queued to review_ready', () => {
    expect(canTransition('queued', 'review_ready', 'orchestrator')).toBe(false);
  });
});
