# Skills

Every capability in `lib/graph/catalog.ts` is a skill, and every skill is driven
by a `SKILL.md` playbook in this directory. The playbook is the contract and the
procedure; the TypeScript implementation (`defineSkill` in `lib/graph/skill.ts`)
is bound to it at startup with `bindSkill`, which refuses to bind when the id,
version, model tier, or declared inputs/outputs disagree.

`skills/fixed-asset-depreciation/SKILL.md` is the reference example.

## Layout

```
skills/
  <skill-id>/
    SKILL.md
```

The folder name must equal the playbook `id`. `loadPlaybooks('skills')` reads
every `*/SKILL.md` into a registry.

## Frontmatter

The file starts with a `---` block. The parser (`lib/graph/playbook.ts`)
supports a small YAML subset and rejects anything else rather than misreading it:

- `key: value` scalars: strings (plain, `"double"` or `'single'` quoted),
  numbers, `true`/`false`, `null`
- block lists (`- item` lines) and inline lists (`[a, b]`)
- maps nested one level (`key:` followed by indented `name: value` lines)
- full-line `#` comments; no tabs, anchors, flow maps or block scalars (`|`, `>`)

Versions must be full semver (`1.0.0`), which the parser keeps as a string.

| Field | Type | Meaning |
|---|---|---|
| `id` | kebab-case string | Matches the catalog id, the folder name and the implementation |
| `version` | semver string | Bump on any behaviour change; it keys the replay cache |
| `name` | string | Human name |
| `description` | string | One sentence: what it produces |
| `category` | string | Catalog family, e.g. `schedules` |
| `triggers` | list | Phrases that route a request here |
| `negative_triggers` | list, optional | Phrases that rule it out even when a trigger matches |
| `inputs` | map `name: description` (or list of names) | Must match the input schema's keys (snake_case = camelCase) |
| `outputs` | map `name: description` (or list of names) | Must match the output schema's keys |
| `success_criteria` | list | What verification checks; each should map to a check |
| `failure_conditions` | list, optional | When to stop and escalate instead of producing output |
| `confidence_threshold` | 0–1 | Below this, a result counts as failing verification (retry, then escalate) |
| `human_review_threshold` | 0–1, or map `confidence_below`, `when_material` | When a passing result still goes to a human |
| `model` | `none` \| `small` \| `frontier` | Must equal the implementation's tier |
| `tools` | list, optional | Tools the skill calls |

Model tiers follow the routing rule: `none` for computation, matching, posting
and parsing; `small` for extraction, OCR and categorization fallback;
`frontier` only for planning, ambiguity and narrative. A deterministic skill
must use `none`; an agentic skill must not.

## Body

Level-2 headings split the body. Five sections are required, in any order:

- `## Purpose` — what the skill is for and what it must never do
- `## Procedure` — numbered steps, the way a preparer would do the work
- `## Decision rules` — the accounting policy choices, stated so they can be tested
- `## Guardrails` — hard limits; these survive prompt trimming first
- `## Error handling` — what to do when data is missing, checks fail or ties break

Other `##` sections (examples, references) are kept as `extraSections`.

## Prompt context

Agentic skills do not get the whole file. `playbookContext(id, maxChars)` returns
a lean slice: the frontmatter essentials (purpose, inputs, outputs, success
criteria, escalation rules, tools), then the procedure, then the guardrails. It
never exceeds `maxChars`; when space runs short the procedure is trimmed before
the guardrails. A bound skill also sees its playbook as `ctx.playbook`.

## Writing a new skill

1. Add the catalog entry (if missing) in `lib/graph/catalog.ts`.
2. Write `skills/<id>/SKILL.md` with the fields and sections above.
3. Implement it with `defineSkill` using the same id, version and model, and Zod
   schemas whose keys match `inputs` and `outputs`.
4. `bindSkill(registry.get(id), implementation)` and add golden-fixture tests.
