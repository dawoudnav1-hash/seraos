import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Skill, SkillContext } from './skill';
import { MODEL_TIERS, type ModelTier } from './types';

/**
 * SKILL.md playbooks: YAML-ish frontmatter (the contract) plus markdown
 * sections (the procedure). Agentic skills get a lean slice of it as prompt
 * context; every skill is bound to its playbook by id and version.
 *
 * The frontmatter parser handles only the subset the playbooks use: scalars,
 * block lists, inline `[a, b]` lists, and maps nested one level. Anything else
 * is an error rather than a silent misread.
 */

export class PlaybookError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'PlaybookError';
  }
}

// ---------------------------------------------------------------- frontmatter

export type Scalar = string | number | boolean | null;
export type FrontmatterValue = Scalar | Scalar[] | Record<string, Scalar | Scalar[]>;

function splitInline(inner: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === ',') {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim() || parts.length) parts.push(buf);
  return parts.map((p) => p.trim());
}

export function parseScalar(raw: string, line = 0): Scalar {
  let t = raw.trim();
  const at = line ? ` (line ${line})` : '';
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) throw new PlaybookError(`Unterminated double-quoted string${at}.`);
    try {
      return JSON.parse(t) as string;
    } catch {
      throw new PlaybookError(`Invalid double-quoted string${at}.`);
    }
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new PlaybookError(`Unterminated single-quoted string${at}.`);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t === '|' || t === '>' || t.startsWith('{') || t.startsWith('&') || t.startsWith('*')) {
    throw new PlaybookError(`Unsupported YAML syntax "${t}"${at}; use plain scalars, lists and one-level maps.`);
  }
  // Unquoted scalars may carry a trailing comment, as in YAML.
  t = t.replace(/\s+#.*$/, '');
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~' || t === '') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function parseValue(raw: string, line: number): Scalar | Scalar[] {
  const t = raw.trim();
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new PlaybookError(`Unterminated inline list (line ${line}).`);
    const inner = t.slice(1, -1).trim();
    return inner ? splitInline(inner).map((p) => parseScalar(p, line)) : [];
  }
  return parseScalar(t, line);
}

const KEY_RE = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;

export function parseFrontmatter(text: string): Record<string, FrontmatterValue> {
  const lines = text.split(/\r?\n/);
  const out: Record<string, FrontmatterValue> = {};
  const skippable = (l: string) => l.trim() === '' || /^\s*#/.test(l);
  const indentOf = (l: string) => l.length - l.trimStart().length;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineNo = i + 1;
    if (skippable(line)) {
      i++;
      continue;
    }
    if (/^\s*\t/.test(line)) throw new PlaybookError(`Tabs are not allowed for indentation (line ${lineNo}).`);
    if (indentOf(line) > 0) throw new PlaybookError(`Unexpected indentation (line ${lineNo}).`);
    const m = KEY_RE.exec(line);
    if (!m) throw new PlaybookError(`Expected "key: value" (line ${lineNo}).`);
    const [, key, rest] = m;
    if (key in out) throw new PlaybookError(`Duplicate key "${key}" (line ${lineNo}).`);
    i++;
    if (rest !== undefined && rest.trim() !== '') {
      out[key] = parseValue(rest, lineNo);
      continue;
    }

    // Block value: the indented lines that follow.
    const block: { text: string; indent: number; line: number }[] = [];
    while (i < lines.length && (skippable(lines[i]) || indentOf(lines[i]) > 0)) {
      if (!skippable(lines[i])) {
        if (/^\s*\t/.test(lines[i])) throw new PlaybookError(`Tabs are not allowed for indentation (line ${i + 1}).`);
        block.push({ text: lines[i].trim(), indent: indentOf(lines[i]), line: i + 1 });
      }
      i++;
    }
    if (block.length === 0) {
      out[key] = null;
      continue;
    }
    const indent = block[0].indent;
    const deeper = block.find((b) => b.indent !== indent);
    if (deeper) throw new PlaybookError(`Nesting deeper than one level is not supported (line ${deeper.line}).`);

    if (block[0].text.startsWith('-')) {
      out[key] = block.map((b) => {
        if (!/^-(\s|$)/.test(b.text)) throw new PlaybookError(`Mixed list and map entries under "${key}" (line ${b.line}).`);
        const v = parseValue(b.text.slice(1), b.line);
        if (Array.isArray(v)) throw new PlaybookError(`Nested lists are not supported (line ${b.line}).`);
        return v;
      });
    } else {
      const map: Record<string, Scalar | Scalar[]> = {};
      for (const b of block) {
        const mm = KEY_RE.exec(b.text);
        if (!mm) throw new PlaybookError(`Expected "key: value" under "${key}" (line ${b.line}).`);
        if (mm[2] === undefined || mm[2].trim() === '') {
          throw new PlaybookError(`Nesting deeper than one level is not supported (line ${b.line}).`);
        }
        if (mm[1] in map) throw new PlaybookError(`Duplicate key "${key}.${mm[1]}" (line ${b.line}).`);
        map[mm[1]] = parseValue(mm[2], b.line);
      }
      out[key] = map;
    }
  }
  return out;
}

