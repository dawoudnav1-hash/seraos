import Anthropic from '@anthropic-ai/sdk';
import { finalizeEvent } from '../confidence';
import { SPECIALIST_REGISTRY } from '../specialists';
import type { AgentInput, AgentProvider } from '../provider';
import type { AgentEvent, SpecialistName, Step, ToolName } from '@/lib/domain/types';

const MODEL = 'claude-opus-5';

const PLAN_TOOL: Anthropic.Tool = {
  name: 'submit_plan',
  description: 'Break the task into ordered steps before doing any work. Call this exactly once, first.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['steps'],
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'tools'],
          properties: {
            title: { type: 'string' },
            tools: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  strict: true,
};

const RESULT_TOOL: Anthropic.Tool = {
  name: 'submit_result',
  description:
    'Hand the work in. Report your confidence honestly — work below the confidence floor routes to a human instead of to review.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'confidence', 'openQuestions'],
    properties: {
      summary: { type: 'string' },
      confidence: { type: 'number' },
      openQuestions: { type: 'array', items: { type: 'string' } },
    },
  },
  strict: true,
};

const BLOCK_TOOL: Anthropic.Tool = {
  name: 'raise_blocker',
  description: 'Stop and ask a human when something you cannot obtain yourself is missing.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'title', 'detail', 'resolutionKind', 'resolutionLabel'],
    properties: {
      reason: { type: 'string', enum: ['missing_document', 'approval_required', 'policy_decision', 'low_confidence'] },
      title: { type: 'string' },
      detail: { type: 'string' },
      resolutionKind: { type: 'string', enum: ['upload_file', 'confirm', 'answer_question', 'approve'] },
      resolutionLabel: { type: 'string' },
    },
  },
  strict: true,
};

/** Schemas the model sees for the real tools. The orchestrator still executes them. */
const TOOL_SCHEMAS: Record<ToolName, Anthropic.Tool['input_schema']> = {
  fetchTrialBalance: { type: 'object', properties: { period: { type: 'string' } } },
  fetchSubledger: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  parseDocument: { type: 'object', required: ['document'], properties: { document: { type: 'string' } } },
  postJournalEntry: {
    type: 'object',
    required: ['memo', 'lines'],
    properties: {
      memo: { type: 'string' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: { account: { type: 'string' }, debitCents: { type: 'number' }, creditCents: { type: 'number' } },
        },
      },
    },
  },
  buildWorkbook: {
    type: 'object',
    required: ['filename', 'sheets'],
    properties: {
      filename: { type: 'string' },
      sheets: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array' } } },
        },
      },
    },
  },
  renderPdf: {
    type: 'object',
    required: ['filename', 'title', 'body'],
    properties: { filename: { type: 'string' }, title: { type: 'string' }, body: { type: 'array', items: { type: 'string' } } },
  },
  requestHumanInput: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
};

