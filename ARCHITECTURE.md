# Vert agent architecture

Built from the Vert HQ "Agents (Architecture & Skills)" page, "Suggested agent
framework", "Agent architecture optimization" and the Product Roadmap checklist.
The governing idea from those pages: accuracy is an architectural property. The
model does judgment, sequencing and knowing when it is unsure; everything that
must be exact is deterministic code.

## Control flow

```
User request
  │
  ├─ simple question ──► Single query agent ─► ontology + context graph + ledger ─► answer with citations, or "I don't know"
  │
  └─ task ─► Clarification loop (HITL) ─► Planner (frontier model) ─► Graph
                                                                        │
     Graph ── walks a dependency DAG; read-shaped nodes run in parallel, writes run in order
       └─ Workflows ── business logic + compliance gates
            └─ Chains ── predictable sub-processes
                 └─ Skills ── atomic, typed, deterministic where possible (SKILL.md playbook each)
                                                                        │
     Domain sub-agents PROPOSE typed artifacts (JE, rec result, schedule, analysis) — never commit
                                                                        │
     Verification: 1 structural (ontology) → 2 tie-outs (calc engine) → 3 verifier agent (judgment only)
                   → 4 reasonableness (history) ── fail: retry ≤2, then escalate to a human
                                                                        │
     Confidence gate by materiality ─► review (1 or 2 approvals) ─► deterministic posting (QuickBooks / Xero)
                                                                        │
     Audit trail on every retrieval, computation, proposal, check, approval, post
```

## What is needed, and what is not

Decided as an engineer against the capability list (transaction processing,
reconciliations, journal entries, schedules, analysis, documents, workflow reuse).

### Needed now

| Component | Why it is needed | Where |
|---|---|---|
| Graph → Workflows → Chains → Skills runtime | Every capability is a skill; month-end work is a dependency DAG | `lib/graph` |
| Accounting primitives + rules | Money in integer cents, rounding, allocation, double entry, open period, capitalization, materiality. Kills whole error classes in code | `lib/engine/primitives.ts`, `lib/engine/rules.ts` |
| Calculation engine | "The LLM does zero arithmetic" | `lib/engine/calc.ts` |
| Matching engine | Bank, card, GL and Stripe recs, unmatched detection, duplicate checks all reduce to one engine: exact, one-to-many, many-to-one, date and amount tolerance, reference similarity | `lib/engine/matching.ts` |
| Journal entry builder | Nine entry types share one validated builder; evidence attaches to every line | `lib/engine/journal.ts` |
| Schedule / roll-forward engine | Every schedule is opening + additions − reductions = closing, with per-type calculators | `lib/engine/schedules.ts` |
| Analysis engine | Flux, variance, budget vs actual, period over period, waterfall are one comparison engine with thresholds | `lib/engine/analysis.ts` |
| Spreadsheet sandbox | Workpapers are built with real formulas, recomputed and validated (formula checks, totals tie, no broken refs) before hand-in | `lib/engine/sheet.ts` |
| Deterministic capture/parse | CSV/XLSX/PDF text in, typed rows and a data-quality report out; no model | `lib/engine/capture.ts`, `lib/engine/documents.ts` |
| Accounting domain ontology | Concepts, account types, normal balances, entry types, schedules, relations and constraints. Agents call it as a tool (look up, validate, explain) and get the relevant slice as context. It is also the first verification gate | `lib/context/ontology.ts` |
| Context graph built from interaction (Postgres) | Nothing is loaded up front: every retrieval, document, figure, entity and account an agent touches becomes a node, linked to the run, step and source record it came from. Later agents get the subgraph around their task | `lib/context/graph.ts` |
| Layered verification + retry/escalate | Where accuracy actually comes from | `lib/agents/verify.ts` |
| Confidence gate by materiality | Immaterial + all checks pass + ≥ 0.98 → one approval; material or 0.90–0.98 → two approvals; < 0.90 → back to a human with questions | `lib/agents/gate.ts` |
| Memory: process, historical, user, semantic | Process = reusable workflow templates (reuse across engagements). Historical = prior periods for reasonableness and flux. User = answers and preferences that prefill clarifications. Semantic = client facts (vendor → account rules, mappings, materiality) | `lib/memory` |
| Agent learning | Human corrections become rule candidates; promoted to deterministic rules after repeated confirmation | `lib/memory/learning.ts` |
| Model routing | Frontier model only for planning, ambiguity and narrative; small model for extraction/OCR; no model for math, matching or JE construction | `lib/agents/routing.ts` |
| Single query agent | "Ask anything" questions answered from the ledger, ontology and context graph with citations, or "I don't know" | `lib/agents/query.ts` |
| Postgres | Structured platform data users can reference in ad-hoc tasks. Embedded PGlite locally, `DATABASE_URL` for a server | `lib/db` |
| QuickBooks Online + Xero connectors | Pull GL/bank data; post approved JEs and transactions deterministically, idempotently | `lib/integrations` |

### Not needed now

| Component | Why not | Revisit when |
|---|---|---|
| Vector DB / embeddings | The data is structured; retrieval is by key, SQL and graph edges. Embeddings add a fuzzy path to numbers that must be exact | Large unstructured document corpora per client |
| HydraDB as a second datastore | Postgres holds the graph today; `ContextGraph` is an interface so HydraDB can slot in without touching agents | Graph queries outgrow Postgres |
| A separate LLM supervisor agent | The DAG orchestrator is deterministic; an LLM deciding order re-introduces the failure the ontology already solves. Supervision = the graph + verification + escalation | Open-ended research tasks with no known DAG |
| Multi-agent voting / consensus | P2 on the optimization page; verification + gate cover it | Eval shows residual error on material JEs |
| SkillOpt-style auto-rewriting skills | Learning promotes corrections into rules, which is auditable; self-editing procedures are not | Rule volume makes manual promotion the bottleneck |
| ML anomaly detection / ML matching | Rules + statistics (z-score, IQR, tolerances) are explainable and sufficient | Labelled match history exists to train on |
| Per-domain ontologies | Core ontology + per-skill typed schemas cover the current skills | A domain needs concepts the core lacks |
| Semantic layer | Dropped by product decision; client facts live in semantic memory and the context graph | — |
| Local OCR engine | Routed to the vision model through the provider; digital PDFs are parsed deterministically | Offline/on-prem deployments |
| Full eval harness (LLM-as-judge) | Not on the roadmap checklist; golden fixtures per skill run as tests today. **This is the first thing to add next** — the optimization page rates it P0 | Next |
| A2A / MCP inter-agent protocols | One process, one orchestrator | Third-party agents join a workflow |