// ---------------------------------------------------------------- body

export function splitSkillFile(source: string): { frontmatter: string; body: string } {
  const text = source.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) throw new PlaybookError('Missing frontmatter: the file must start with a "---" block.');
  return { frontmatter: m[1], body: m[2] };
}

/** Level-2 headings split the body; deeper headings stay inside their section. */
export function parseSections(body: string): { title?: string; sections: Record<string, string> } {
  const sections: Record<string, string> = {};
  let title: string | undefined;
  let current: string | null = null;
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    if (current !== null) sections[current] = buf.join('\n').trim();
    buf = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h2 = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    const h1 = !inFence && /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2) {
      flush();
      current = h2[1];
    } else if (h1 && current === null && title === undefined) {
      title = h1[1];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return { title, sections };
}

// ---------------------------------------------------------------- playbook

const REQUIRED_SECTIONS = {
  purpose: 'Purpose',
  procedure: 'Procedure',
  decisionRules: 'Decision rules',
  guardrails: 'Guardrails',
  errorHandling: 'Error handling',
} as const;

type SectionKey = keyof typeof REQUIRED_SECTIONS;

const stringList = z.array(z.string().min(1));
const describedNames = z.union([
  z.record(z.string()),
  stringList.transform((names) => Object.fromEntries(names.map((n) => [n, '']))),
]);

const frontmatterSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be kebab-case'),
    version: z.string({ invalid_type_error: 'version must be a string such as 1.0.0 (quote it if needed)' }).regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'version must be semver'),
    name: z.string().min(1),
    description: z.string().min(1),
    category: z.string().min(1),
    triggers: stringList.min(1),
    negative_triggers: stringList.default([]),
    inputs: describedNames,
    outputs: describedNames,
    success_criteria: stringList.min(1),
    failure_conditions: stringList.default([]),
    confidence_threshold: z.number().min(0).max(1),
    human_review_threshold: z.union([
      z.number().min(0).max(1).transform((n) => ({ confidence_below: n, when_material: false })),
      z.object({ confidence_below: z.number().min(0).max(1), when_material: z.boolean().default(false) }).strict(),
    ]),
    model: z.enum(MODEL_TIERS),
    tools: stringList.default([]),
  })
  .strict();

export interface Playbook {
  id: string;
  version: string;
  name: string;
  description: string;
  category: string;
  triggers: string[];
  negativeTriggers: string[];
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  successCriteria: string[];
  failureConditions: string[];
  /** Below this, a result counts as failing verification (retry, then escalate). */
  confidenceThreshold: number;
  /** Results below this confidence, or material ones when `whenMaterial`, go to a human. */
  humanReviewThreshold: { confidenceBelow: number; whenMaterial: boolean };
  model: ModelTier;
  tools: string[];
  title?: string;
  sections: Record<SectionKey, string>;
  /** Any further `##` sections (examples, references), by heading. */
  extraSections: Record<string, string>;
  path?: string;
}

