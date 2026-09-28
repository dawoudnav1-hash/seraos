/**
 * User memory: answers and preferences that prefill clarifications.
 */

import { MemoryStore, MemoryScope } from './store';

export interface UserAnswer {
  questionId: string;
  answer: string;
  fromRunId: string;
  ageDays: number;
  confidence: number;
}

export interface RememberAnswerInput {
  client: string;
  userId: string;
  questionKey: string;
  question: string;
  answer: string;
  runId: string;
}

export interface SuggestAnswersInput {
  client: string;
  userId: string;
  questions: Array<{ id: string; question: string }>;
}

/**
 * Normalizes a question key by lowercasing, stripping punctuation, digits (years),
 * and month names, so "Which asset classes for April 2026?" and "…for May 2026?" share a key.
 */
export function normalizeQuestionKey(question: string): string {
  const monthNames = 'january|february|march|april|may|june|july|august|september|october|november|december';
  return question
    .toLowerCase()
    .replace(/[?!.,;:()]/g, '') // strip punctuation
    .replace(new RegExp(`\\b(${monthNames})\\b`, 'g'), '') // strip month names
    .replace(/\d+/g, '') // strip digits (years, counts)
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();
}

/**
 * Calculates confidence decay based on age in days.
 * Starts at 0.95 and decays linearly, reaching 0.50 at 90 days.
 */
function confidenceWithAge(baseDays: number): number {
  const decayPerDay = (0.95 - 0.50) / 90;
  return Math.max(0.5, 0.95 - baseDays * decayPerDay);
}

export class UserMemory {
  constructor(private store: MemoryStore) {}

  async rememberAnswer(input: RememberAnswerInput): Promise<void> {
    const key = normalizeQuestionKey(input.questionKey);
    const scope: MemoryScope = {
      client: input.client,
      userId: input.userId,
    };

    await this.store.put({
      kind: 'user',
      client: input.client,
      userId: input.userId,
      key,
      value: {
        question: input.question,
        answer: input.answer,
      },
      confidence: 0.95,
      source: input.runId,
    });
  }

  async suggestAnswers(input: SuggestAnswersInput): Promise<UserAnswer[]> {
    const scope: MemoryScope = {
      client: input.client,
      userId: input.userId,
    };

    const suggestions: UserAnswer[] = [];
    const now = new Date();

    for (const q of input.questions) {
      const normalizedKey = normalizeQuestionKey(q.id);
      const record = await this.store.get('user', scope, normalizedKey);

      if (record) {
        await this.store.touch(record.id);
        const ageDays = Math.floor((now.getTime() - record.updatedAt.getTime()) / (1000 * 60 * 60 * 24));
        const confidence = confidenceWithAge(ageDays);

        const value = record.value as { answer: string };
        suggestions.push({
          questionId: q.id,
          answer: value.answer,
          fromRunId: record.source,
          ageDays,
          confidence,
        });
      }
    }

    return suggestions;
  }

  async getPreferences(scope: MemoryScope): Promise<Record<string, unknown> | null> {
    const record = await this.store.get('user', scope, '_preferences');
    return record ? (record.value as Record<string, unknown>) : null;
  }

  async setPreferences(client: string, userId: string, prefs: Record<string, unknown>): Promise<void> {
    await this.store.put({
      kind: 'user',
      client,
      userId,
      key: '_preferences',
      value: prefs,
      confidence: 0.95,
      source: 'user',
    });
  }
}
