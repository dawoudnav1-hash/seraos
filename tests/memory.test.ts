import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryMemoryStore,
  InMemoryRuleStore,
} from '@/lib/memory/store';
import { UserMemory, normalizeQuestionKey } from '@/lib/memory/user';
import { SemanticMemory } from '@/lib/memory/semantic';
import { HistoricalMemory } from '@/lib/memory/historical';
import { ProcessMemory } from '@/lib/memory/process';
import { LearningMemory } from '@/lib/memory/learning';
import { Memory } from '@/lib/memory';

describe('memory system', () => {
  let memoryStore: InMemoryMemoryStore;
  let ruleStore: InMemoryRuleStore;
  let memory: Memory;

  beforeEach(() => {
    memoryStore = new InMemoryMemoryStore();
    ruleStore = new InMemoryRuleStore();
    memory = new Memory(memoryStore, ruleStore);
  });

  describe('MemoryStore', () => {
    it('puts and retrieves a record', async () => {
      const record = await memoryStore.put({
        kind: 'user',
        client: 'acme',
        userId: 'user1',
        key: 'test_key',
        value: { data: 'test' },
        confidence: 0.95,
        source: 'run_1',
      });

      expect(record.id).toBeDefined();
      expect(record.hits).toBe(0);
      expect(record.createdAt).toBeDefined();
    });

    it('upserts on matching (kind, client, userId, key)', async () => {
      const first = await memoryStore.put({
        kind: 'user',
        client: 'acme',
        userId: 'user1',
        key: 'q1',
        value: { answer: 'yes' },
        confidence: 0.95,
        source: 'run_1',
      });

      const second = await memoryStore.put({
        kind: 'user',
        client: 'acme',
        userId: 'user1',
        key: 'q1',
        value: { answer: 'no' },
        confidence: 0.9,
        source: 'run_2',
      });

      expect(first.id).toBe(second.id);
      expect(second.value).toEqual({ answer: 'no' });
    });

    it('increments hits on touch', async () => {
      const record = await memoryStore.put({
        kind: 'user',
        client: 'acme',
        userId: 'user1',
        key: 'q1',
        value: { data: 'test' },
        confidence: 0.95,
        source: 'run_1',
      });

      await memoryStore.touch(record.id);
      await memoryStore.touch(record.id);

      const retrieved = await memoryStore.get('user', { client: 'acme', userId: 'user1' }, 'q1');
      expect(retrieved?.hits).toBe(2);
    });

    it('lists records by kind and scope', async () => {
      await memoryStore.put({
        kind: 'user',
        client: 'acme',
        userId: 'user1',
        key: 'q1',
        value: { data: 'a' },
        confidence: 0.95,
        source: 'run_1',
      });

      await memoryStore.put({
        kind: 'user',
        client: 'acme',
        userId: 'user1',
        key: 'q2',
        value: { data: 'b' },
        confidence: 0.95,
        source: 'run_1',
      });

      await memoryStore.put({
        kind: 'semantic',
        client: 'acme',
        userId: 'user1',
        key: 's1',
        value: { data: 'c' },
        confidence: 0.95,
        source: 'run_1',
      });

      const userRecords = await memoryStore.list('user', { client: 'acme', userId: 'user1' });
      expect(userRecords).toHaveLength(2);
    });

    it('lists with prefix filter', async () => {
      await memoryStore.put({
        kind: 'semantic',
        client: 'acme',
        userId: '',
        key: 'vendor_account:apple',
        value: { account: '6000' },
        confidence: 0.95,
        source: 'run_1',
      });

      await memoryStore.put({
        kind: 'semantic',
        client: 'acme',
        userId: '',
        key: 'vendor_account:microsoft',
        value: { account: '6001' },
        confidence: 0.95,
        source: 'run_1',
      });

      await memoryStore.put({
        kind: 'semantic',
        client: 'acme',
        userId: '',
        key: 'account_mapping:123',
        value: { chartCode: '1000' },
        confidence: 0.95,
        source: 'run_1',
      });

      const vendorRules = await memoryStore.list('semantic', { client: 'acme' }, 'vendor_account:');
      expect(vendorRules).toHaveLength(2);
    });

    it('deletes a record', async () => {
      const record = await memoryStore.put({
        kind: 'user',
        client: 'acme',
        userId: 'user1',
        key: 'q1',
        value: { data: 'test' },
        confidence: 0.95,
        source: 'run_1',
      });

      await memoryStore.delete(record.id);

      const retrieved = await memoryStore.get('user', { client: 'acme', userId: 'user1' }, 'q1');
      expect(retrieved).toBeNull();
    });
  });

  describe('UserMemory', () => {
    let userMemory: UserMemory;

    beforeEach(() => {
      userMemory = new UserMemory(memoryStore);
    });

    it('normalizes question keys across periods', () => {
      const key1 = normalizeQuestionKey('Which asset classes for April 2026?');
      const key2 = normalizeQuestionKey('Which asset classes for May 2026?');
      expect(key1).toBe(key2);
    });

    it('remembers answers', async () => {
      await userMemory.rememberAnswer({
        client: 'acme',
        userId: 'user1',
        questionKey: 'What is the fiscal year start?',
        question: 'What is the fiscal year start?',
        answer: 'January 1st',
        runId: 'run_1',
      });

      const record = await memoryStore.get('user', { client: 'acme', userId: 'user1' }, normalizeQuestionKey('What is the fiscal year start?'));
      expect(record).not.toBeNull();
    });

    it('suggests answers with confidence decay', async () => {
      // Use consistent keys that will match after normalization
      const questionText = 'Which asset classes?';
      const normalizedKey = normalizeQuestionKey(questionText);

      // Store an answer
      await memoryStore.put({
        kind: 'user',
        client: 'acme',
        userId: 'user1',
        key: normalizedKey,
        value: { answer: 'stocks and bonds' },
        confidence: 0.95,
        source: 'run_1',
      });

      // Simulate age by creating a record with old updatedAt
      // We'll directly retrieve and check since confidence decay is calculated on read
      const suggestions = await userMemory.suggestAnswers({
        client: 'acme',
        userId: 'user1',
        questions: [{ id: questionText, question: questionText }],
      });

      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].answer).toBe('stocks and bonds');
      expect(suggestions[0].confidence).toBeGreaterThan(0.5);
    });

    it('stores and retrieves preferences', async () => {
      const prefs = { currency: 'USD', timezone: 'America/New_York' };
      await userMemory.setPreferences('acme', 'user1', prefs);

      const retrieved = await userMemory.getPreferences({ client: 'acme', userId: 'user1' });
      expect(retrieved).toEqual(prefs);
    });
  });

  describe('SemanticMemory', () => {
    let semanticMemory: SemanticMemory;

    beforeEach(() => {
      semanticMemory = new SemanticMemory(memoryStore);
    });

    it('stores and retrieves vendor→account rules', async () => {
      await semanticMemory.setVendorAccountRule(
        { client: 'acme' },
        'Best Buy',
        '6410',
        'run_1',
      );

      const rule = await semanticMemory.getVendorAccountRule({ client: 'acme' }, 'Best Buy');
      expect(rule).not.toBeNull();
      expect(rule?.account).toBe('6410');
    });

    it('lists vendor account rules', async () => {
      await semanticMemory.setVendorAccountRule(
        { client: 'acme' },
        'Best Buy',
        '6410',
        'run_1',
      );
      await semanticMemory.setVendorAccountRule(
        { client: 'acme' },
        'Amazon',
        '6420',
        'run_1',
      );

      const rules = await semanticMemory.listVendorAccountRules({ client: 'acme' });
      expect(rules).toHaveLength(2);
    });

    it('stores and retrieves materiality', async () => {
      const materiality = { absoluteCents: 500000, percentOfBase: 50 };
      await semanticMemory.setMateriality({ client: 'acme' }, materiality, 'audit_policy');

      const retrieved = await semanticMemory.getMateriality({ client: 'acme' });
      expect(retrieved).toEqual({
        ...materiality,
        source: 'audit_policy',
      });
    });

    it('stores and retrieves capitalization policy', async () => {
      const policy = { thresholdCents: 250000, minLifeMonths: 12 };
      await semanticMemory.setCapitalizationPolicy({ client: 'acme' }, policy, 'policy_doc');

      const retrieved = await semanticMemory.getCapitalizationPolicy({ client: 'acme' });
      expect(retrieved).toEqual({
        ...policy,
        source: 'policy_doc',
      });
    });

    it('stores and retrieves fiscal year start month', async () => {
      await semanticMemory.setFiscalYearStart({ client: 'acme' }, 7, 'config');

      const retrieved = await semanticMemory.getFiscalYearStart({ client: 'acme' });
      expect(retrieved?.month).toBe(7);
    });

    it('validates fiscal year start month range', async () => {
      await expect(semanticMemory.setFiscalYearStart({ client: 'acme' }, 13, 'config')).rejects.toThrow();
    });
  });

  describe('HistoricalMemory', () => {
    let historicalMemory: HistoricalMemory;

    beforeEach(() => {
      historicalMemory = new HistoricalMemory(memoryStore);
    });

    it('records and retrieves figures', async () => {
      await historicalMemory.recordFigure({
        client: 'acme',
        account: '1000',
        period: '2026-01',
        valueCents: 100000,
        source: 'gl',
      });

      const priors = await historicalMemory.priorPeriods('acme', '1000', '2026-02', 5);
      expect(priors).toHaveLength(1);
      expect(priors[0].valueCents).toBe(100000);
    });

    it('reasonableness passes with sufficient history', async () => {
      // Record 3 months of history
      await historicalMemory.recordFigure({
        client: 'acme',
        account: '1000',
        period: '2026-01',
        valueCents: 100000,
        source: 'gl',
      });

      await historicalMemory.recordFigure({
        client: 'acme',
        account: '1000',
        period: '2026-02',
        valueCents: 105000,
        source: 'gl',
      });

      await historicalMemory.recordFigure({
        client: 'acme',
        account: '1000',
        period: '2026-03',
        valueCents: 102000,
        source: 'gl',
      });

      const result = await historicalMemory.reasonableness('acme', '1000', '2026-04', 103000);
      expect(result.pass).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('reasonableness fails on large outliers', async () => {
      await historicalMemory.recordFigure({
        client: 'acme',
        account: '1000',
        period: '2026-01',
        valueCents: 100000,
        source: 'gl',
      });

      await historicalMemory.recordFigure({
        client: 'acme',
        account: '1000',
        period: '2026-02',
        valueCents: 105000,
        source: 'gl',
      });

      const result = await historicalMemory.reasonableness('acme', '1000', '2026-03', 500000);
      expect(result.pass).toBe(false);
    });

    it('reasonableness passes with insufficient history', async () => {
      const result = await historicalMemory.reasonableness('acme', '1000', '2026-02', 100000);
      expect(result.pass).toBe(true);
      expect(result.confidence).toBeLessThan(0.5);
      expect(result.message).toMatch(/Insufficient history/);
    });
  });

  describe('ProcessMemory', () => {
    let processMemory: ProcessMemory;

    beforeEach(() => {
      processMemory = new ProcessMemory(memoryStore);
    });

    it('saves workflow templates', async () => {
      const id = await processMemory.saveTemplate({
        client: 'acme',
        name: 'Month-end close',
        skillIds: ['reconcile', 'journal', 'verify'],
        params: { period: '2026-04' },
        answers: { fiscal_year_start: 'January' },
        sourceRunId: 'run_1',
      });

      expect(id).toBeDefined();
    });

    it('finds templates by text', async () => {
      await processMemory.saveTemplate({
        client: 'acme',
        name: 'Month-end reconciliation',
        skillIds: ['reconcile'],
        params: {},
        answers: {},
        sourceRunId: 'run_1',
      });

      const templates = await processMemory.findTemplates({
        client: 'acme',
        text: 'reconciliation',
      });

      expect(templates.length).toBeGreaterThan(0);
      expect(templates[0].name).toMatch(/reconciliation/i);
    });

    it('finds templates by skill ids', async () => {
      await processMemory.saveTemplate({
        client: 'acme',
        name: 'Template A',
        skillIds: ['reconcile', 'journal'],
        params: {},
        answers: {},
        sourceRunId: 'run_1',
      });

      const templates = await processMemory.findTemplates({
        client: 'acme',
        skillIds: ['journal'],
      });

      expect(templates.length).toBeGreaterThan(0);
    });

    it('instantiates templates with period substitution', async () => {
      const saved = await processMemory.saveTemplate({
        client: 'acme',
        name: 'Close template',
        skillIds: ['close'],
        params: { period: 'April 2026' },
        answers: { description: 'Close for May 2026' },
        sourceRunId: 'run_1',
      });

      const templates = await processMemory.findTemplates({
        client: 'acme',
      });

      const instantiated = await processMemory.instantiate(templates[0], {
        client: 'acme',
        period: '2026-05',
      });

      expect(instantiated.params.period).toContain('2026-05');
    });

    it('ranks templates by hits', async () => {
      const id1 = await processMemory.saveTemplate({
        client: 'acme',
        name: 'Popular template',
        skillIds: [],
        params: {},
        answers: {},
        sourceRunId: 'run_1',
      });

      const templates = await processMemory.findTemplates({
        client: 'acme',
      });

      // Touch the template multiple times
      await memoryStore.touch(id1);
      await memoryStore.touch(id1);

      const afterTouch = await processMemory.findTemplates({
        client: 'acme',
      });

      expect(afterTouch[0].hits).toBeGreaterThan(0);
    });
  });

  describe('RuleStore', () => {
    it('puts and retrieves rules', async () => {
      const rule = await ruleStore.put({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        action: { account: '6420' },
        status: 'candidate',
      });

      expect(rule.id).toBeDefined();
      expect(rule.confirmations).toBe(1);
    });

    it('increments confirmations for same pattern+action', async () => {
      const first = await ruleStore.put({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        action: { account: '6420' },
        status: 'candidate',
      });

      const second = await ruleStore.put({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        action: { account: '6420' },
        status: 'candidate',
      });

      expect(first.id).toBe(second.id);
      expect(second.confirmations).toBe(2);
    });

    it('lists rules by client and kind', async () => {
      await ruleStore.put({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        action: { account: '6420' },
        status: 'candidate',
      });

      await ruleStore.put({
        client: 'acme',
        kind: 'mapping',
        pattern: {},
        action: {},
        status: 'candidate',
      });

      const codingRules = await ruleStore.list('acme', 'coding');
      expect(codingRules).toHaveLength(1);
    });

    it('updates rule status', async () => {
      const rule = await ruleStore.put({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        action: { account: '6420' },
        status: 'candidate',
      });

      const updated = await ruleStore.update(rule.id, { status: 'promoted' });
      expect(updated.status).toBe('promoted');
    });
  });

  describe('LearningMemory', () => {
    let learningMemory: LearningMemory;

    beforeEach(() => {
      learningMemory = new LearningMemory(ruleStore, new SemanticMemory(memoryStore));
    });

    it('creates candidate rules from corrections', async () => {
      const rule = await learningMemory.recordCorrection({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        before: '6000',
        after: '6420',
        actor: 'user1',
      });

      expect(rule.status).toBe('candidate');
      expect(rule.confirmations).toBeGreaterThanOrEqual(1);
    });

    it('increments confirmations on repeated corrections', async () => {
      const first = await learningMemory.recordCorrection({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        before: '6000',
        after: '6420',
        actor: 'user1',
      });

      const second = await learningMemory.recordCorrection({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        before: '6000',
        after: '6420',
        actor: 'user2',
      });

      expect(second.confirmations).toBe(2);
    });

    it('auto-promotes rules with 3+ confirmations and 0 rejections', async () => {
      await learningMemory.recordCorrection({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        before: '6000',
        after: '6420',
        actor: 'user1',
      });

      await learningMemory.recordCorrection({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        before: '6000',
        after: '6420',
        actor: 'user2',
      });

      const third = await learningMemory.recordCorrection({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        before: '6000',
        after: '6420',
        actor: 'user3',
      });

      expect(third.status).toBe('promoted');
    });

    it('applies promoted rules with high confidence', async () => {
      // Create and promote a rule
      await learningMemory.recordCorrection({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        before: '6000',
        after: '6420',
        actor: 'user1',
      });

      await learningMemory.recordCorrection({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        before: '6000',
        after: '6420',
        actor: 'user2',
      });

      await learningMemory.recordCorrection({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Amazon' },
        before: '6000',
        after: '6420',
        actor: 'user3',
      });

      const result = await learningMemory.applyCodingRules('acme', { vendor: 'Amazon' });
      expect(result.confidence).toBe(0.99);
      expect(result.status).toBe('promoted');
    });

    it('applies candidate rules with lower confidence', async () => {
      await learningMemory.recordCorrection({
        client: 'acme',
        kind: 'coding',
        pattern: { vendor: 'Best Buy' },
        before: '6000',
        after: '6410',
        actor: 'user1',
      });

      const result = await learningMemory.applyCodingRules('acme', { vendor: 'Best Buy' });
      expect(result.confidence).toBeLessThan(0.99);
      expect(result.status).toBe('candidate');
    });

    it('returns no rule when nothing matches', async () => {
      const result = await learningMemory.applyCodingRules('acme', { vendor: 'Unknown' });
      expect(result.status).toBe('none');
      expect(result.confidence).toBe(0);
    });
  });

  describe('Coding rules are strict and contradictions count', () => {
    let learningMemory: LearningMemory;
    let semanticMemory: SemanticMemory;
    beforeEach(() => {
      semanticMemory = new SemanticMemory(memoryStore);
      learningMemory = new LearningMemory(ruleStore, semanticMemory);
    });
    const correct = (vendor: string, after: string, actor = 'u') =>
      learningMemory.recordCorrection({ client: 'strict', kind: 'coding', pattern: { vendor }, before: '6000', after, actor });

    it('does not apply a promoted rule to an unrelated vendor', async () => {
      for (const a of ['u1', 'u2', 'u3']) await correct('Staples', '6100', a);
      const other = await learningMemory.applyCodingRules('strict', { counterparty: 'Amazon Marketplace' });
      expect(other.status).toBe('none');
      const same = await learningMemory.applyCodingRules('strict', { counterparty: 'STAPLES, INC.' });
      expect(same.status).toBe('promoted');
      expect(same.confidence).toBe(0.99);
    });

    it('gives a partial name match less than full confidence', async () => {
      for (const a of ['u1', 'u2', 'u3']) await correct('Home Depot', '1520', a);
      const r = await learningMemory.applyCodingRules('strict', { description: 'HOME DEPOT #4411 ORLANDO' });
      expect(r.status).toBe('promoted');
      expect(r.confidence).toBeLessThan(0.98);
    });

    it('counts a conflicting correction against the earlier rule and blocks its promotion', async () => {
      await correct('Uline', '6200');
      await correct('Uline', '6200');
      await correct('Uline', '5000');
      const rules = await ruleStore.list('strict', 'coding');
      const old = rules.find((r) => (r.action as { action: string }).action === '6200')!;
      expect(old.rejections).toBe(1);
      await correct('Uline', '6200');
      const after = (await ruleStore.list('strict', 'coding')).find((r) => r.id === old.id)!;
      expect(after.status).toBe('candidate');
    });

    it('demotes a promoted rule when contradicted and withdraws its fact', async () => {
      for (const a of ['u1', 'u2', 'u3']) await correct('Shell', '6300', a);
      expect(await semanticMemory.getVendorAccountRule({ client: 'strict' }, 'Shell')).not.toBeNull();
      await correct('Shell', '1540');
      const rule = (await ruleStore.list('strict', 'coding')).find((r) => (r.action as { action: string }).action === '6300')!;
      expect(rule.status).toBe('candidate');
      expect(await semanticMemory.getVendorAccountRule({ client: 'strict' }, 'Shell')).toBeNull();
    });
  });

  describe('Reasonableness with flat history', () => {
    let historicalMemory: HistoricalMemory;
    beforeEach(() => {
      historicalMemory = new HistoricalMemory(memoryStore);
    });
    it('flags any departure from a constant history', async () => {
      for (const period of ['2026-01', '2026-02', '2026-03']) {
        await historicalMemory.recordFigure({ client: 'flat', account: '6410', period, valueCents: 100000, source: 'test' });
      }
      const same = await historicalMemory.reasonableness('flat', '6410', '2026-04', 100000, { pctThresholdBps: 100000 });
      expect(same.pass).toBe(true);
      const jump = await historicalMemory.reasonableness('flat', '6410', '2026-04', 100100, { pctThresholdBps: 100000 });
      expect(jump.pass).toBe(false);
    });
  });

  describe('Memory facade', () => {
    it('exports all required methods', async () => {
      expect(memory.rememberAnswer).toBeDefined();
      expect(memory.suggestAnswers).toBeDefined();
      expect(memory.recordFigure).toBeDefined();
      expect(memory.reasonableness).toBeDefined();
      expect(memory.saveTemplate).toBeDefined();
      expect(memory.findTemplates).toBeDefined();
      expect(memory.recordCorrection).toBeDefined();
      expect(memory.applyCodingRules).toBeDefined();
    });

    it('returns record citations', async () => {
      const ref = await memory.rememberAnswer({
        client: 'acme',
        userId: 'user1',
        questionKey: 'Test?',
        question: 'Test?',
        answer: 'Answer',
        runId: 'run_1',
      });

      expect(ref.recordIds).toBeDefined();
      expect(Array.isArray(ref.recordIds)).toBe(true);
    });
  });
});