export function parsePlaybook(source: string, path?: string): Playbook {
  try {
    const { frontmatter, body } = splitSkillFile(source);
    const parsed = frontmatterSchema.safeParse(parseFrontmatter(frontmatter));
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(frontmatter)'}: ${i.message}`).join('; ');
      throw new PlaybookError(`Invalid frontmatter: ${detail}`);
    }
    const fm = parsed.data;
    const { title, sections: raw } = parseSections(body);
    const byLower = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), { heading: k, text: v }]));
    const missing = Object.values(REQUIRED_SECTIONS).filter((h) => !byLower.get(h.toLowerCase())?.text);
    if (missing.length) throw new PlaybookError(`Missing or empty sections: ${missing.join(', ')}.`);
    const sections = Object.fromEntries(
      (Object.entries(REQUIRED_SECTIONS) as [SectionKey, string][]).map(([k, h]) => [k, byLower.get(h.toLowerCase())!.text]),
    ) as Record<SectionKey, string>;
    const required = new Set(Object.values(REQUIRED_SECTIONS).map((h) => h.toLowerCase()));
    const extraSections = Object.fromEntries(Object.entries(raw).filter(([k]) => !required.has(k.toLowerCase())));
    return {
      id: fm.id,
      version: fm.version,
      name: fm.name,
      description: fm.description,
      category: fm.category,
      triggers: fm.triggers,
      negativeTriggers: fm.negative_triggers,
      inputs: fm.inputs,
      outputs: fm.outputs,
      successCriteria: fm.success_criteria,
      failureConditions: fm.failure_conditions,
      confidenceThreshold: fm.confidence_threshold,
      humanReviewThreshold: { confidenceBelow: fm.human_review_threshold.confidence_below, whenMaterial: fm.human_review_threshold.when_material },
      model: fm.model,
      tools: fm.tools,
      title,
      sections,
      extraSections,
      path,
    };
  } catch (err) {
    if (err instanceof PlaybookError && !err.path && path) throw new PlaybookError(err.message, path);
    throw err;
  }
}

// ---------------------------------------------------------------- registry

export class PlaybookRegistry {
  private readonly byId = new Map<string, Playbook>();

  constructor(playbooks: Iterable<Playbook> = []) {
    for (const p of playbooks) {
      if (this.byId.has(p.id)) throw new PlaybookError(`Duplicate playbook id "${p.id}".`, p.path);
      this.byId.set(p.id, p);
    }
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  find(id: string): Playbook | undefined {
    return this.byId.get(id);
  }

  get(id: string): Playbook {
    const p = this.byId.get(id);
    if (!p) throw new PlaybookError(`No playbook with id "${id}".`);
    return p;
  }

  list(): Playbook[] {
    return [...this.byId.values()];
  }

  /** Playbooks a request triggers: any trigger phrase present and no negative trigger. */
  match(text: string): Playbook[] {
    const t = text.toLowerCase();
    return this.list().filter(
      (p) => p.triggers.some((x) => t.includes(x.toLowerCase())) && !p.negativeTriggers.some((x) => t.includes(x.toLowerCase())),
    );
  }

  context(id: string, maxChars?: number): string {
    return playbookContext(this.get(id), maxChars);
  }
}

/** Reads every `<dir>/<skill-id>/SKILL.md`. The folder name must equal the playbook id. */
export function loadPlaybooks(dir: string): PlaybookRegistry {
  if (!existsSync(dir)) throw new PlaybookError(`Playbook directory not found: ${dir}`);
  const playbooks: Playbook[] = [];
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const folder of folders) {
    const file = join(dir, folder, 'SKILL.md');
    if (!existsSync(file)) continue;
    const p = parsePlaybook(readFileSync(file, 'utf8'), file);
    if (p.id !== folder) throw new PlaybookError(`Folder "${folder}" holds playbook id "${p.id}"; they must match.`, file);
    playbooks.push(p);
  }
  return new PlaybookRegistry(playbooks);
}

let defaultRegistry: PlaybookRegistry | null = null;

/** The repo's `skills/` directory, loaded once on first use. */
export function defaultPlaybooks(): PlaybookRegistry {
  defaultRegistry ??= loadPlaybooks(join(process.cwd(), 'skills'));
  return defaultRegistry;
}

// ---------------------------------------------------------------- binding

const norm = (k: string) => k.replace(/[_-]/g, '').toLowerCase();

function compareKeys(what: string, declared: Record<string, string>, schema: z.ZodTypeAny): string[] {
  if (!(schema instanceof z.ZodObject)) return [];
  const shape = Object.keys(schema.shape as Record<string, unknown>).map(norm);
  const names = Object.keys(declared).map(norm);
  const problems: string[] = [];
  const undeclared = Object.keys(schema.shape as Record<string, unknown>).filter((k) => !names.includes(norm(k)));
  const unimplemented = Object.keys(declared).filter((k) => !shape.includes(norm(k)));
  if (undeclared.length) problems.push(`${what} not in the playbook: ${undeclared.join(', ')}`);
  if (unimplemented.length) problems.push(`playbook ${what} missing from the schema: ${unimplemented.join(', ')}`);
  return problems;
}

