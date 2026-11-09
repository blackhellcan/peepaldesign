// Application impact: where the product code uses each design-system component.
// Reads JSX elements (through import aliases) and the props they pass, and class
// names in markup for CSS components. Parses only; nothing is executed.
import ts from 'typescript';
import type {ComponentObservation, ComponentUsage} from '@gapscan/schema';

export type SourceFile = {path: string; content: string};
export const USAGE_LIMITS = Object.freeze({files: 5_000, bytesPerFile: 1_000_000, examples: 5});
const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|html?|hbs|erb|php|astro)$/i;
const SKIP = /(?:^|\/)(?:node_modules|\.git|dist|build|out|coverage|\.next|\.nuxt|vendor|__tests__|__mocks__|storybook-static)\/|\.(?:test|spec|stories)\.[jt]sx?$|\.d\.ts$|\.min\.js$/;
// Route conventions across Next.js, Remix, SvelteKit, Nuxt, Angular, Rails and plain sites.
const SCREEN = /(?:^|\/)(?:pages|app|routes|screens|views|templates)\/(?!(?:.*\/)?(?:components?|ui|lib|utils|hooks)\/)|(?:^|\/)(?:page|route|layout|index)\.[jt]sx?$|Page\.[jt]sx?$|Screen\.[jt]sx?$|\.html?$/;

export const isScannable = (path: string) => CODE.test(path) && !SKIP.test(path);
export const isScreen = (path: string) => SCREEN.test(path);

type Target = {component: string; tagNames: Set<string>; classes: Set<string>; modifiers: RegExp | null};
// Components are matched by their JSX names (Button, MdFilledButton…) and by their class names (btn, btn-primary).
export function targetsFor(components: readonly ComponentObservation[]): Target[] {
  return components.map(c => {
    const tagNames = new Set<string>(), classes = new Set<string>();
    for (const raw of [c.canonical, ...c.rawNames]) {
      const pascal = raw.replace(/(^|[-_\s]+)(\w)/g, (_, __, ch: string) => ch.toUpperCase());
      if (/^[A-Z]/.test(pascal)) tagNames.add(pascal);
      if (/^[a-z][\w-]*$/.test(raw)) { classes.add(raw); tagNames.add(raw.includes('-') ? raw : ''); }
    }
    tagNames.delete('');
    const base = c.rawNames.find(n => /^[a-z][\w-]*$/.test(n));
    return {component: c.canonical, tagNames, classes, modifiers: base ? new RegExp(`^${base.replace(/[-]/g, '\\-')}(?:-|--)[\\w-]+$`) : null};
  });
}

type Hit = {component: string; file: string; line: number; snippet: string; props: string[]; importFrom?: string};

function scanJsx(file: SourceFile, targets: Target[], hits: Hit[]) {
  const kind = /\.tsx$/i.test(file.path) ? ts.ScriptKind.TSX : /\.jsx$/i.test(file.path) ? ts.ScriptKind.JSX : /\.ts$/i.test(file.path) ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, kind);
  // Local name → [component, module], from `import {Button as Btn} from '…'` and default imports.
  const local = new Map<string, {component: string; from: string}>();
  const byTag = new Map<string, string>();
  for (const t of targets) for (const tag of t.tagNames) byTag.set(tag, t.component);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text, clause = statement.importClause;
    if (clause.name) { const c = byTag.get(clause.name.text) ?? byTag.get(from.split('/').pop()!.replace(/\.\w+$/, '')); if (c) local.set(clause.name.text, {component: c, from}); }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) {
      const imported = (el.propertyName ?? el.name).text, c = byTag.get(imported);
      if (c) local.set(el.name.text, {component: c, from});
    }
  }
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const classHits = (text: string, node: ts.Node) => scanClassString(text, targets, file.path, lineOf(node), node.getText(source).slice(0, 120), hits);
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source), resolved = local.get(tag) ?? (byTag.has(tag) && /^[a-z]+-[a-z-]+$/.test(tag) ? {component: byTag.get(tag)!, from: 'custom element'} : undefined);
      if (resolved) {
        const props = node.attributes.properties.flatMap(a => ts.isJsxAttribute(a) ? [a.name.getText(source)] : []);
        hits.push({component: resolved.component, file: file.path, line: lineOf(node), snippet: node.getText(source).slice(0, 120), props, importFrom: resolved.from});
      }
      for (const a of node.attributes.properties) if (ts.isJsxAttribute(a) && /^(className|class)$/.test(a.name.getText(source)) && a.initializer) {
        const text = ts.isStringLiteral(a.initializer) ? a.initializer.text : a.initializer.getText(source);
        classHits(text, a);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

// One element's class list counts once per component; modifier classes are recorded as props (`btn-primary` → `class:primary`).
function scanClassString(text: string, targets: Target[], file: string, line: number, snippet: string, hits: Hit[]) {
  const tokens = text.split(/[^\w-]+/).filter(Boolean);
  for (const t of targets) {
    const base = tokens.some(tok => t.classes.has(tok)), mods = t.modifiers ? tokens.filter(tok => t.modifiers!.test(tok)) : [];
    if (base || mods.length) hits.push({component: t.component, file, line, snippet, props: mods.map(m => `class:${m.replace(/^[a-z]+(?:-|--)/, '')}`)});
  }
}

function scanMarkup(file: SourceFile, targets: Target[], hits: Hit[]) {
  const lines = file.content.split('\n');
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/\bclass(?:Name)?\s*=\s*["']([^"']+)["']/g)) scanClassString(m[1]!, targets, file.path, i + 1, text.trim().slice(0, 120), hits);
    for (const m of text.matchAll(/<([a-z]+-[a-z-]+)(\s[^>]*)?>/g)) {
      const t = targets.find(x => x.tagNames.has(m[1]!));
      if (t) hits.push({component: t.component, file: file.path, line: i + 1, snippet: text.trim().slice(0, 120), props: [...(m[2] ?? '').matchAll(/\s([a-z][\w-]*)(?==|\s|$)/g)].map(a => a[1]!)});
    }
  });
}

export type UsageScan = {components: ComponentUsage[]; filesScanned: number; filesSkipped: number; screens: number};
export function scanUsage(files: readonly SourceFile[], components: readonly ComponentObservation[]): UsageScan {
  const targets = targetsFor(components), hits: Hit[] = [];
  let scanned = 0, skipped = 0;
  for (const file of files) {
    if (!isScannable(file.path) || file.content.length > USAGE_LIMITS.bytesPerFile || scanned >= USAGE_LIMITS.files) { skipped++; continue; }
    scanned++;
    try {
      if (/\.[cm]?[jt]sx?$/i.test(file.path)) scanJsx(file, targets, hits); else scanMarkup(file, targets, hits);
    } catch { skipped++; }
  }
  const screens = new Set(files.filter(f => isScannable(f.path) && isScreen(f.path)).map(f => f.path));
  return {
    filesScanned: scanned, filesSkipped: skipped, screens: screens.size,
    components: targets.map(t => {
      const mine = hits.filter(h => h.component === t.component), files = [...new Set(mine.map(h => h.file))];
      const propUsages: Record<string, number> = {};
      for (const h of mine) for (const p of h.props) propUsages[p] = (propUsages[p] ?? 0) + 1;
      return {component: t.component, usages: mine.length, files, screens: files.filter(f => screens.has(f)),
        propUsages, imports: [...new Set(mine.flatMap(h => h.importFrom ? [h.importFrom] : []))], examples: mine.slice(0, USAGE_LIMITS.examples).map(h => ({file: h.file, line: h.line, snippet: h.snippet}))};
    }),
  };
}
