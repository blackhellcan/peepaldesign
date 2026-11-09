// Codemods (Phase 7): turn a GapScan report's renames into rules, dry-run them on the
// application's code, and package the same rewriter as a script people run themselves.
// Only confirmed matches are included; anything that can't be rewritten safely is listed
// for a person instead of guessed at. Nothing here executes the application's code.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {pairOption} from '@gapscan/gapscan';
import {targetsFor} from '@gapscan/usage';
import type {CodemodBinding} from '@gapscan/library';
import type {ComponentObservation, ExtractedDesignSystem, GapScanReport, ReferenceDS, UsageReport} from '@gapscan/schema';
import {transformFile, shouldVisit} from './transform.ts';
import type {ClassRule, CodemodRules, ComponentRule, JsxRule, ManualEdit, OptionRule} from './transform.ts';
import {unifiedDiff} from './diff.ts';

export {transformFile, shouldVisit, unifiedDiff};
export type {CodemodRules, ComponentRule, ManualEdit};

type Option = {prop: string; value: string};
// TypeScript-read variants are `color=primary` or a bare `variant` value; sizes belong to `size`.
const optionsOf = (c: ComponentObservation, bare: string): Option[] => [
  ...c.variants.map(v => { const m = v.name.match(/^([\w-]+)=(.+)$/); return m ? {prop: m[1]!, value: m[2]!} : {prop: bare, value: v.name}; }),
  ...c.sizes.map(value => ({prop: 'size', value})),
];
// Paired exactly as GapScan's diff pairs them, so the rewrite matches the report.
function mapOption(option: Option, targets: Option[]): Option | null {
  const key = (o: Option) => `${o.prop}=${o.value}`, paired = pairOption(key(option), targets.map(key));
  return paired ? targets.find(t => key(t) === paired.option) ?? null : null;
}

export type CodemodPlan = {rules: CodemodRules; notes: string[]; hash: string};
export type PlanInput = {report: GapScanReport; source: ExtractedDesignSystem; reference: ReferenceDS; usage: UsageReport | null; binding: CodemodBinding};

export function buildPlan({report, source, reference, usage, binding}: PlanInput): CodemodPlan {
  const components: ComponentRule[] = [], notes: string[] = [];
  const usageOf = new Map((usage?.components ?? []).map(u => [u.component, u]));
  if (!usage) notes.push('Your application code has not been scanned, so component imports are unknown and only class names can be rewritten. Scan it first.');
  for (const item of report.items) {
    if (item.decision === 'optional') continue;
    const component = source.components.find(c => c.id === item.match.sourceId), used = usageOf.get(item.name)?.usages ?? 0;
    const target = reference.components.find(c => c.id === item.match.targetId);
    if (!component) continue;
    if (!target) { if (used) notes.push(`${item.name} (${used} uses) has no counterpart in ${reference.library}; those call sites need rewriting by hand.`); continue; }
    if (item.match.status !== 'confirmed') { if (used) notes.push(`${item.name} → ${target.canonical} is a suggested match; approve it to include its ${used} uses.`); continue; }
    const rule: ComponentRule = {component: component.canonical, target: target.canonical};

    const imports = usageOf.get(item.name)?.imports.filter(m => m !== 'custom element') ?? [];
    if (imports.length) {
      // 'all': the package re-exports every component the reference read (Fluent's react-components).
      const exportName = binding.package || binding.modulePattern ? target.rawNames.find(n => binding.exports === 'all' ? /^[A-Z][A-Za-z0-9]*$/.test(n) : binding.exports?.includes(n)) ?? null : null;
      // Per-file libraries (shadcn) import each component from its own module: Button → @/components/ui/button.
      // The reference records which file each component came from (sonner.tsx holds Toaster).
      const sourceFile = reference.evidence.find(e => target.evidence.includes(e.id))?.locator.match(/([\w-]+)\.[jt]sx?\b/)?.[1];
      const fileOf = (n: string) => sourceFile ?? n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
      const targetModule = binding.package ?? (binding.modulePattern && exportName ? binding.modulePattern.replace('{file}', fileOf(exportName)) : undefined);
      const alreadyThere = targetModule !== undefined && imports.every(m => m === targetModule || m.startsWith(targetModule + '/'));
      if (exportName || alreadyThere) {
        const sourceOptions = optionsOf(component, 'variant'), targetOptions = optionsOf(target, 'variant');
        const options: OptionRule[] = sourceOptions.map(o => { const t = mapOption(o, targetOptions); return {prop: o.prop, value: o.value, toProp: t?.prop ?? null, toValue: t?.value ?? null}; });
        const props: Record<string, string> = {}, manualProps: string[] = [];
        for (const d of item.diffs) {
          if (d.driver === 'prop_rename' && typeof d.before === 'string' && typeof d.after === 'string') props[d.before] = d.after;
          if (d.driver === 'prop_semantic' && typeof d.before === 'string') manualProps.push(d.before);
        }
        const jsx: JsxRule = {names: [...(targetsFor([component])[0]?.tagNames ?? [])], modules: imports, package: exportName && targetModule ? targetModule : null, exportName,
          props, options, optionProps: [...new Set(options.map(o => o.prop))], manualProps,
          targetValues: Object.fromEntries((target.props ?? []).filter(p => p.values?.length).map(p => [p.name, p.values!]))};
        rule.jsx = jsx;
      } else notes.push(`${item.name} (${used} uses): ${target.canonical} is not published as an importable ${reference.library} component GapScan can name, so imports and markup change by hand.`);
    }

    const base = component.rawNames.find(n => /^[a-z][\w-]*$/.test(n)), targetBase = target.rawNames.find(n => /^[a-z][\w-]*$/.test(n));
    if (base && usageOf.get(item.name)?.usages !== 0) {
      if (binding.classes && targetBase) {
        const {style, prefix, separator} = binding.classes, to = prefix + targetBase;
        const classFor = (value: string) => style === 'chained' ? `${separator}${value}` : `${to}${separator}${value}`;
        const map: Record<string, string> = {[base]: to};
        const targetOptions = [...target.variants.map(v => v.name), ...target.sizes].filter(v => !v.includes('=')).map(value => ({prop: 'class', value}));
        for (const value of [...component.variants.map(v => v.name), ...component.sizes].filter(v => !v.includes('='))) {
          const t = mapOption({prop: 'class', value}, targetOptions);
          if (t) for (const sep of ['-', '--']) map[`${base}${sep}${value}`] = classFor(t.value);
        }
        rule.classes = {map, watch: [base]} satisfies ClassRule;
      } else if (usage && Object.keys(usageOf.get(item.name)?.propUsages ?? {}).some(p => p.startsWith('class:')) || !usage && !imports.length)
        notes.push(`${item.name}: ${reference.library} classes can't be derived from its stylesheet reliably, so “${base}” classes change by hand.`);
    }
    if (rule.jsx || rule.classes) components.push(rule);
  }
  const rules: CodemodRules = {version: 1, reference: report.reference.id, components};
  return {rules, notes, hash: createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 16)};
}