/**
 * Binds an implementation to its playbook. Ids, versions and model tier must
 * match, and object schemas must implement exactly the declared inputs and
 * outputs (snake_case and camelCase compare equal). The bound skill sees its
 * playbook as `ctx.playbook`.
 */
export function bindSkill<I, O>(playbook: Playbook, skill: Skill<I, O>): Skill<I, O> {
  const problems: string[] = [];
  if (playbook.id !== skill.id) problems.push(`id ${skill.id} ≠ playbook ${playbook.id}`);
  if (playbook.version !== skill.version) problems.push(`version ${skill.version} ≠ playbook ${playbook.version}`);
  if (playbook.model !== skill.model) problems.push(`model ${skill.model} ≠ playbook ${playbook.model}`);
  problems.push(...compareKeys('inputs', playbook.inputs, skill.input), ...compareKeys('outputs', playbook.outputs, skill.output));
  if (problems.length) throw new PlaybookError(`Cannot bind skill ${skill.id}: ${problems.join('; ')}.`, playbook.path);
  const run = (ctx: SkillContext, input: I) => skill.run({ ...ctx, playbook }, input);
  return Object.freeze({ ...skill, playbook, run });
}

// ---------------------------------------------------------------- prompt context

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  const lines = text.split('\n');
  const kept: string[] = [];
  let len = 0;
  for (const line of lines) {
    const add = (kept.length ? 1 : 0) + line.length;
    if (len + add + 2 > max) break; // room for "\n…"
    kept.push(line);
    len += add;
  }
  return kept.length ? `${kept.join('\n')}\n…` : `${text.slice(0, max - 1)}…`;
}

/**
 * The lean prompt slice for an agentic skill: frontmatter essentials, then the
 * procedure, then guardrails. Never longer than `maxChars`. As space runs short
 * it gives up, in order: procedure detail, input/output descriptions (names
 * stay), the procedure, the criteria lines, then guardrail detail.
 */
export function playbookContext(source: string | Playbook, maxChars = 4000, registry?: PlaybookRegistry): string {
  const p = typeof source === 'string' ? (registry ?? defaultPlaybooks()).get(source) : source;
  const described = (r: Record<string, string>) => Object.entries(r).map(([k, v]) => (v ? `${k} (${v})` : k)).join('; ');
  const names = (r: Record<string, string>) => Object.keys(r).join(', ');
  const review = `confidence < ${p.humanReviewThreshold.confidenceBelow}${p.humanReviewThreshold.whenMaterial ? ' or the result is material' : ''}`;
  const head = (list: (r: Record<string, string>) => string) =>
    [
      `Skill: ${p.name} (${p.id}@${p.version}, model: ${p.model})`,
      `Purpose: ${p.description}`,
      `Inputs: ${list(p.inputs)}`,
      `Outputs: ${list(p.outputs)}`,
      `Success criteria: ${p.successCriteria.join('; ')}`,
      p.failureConditions.length ? `Stop and escalate if: ${p.failureConditions.join('; ')}` : '',
      `Minimum confidence: ${p.confidenceThreshold}. Route to human review when ${review}.`,
      p.tools.length ? `Tools: ${p.tools.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  const guardLabel = '\n\n## Guardrails\n';
  const procLabel = '\n\n## Procedure\n';
  const guard = `${guardLabel}${p.sections.guardrails}`;
  const fullHead = head(described);
  const full = `${fullHead}${procLabel}${p.sections.procedure}${guard}`;
  if (full.length <= maxChars) return full;

  // Guardrails outrank procedure detail, and procedure outranks field descriptions.
  const compactHead = head(names);
  for (const [h, minProc] of [[fullHead, 400], [compactHead, 80]] as const) {
    const room = maxChars - h.length - procLabel.length - guard.length;
    if (room >= minProc) return `${h}${procLabel}${clip(p.sections.procedure, room)}${guard}`;
  }
  for (const h of [compactHead, `${fullHead.split('\n').slice(0, 2).join('\n')}\nRoute to human review when ${review}.`]) {
    const room = maxChars - h.length - guardLabel.length;
    if (room >= 120) return `${h}${guardLabel}${clip(p.sections.guardrails, room)}`;
  }
  return clip(compactHead, maxChars);
}
