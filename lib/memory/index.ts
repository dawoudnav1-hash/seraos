/**
 * Memory facade: unified interface to all memory systems.
 * Constructed with MemoryStore and RuleStore implementations.
 */

import { MemoryStore, RuleStore } from './store';
import { UserMemory, RememberAnswerInput, SuggestAnswersInput } from './user';
import { SemanticMemory } from './semantic';
import { HistoricalMemory, RecordFigureInput, ReasonablenessResult } from './historical';
import { ProcessMemory, SaveTemplateInput, FindTemplatesInput, ProcessTemplate } from './process';
import { LearningMemory, RecordCorrectionInput, ApplyCodingRulesResult } from './learning';

export interface MemoryRecordRef {
  recordIds: string[];
}

export class Memory {
  private user: UserMemory;
  private semantic: SemanticMemory;
  private historical: HistoricalMemory;
  private process: ProcessMemory;
  private learning: LearningMemory;

  constructor(memoryStore: MemoryStore, ruleStore: RuleStore) {
    this.user = new UserMemory(memoryStore);
    this.semantic = new SemanticMemory(memoryStore);
    this.historical = new HistoricalMemory(memoryStore);
    this.process = new ProcessMemory(memoryStore);
    this.learning = new LearningMemory(ruleStore, this.semantic);
  }

  // User memory methods
  async rememberAnswer(input: RememberAnswerInput): Promise<MemoryRecordRef> {
    await this.user.rememberAnswer(input);
    return { recordIds: [] };
  }

  async suggestAnswers(input: SuggestAnswersInput): Promise<MemoryRecordRef> {
    const suggestions = await this.user.suggestAnswers(input);
    return { recordIds: suggestions.map((s) => s.fromRunId) };
  }

  // Semantic memory methods
  async getVendorAccountRule(client: string, vendor: string): Promise<MemoryRecordRef> {
    await this.semantic.getVendorAccountRule({ client }, vendor);
    return { recordIds: [] };
  }

  async setVendorAccountRule(client: string, vendor: string, account: string, source: string): Promise<void> {
    await this.semantic.setVendorAccountRule({ client }, vendor, account, source);
  }

  async getMateriality(client: string): Promise<MemoryRecordRef> {
    await this.semantic.getMateriality({ client });
    return { recordIds: [] };
  }

  async setMateriality(client: string, materiality: { absoluteCents: number; percentOfBase: number }, source: string): Promise<void> {
    await this.semantic.setMateriality({ client }, materiality, source);
  }

  // Historical memory methods
  async recordFigure(input: RecordFigureInput): Promise<void> {
    await this.historical.recordFigure(input);
  }

  async reasonableness(
    client: string,
    account: string,
    period: string,
    valueCents: number,
    options?: { k?: number; pctThresholdBps?: number },
  ): Promise<ReasonablenessResult> {
    return await this.historical.reasonableness(client, account, period, valueCents, options);
  }

  // Process memory methods
  async saveTemplate(input: SaveTemplateInput): Promise<void> {
    await this.process.saveTemplate(input);
  }

  async findTemplates(input: FindTemplatesInput): Promise<ProcessTemplate[]> {
    return await this.process.findTemplates(input);
  }

  async instantiateTemplate(template: ProcessTemplate, options: { client: string; period: string }): Promise<ProcessTemplate> {
    return await this.process.instantiate(template, options);
  }

  // Learning methods
  async recordCorrection(input: RecordCorrectionInput): Promise<MemoryRecordRef> {
    await this.learning.recordCorrection(input);
    return { recordIds: [] };
  }

  async applyCodingRules(client: string, txn: unknown): Promise<ApplyCodingRulesResult> {
    return await this.learning.applyCodingRules(client, txn);
  }
}

// Export all types and implementations for direct use
export * from './store';
export * from './user';
export * from './semantic';
export * from './historical';
export * from './process';
export * from './learning';