export type SourceFile = {path: string; content: string};
export type CodemodFileResult = {path: string; changes: number; diff: string; manual: ManualEdit[]};
export type DryRun = {files: CodemodFileResult[]; totals: {filesRead: number; filesChanged: number; changes: number; manual: number}};

export function dryRun(files: readonly SourceFile[], rules: CodemodRules): DryRun {
  const results: CodemodFileResult[] = [];
  let read = 0;
  for (const file of files) {
    if (!shouldVisit(file.path)) continue;
    read++;
    const result = transformFile(file.path, file.content, rules);
    if (result.changes || result.manual.length) results.push({path: file.path, changes: result.changes, diff: unifiedDiff(file.path, file.content, result.output), manual: result.manual});
  }
  results.sort((a, b) => a.path.localeCompare(b.path));
  return {files: results, totals: {filesRead: read, filesChanged: results.filter(f => f.changes).length, changes: results.reduce((n, f) => n + f.changes, 0), manual: results.reduce((n, f) => n + f.manual.length, 0)}};
}

// The downloadable script: the rewriter and diff above, types stripped, plus a small CLI.
// Dry run by default; --write applies it. It loads TypeScript from the project it runs in.
const strip = async (file: string) => ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false}}).outputText
  .replace(/^import \w+ from ["']typescript["'];?\s*$/m, '').replace(/^export \{\};?\s*$/m, '').replace(/^\/\/# sourceMappingURL.*$/m, '');

export async function buildScript(plan: CodemodPlan, meta: {reportId: string; library: string; version: string; generatedAt: string}): Promise<string> {
  const [transform, diff] = await Promise.all([strip('./transform.ts'), strip('./diff.ts')]);
  return `#!/usr/bin/env node
// GapScan codemod: your components → ${meta.library} ${meta.version}
// Generated ${meta.generatedAt} from GapScan report ${meta.reportId}; rules ${plan.hash}.
// Review the diff before committing. Call sites it can't rewrite safely are listed, not changed.
//
// Run from your repository root (it uses your project's own \`typescript\` package):
//   node gapscan-codemod.mjs [paths…]          dry run: prints the diff and the manual list
//   node gapscan-codemod.mjs [paths…] --write  applies the changes
import {createRequire} from 'node:module';
import {readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {join, relative, sep} from 'node:path';

let ts;
try { ts = createRequire(join(process.cwd(), 'package.json'))('typescript'); }
catch { console.error('This codemod needs the typescript package in your project: npm install --save-dev typescript'); process.exit(1); }

const RULES = ${JSON.stringify(plan.rules, null, 2)};

// ── Rewriter (generated from GapScan's codemod package) ──
${transform.trim()}

// ── Diff ──
${diff.trim()}

// ── CLI ──
const write = process.argv.includes('--write');
const roots = process.argv.slice(2).filter(a => !a.startsWith('--'));
const files = [];
const walk = path => {
  const rel = relative(process.cwd(), path).split(sep).join('/');
  if (/(^|\\/)(node_modules|\\.git)$/.test(rel)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  else if (shouldVisit(rel) && stat.size <= 1_000_000) files.push(rel);
};
for (const root of roots.length ? roots : ['.']) walk(root);
let changed = 0, edits = 0, manual = 0;
for (const file of files) {
  const before = readFileSync(file, 'utf8'), result = transformFile(file, before, RULES);
  if (result.changes) { changed++; edits += result.changes; process.stdout.write(unifiedDiff(file, before, result.output)); if (write) writeFileSync(file, result.output); }
  for (const m of result.manual) { manual++; console.error(\`MANUAL \${file}:\${m.line} \${m.component ? '[' + m.component + '] ' : ''}\${m.reason}\`); }
}
console.error(\`\\n\${files.length} files read; \${edits} edits in \${changed} files\${write ? ' written' : ' (dry run: add --write to apply)'}; \${manual} call sites to change by hand.\`);
`;
}