/** The real thing, behind the same interface as MockProvider. */
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async *runAgent(input: AgentInput): AsyncIterable<AgentEvent> {
    const spec = SPECIALIST_REGISTRY[input.specialist];
    const tools: Anthropic.Tool[] = [
      PLAN_TOOL,
      RESULT_TOOL,
      BLOCK_TOOL,
      ...spec.tools.map((name) => ({
        name,
        description: `Vert tool: ${name}.`,
        input_schema: TOOL_SCHEMAS[name],
      })),
    ];

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content:
          `Task: ${input.title}\n\n${input.task}` +
          (input.instruction ? `\n\nReviewer feedback to address: ${input.instruction}` : '') +
          (input.resolvedBlockerIds?.length ? '\n\nThe blocker that stopped you has been resolved by a human; continue.' : '') +
          '\n\nPlan first with submit_plan, then work the steps, then hand in with submit_result.',
      },
    ];

    let steps: Step[] = [];
    let stepIndex = 0;
    const currentStepId = () => steps[Math.min(stepIndex, Math.max(0, steps.length - 1))]?.id ?? `${input.runId}_s1`;

    for (let turn = 0; turn < 24; turn++) {
      const stream = this.client.messages.stream({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        system: `${spec.systemPrompt}\n\nYou are a Vert specialist agent. You never post to the ledger without human approval.`,
        tools,
        messages,
      });
      const message = await stream.finalMessage();
      messages.push({ role: 'assistant', content: message.content });

      if (message.stop_reason === 'refusal') {
        yield { type: 'run_failed', error: 'The model declined this request.' };
        return;
      }

      const calls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (calls.length === 0) {
        const text = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
        yield { type: 'run_completed', summary: text.slice(0, 400) || 'Work complete.' };
        return;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const args = call.input as Record<string, unknown>;

        if (call.name === 'submit_plan') {
          steps = (args.steps as { title: string; tools: string[] }[]).map((s, i) => ({
            id: `${input.runId}_s${i + 1}`,
            title: s.title,
            agent: input.specialist as SpecialistName,
            tools: s.tools.filter((t): t is ToolName => spec.tools.includes(t as ToolName)),
            status: 'pending',
          }));
          yield { type: 'plan_created', steps };
          yield { type: 'step_started', stepId: currentStepId(), agent: input.specialist };
          results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Plan recorded. Begin step 1.' });
          continue;
        }

        if (call.name === 'raise_blocker') {
          yield {
            type: 'blocked',
            blocker: {
              id: `blk_${input.runId}_${call.id}`,
              stepId: currentStepId(),
              reason: args.reason as 'missing_document',
              title: args.title as string,
              detail: args.detail as string,
              resolution: { kind: args.resolutionKind as 'upload_file', label: args.resolutionLabel as string },
            },
          };
          return;
        }

        if (call.name === 'submit_result') {
          for (const step of steps.slice(stepIndex)) yield { type: 'step_completed', stepId: step.id };
          yield finalizeEvent({
            runId: input.runId,
            stepId: currentStepId(),
            summary: args.summary as string,
            confidence: Number(args.confidence),
            openQuestions: (args.openQuestions as string[]) ?? [],
          });
          return;
        }

        const tool = call.name as ToolName;
        if (!spec.tools.includes(tool)) {
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `${tool} is not available to you.` });
          continue;
        }

        const stepId = currentStepId();
        yield { type: 'tool_called', stepId, tool, args, toolCallId: call.id };
        try {
          const result = await input.callTool(stepId, tool, args);
          yield { type: 'tool_result', stepId, ok: result.ok, summary: result.summary, toolCallId: call.id, provenance: result.provenance };
          yield { type: 'progress', stepId, pct: Math.round(((stepIndex + 1) / Math.max(1, steps.length)) * 100), note: result.summary };
          if (result.ok && (tool === 'buildWorkbook' || tool === 'renderPdf')) {
            const data = result.data as { url: string; sizeBytes: number };
            const filename = String(args.filename);
            yield {
              type: 'artifact_created',
              artifact: {
                id: `art_${input.runId}_${filename}`,
                filename,
                kind: filename.endsWith('.pdf') ? 'pdf' : filename.endsWith('.csv') ? 'csv' : filename.endsWith('.docx') ? 'docx' : 'xlsx',
                sizeBytes: data.sizeBytes,
                url: data.url,
                generatedBy: input.specialist,
              },
            };
          }
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            is_error: !result.ok,
            content: `${result.summary}\n${JSON.stringify(result.data).slice(0, 6000)}`,
          });
          if (stepIndex < steps.length - 1) {
            yield { type: 'step_completed', stepId };
            stepIndex++;
            yield { type: 'step_started', stepId: currentStepId(), agent: input.specialist };
          }
        } catch (err) {
          const message_ = err instanceof Error ? err.message : String(err);
          yield { type: 'tool_result', stepId, ok: false, summary: message_, toolCallId: call.id };
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: message_ });
        }
      }
      messages.push({ role: 'user', content: results });
    }

    yield { type: 'run_failed', error: 'The agent did not finish within its turn budget.' };
  }
}
