# Vert — agentic accounting workspace

AI agents run end-to-end accounting tasks; a finance manager delegates, and only
steps in when an agent is blocked or when finished work needs sign-off.

```bash
npm install
npm run seed     # builds the board's opening state (writes real xlsx/pdf artifacts)
npm run dev      # http://localhost:3000/command
npm test         # orchestrator, state machine and reducer
npm run typecheck
```

## How it fits together

| Layer | Where |
|---|---|
| Run lifecycle (explicit state machine, per-actor edges) | `lib/domain/state-machine.ts` |
| Event log → run projection (the only source of UI state) | `lib/domain/reducer.ts` |
| Orchestrator: drives runs, enforces tool policy and approvals | `lib/agents/orchestrator.ts` |
| Model calls behind one interface | `lib/agents/provider.ts` → `providers/mock.ts`, `providers/claude.ts` |
| Specialists (toolset + system prompt + Zod output) | `lib/agents/specialists/` |
| Tools over a fixture-backed MockERP | `lib/agents/tools/` |
| Persistence (runs, run_events, approvals, ledger_postings) | `lib/db/` |
| SSE fan-out to the board | `app/api/stream/route.ts` |

Runs move `queued → planning → executing → (blocked ⇄ executing) → review_ready →
viewed → approved | rejected → archived`, with `failed` off executing.

## The four rules, and where they are enforced

1. **Nothing posts without approval.** `postJournalEntry` is the only mutating tool;
   `callTool` refuses it without an `approvals` row, and the tool itself re-checks
   (`tests/orchestrator.test.ts` → "will not post a journal entry for an unapproved run").
2. **Every number is traceable.** Tool results carry `Provenance` rows naming the
   step, tool and call; the drawer lists them next to the figure.
3. **Agents say when they are unsure.** `finalizeEvent` routes any run below the
   `CONFIDENCE_FLOOR`, or with open questions, to `blocked` rather than `review_ready`.
4. **Replayable runs.** `getRun` rebuilds a run by folding `run_events`; the client
   only ever renders server projections.

## Swapping in the real model

`MockProvider` is the default and is what the tests use. Set `VERT_PROVIDER=claude`
and `ANTHROPIC_API_KEY` to use `ClaudeProvider` (Claude Opus 5, streaming, tool use).
Tool execution stays in the orchestrator either way, so the allow-list and the
approval gate hold whichever provider is running.
