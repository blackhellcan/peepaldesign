// The codemod's rewriter. It is self-contained on purpose: the same source runs the
// in-app dry run and is embedded (types stripped) in the script people download, so
// the diff they review is the diff the script makes. It parses and edits text only.
import ts from 'typescript';

// One style, size or tone option: `kind="primary"` → `variant="contained"`. A null
// target means the reference has no equivalent, so call sites using it are left for a person.
export type OptionRule = {prop: string; value: string; toProp: string | null; toValue: string | null};
export type JsxRule = {
  names: string[];          // exported names the scan resolved for this component (Button, TextField…)
  modules: string[];        // modules your app imports it from; imports from anywhere else are left alone
  package: string | null;   // the reference's package, when it publishes this component under `exportName`
  exportName: string | null;
  props: Record<string, string>;   // prop renames
  options: OptionRule[];
  optionProps: string[];           // props whose values are options (kind, size…)
  manualProps: string[];           // props with no equivalent: flagged, never removed
  targetValues: Record<string, string[]>;  // the reference's enumerated props, to catch a value that means something else there
};
export type ClassRule = {map: Record<string, string>; watch: string[]};  // class token renames; `watch` bases flag unmapped modifiers
export type ComponentRule = {component: string; target: string; jsx?: JsxRule; classes?: ClassRule};
export type CodemodRules = {version: 1; reference: string; components: ComponentRule[]};
export type ManualEdit = {line: number; component: string; reason: string};
export type TransformResult = {output: string; changes: number; manual: ManualEdit[]};

// Files the codemod reads: code and markup, tests and stories included (they use the components too).
const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|html?|hbs|erb|php|astro)$/i;
const SKIP = /(?:^|\/)(?:node_modules|\.git|dist|build|out|coverage|\.next|\.nuxt|vendor|storybook-static)\/|\.d\.ts$|\.min\.js$/;
export const shouldVisit = (path: string) => CODE.test(path) && !SKIP.test(path);

type Edit = {start: number; end: number; text: string};
function applyEdits(content: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = content, floor = Infinity;
  for (const e of sorted) {
    if (e.end > floor) continue;               // overlapping edits: keep the later one only
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
  }
  return out;
}

// Class lists: rename mapped tokens; a modifier of a watched base that has no mapping is a manual edit.
function rewriteClasses(text: string, rules: ComponentRule[], onManual: (component: string, reason: string) => void): {text: string; changes: number} {
  let changes = 0;
  const out = text.replace(/[\w-]+/g, token => {
    // Every rule's map first: `btn-group` belongs to Button Group even though it starts with `btn-`.
    const mapped = rules.find(r => r.classes && Object.hasOwn(r.classes.map, token));
    if (mapped) { const to = mapped.classes!.map[token]!; if (to !== token) changes++; return to; }
    const watched = rules.find(r => r.classes?.watch.some(base => token.startsWith(base + '-')));
    if (watched) onManual(watched.component, `Class “${token}” has no equivalent in ${watched.target}`);
    return token;
  });
  return {text: out, changes};
}
const classesMatter = (text: string, rules: ComponentRule[]) => text.split(/[^\w-]+/).some(tok => rules.some(r => r.classes && (Object.hasOwn(r.classes.map, tok) || r.classes.watch.some(b => tok === b || tok.startsWith(b + '-')))));

function transformMarkup(content: string, rules: ComponentRule[]): TransformResult {
  const manual: ManualEdit[] = [], edits: Edit[] = [];
  let changes = 0;
  for (const m of content.matchAll(/\b(class(?:Name)?\s*=\s*)(["'])([^"']*)\2/g)) {
    const line = content.slice(0, m.index).split('\n').length, start = m.index + m[1]!.length + 1;
    const result = rewriteClasses(m[3]!, rules, (component, reason) => manual.push({line, component, reason}));
    if (result.changes) { edits.push({start, end: start + m[3]!.length, text: result.text}); changes += result.changes; }
  }
  return {output: applyEdits(content, edits), changes, manual};
}

const quoteOf = (literal: ts.StringLiteral, source: ts.SourceFile) => literal.getText(source)[0] === "'" ? "'" : '"';
// New imports follow the file's own style: quotes, semicolons and `{ spaced }` braces.
type ImportStyle = {quote: string; semi: string; pad: string};
function importText(specifiers: string[], from: string, {quote, semi, pad}: ImportStyle) {
  return `import {${pad}${specifiers.join(', ')}${pad}} from ${quote}${from}${quote}${semi}`;
}

function transformScript(path: string, content: string, rules: ComponentRule[]): TransformResult {
  const kind = /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.ts$/i.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  const manual: ManualEdit[] = [], edits: Edit[] = [];
  let changes = 0;
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const flag = (node: ts.Node, component: string, reason: string) => manual.push({line: lineOf(node), component, reason});

  // 1. Imports from the modules the scan attributed are re-pointed at the reference's package.
  //    Local names stay as they are, so no JSX tag changes.
  const locals = new Map<string, ComponentRule>();
  const byName = (name: string, from: string) => rules.find(r => r.jsx && r.jsx.modules.includes(from) && (r.jsx.names.includes(name) || r.jsx.names.includes(from.split('/').pop()!.replace(/\.\w+$/, ''))));
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text, clause = statement.importClause;
    const style: ImportStyle = {quote: quoteOf(statement.moduleSpecifier as ts.StringLiteral, source), semi: statement.getText(source).trimEnd().endsWith(';') ? ';' : '', pad: /^import\s*\{\s/m.test(content) ? ' ' : ''};
    const moved = new Map<string, {imported: string; local: string}[]>();
    // Returns true when the binding moves to the reference's package.
    const move = (imported: string, local: string) => {
      const rule = byName(imported, from);
      if (rule) locals.set(local, rule);
      const target = rule?.jsx?.package && rule.jsx.exportName ? rule.jsx.package : null;
      if (!rule || !target || from === target || from.startsWith(target + '/')) return false;
      moved.set(target, [...(moved.get(target) ?? []), {imported: rule.jsx!.exportName!, local}]);
      return true;
    };
    const keepDefault = clause.name && !move(clause.name.text, clause.name.text) ? clause.name.text : null;
    const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings : null;
    const keptNamed: string[] = [];
    if (named) for (const el of named.elements)
      if (el.isTypeOnly || !move((el.propertyName ?? el.name).text, el.name.text)) keptNamed.push(el.getText(source));
    if (!moved.size) continue;
    const namespace = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.getText(source) : null;
    const parts = [keepDefault, namespace, keptNamed.length ? `{${style.pad}${keptNamed.join(', ')}${style.pad}}` : null].filter(Boolean);
    const lines = [...(parts.length ? [`import ${parts.join(', ')} from ${style.quote}${from}${style.quote}${style.semi}`] : []),
      ...[...moved].map(([pkg, specs]) => importText(specs.map(s => s.imported === s.local ? s.local : `${s.imported} as ${s.local}`), pkg, style))];
    edits.push({start: statement.getStart(source), end: statement.getEnd(), text: lines.join('\n')});
    changes += [...moved.values()].reduce((n, s) => n + s.length, 0);
  }

  // 2. Props and option values on each element of a migrated component. An element is
  //    edited all-or-nothing: if any attribute can't be mapped safely, it is flagged instead.
  const literalOf = (init: ts.JsxAttributeValue | undefined): string | null => {
    if (!init) return null;
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))) return init.expression.text;
    return null;
  };
  const visitElement = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => {
    const rule = locals.get(node.tagName.getText(source)), jsx = rule?.jsx;
    if (!rule || !jsx) return;
    const attrs = node.attributes.properties, present = new Set(attrs.flatMap(a => ts.isJsxAttribute(a) ? [a.name.getText(source)] : []));
    const pending: Edit[] = [], problems: string[] = [];
    const finalNames = new Map<string, string>();
    for (const a of attrs) {
      if (ts.isJsxSpreadAttribute(a)) {
        if (Object.keys(jsx.props).length || jsx.options.length || jsx.manualProps.length) problems.push('Spread props may carry renamed props; check them by hand');
        continue;
      }
      const name = a.name.getText(source);
      let toName = name, toValue: string | null = null;
      if (jsx.manualProps.includes(name)) { problems.push(`Prop “${name}” has no equivalent in ${rule.target}`); continue; }
      if (jsx.props[name]) toName = jsx.props[name];
      else if (jsx.optionProps.includes(name)) {
        const value = literalOf(a.initializer);
        if (value === null) { problems.push(`“${name}” is computed; map its values by hand (${jsx.options.filter(o => o.prop === name && o.toProp).map(o => `${o.value} → ${o.toProp}=${o.toValue}`).join(', ') || 'no direct equivalents'})`); continue; }
        const option = jsx.options.find(o => o.prop === name && o.value === value);
        if (!option) continue;                                   // a value the scan never saw: leave it
        if (!option.toProp || option.toValue === null) { problems.push(`${name}="${value}" has no equivalent in ${rule.target}`); continue; }
        toName = option.toProp; toValue = option.toValue;
        if (toValue !== value) pending.push({start: a.initializer!.getStart(source), end: a.initializer!.getEnd(), text: `"${toValue}"`});
      }
      // `type="submit"` passes through to the DOM in one library and picks a style in another.
      const allowed = jsx.targetValues[toName], literal = toValue ?? literalOf(a.initializer);
      if (allowed && literal !== null && !allowed.includes(literal)) { problems.push(`${toName}="${literal}" means something else in ${rule.target}, which expects ${allowed.join(' | ')}`); continue; }
      if (finalNames.has(toName)) { problems.push(`Both “${finalNames.get(toName)}” and “${name}” would become “${toName}”`); continue; }
      if (toName !== name && present.has(toName) && !jsx.props[toName] && !jsx.optionProps.includes(toName)) { problems.push(`“${name}” would become “${toName}”, which is already set`); continue; }
      finalNames.set(toName, name);
      if (toName !== name) pending.push({start: a.name.getStart(source), end: a.name.getEnd(), text: toName});
    }
    if (problems.length) { for (const p of problems) flag(node, rule.component, p); return; }
    edits.push(...pending); changes += pending.length;
  };

  // 3. Class strings inside className/class attributes (including clsx-style calls).
  const visitClassAttribute = (attr: ts.JsxAttribute) => {
    const walk = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const result = rewriteClasses(node.text, rules, (component, reason) => flag(node, component, reason));
        if (result.changes) { edits.push({start: node.getStart(source) + 1, end: node.getEnd() - 1, text: result.text}); changes += result.changes; }
        return;
      }
      if (ts.isTemplateExpression(node) && classesMatter(node.getText(source), rules)) { flag(node, rules.find(r => r.classes)!.component, 'Class names are built in a template string; update them by hand'); return; }
      ts.forEachChild(node, walk);
    };
    if (attr.initializer) walk(attr.initializer);
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      visitElement(node);
      for (const a of node.attributes.properties) if (ts.isJsxAttribute(a) && /^(className|class)$/.test(a.name.getText(source))) visitClassAttribute(a);
    } else if (ts.isIdentifier(node) && locals.has(node.text) && !ts.isImportSpecifier(node.parent) && !ts.isImportClause(node.parent)
      && !(ts.isJsxOpeningElement(node.parent) || ts.isJsxSelfClosingElement(node.parent) || ts.isJsxClosingElement(node.parent))) {
      const rule = locals.get(node.text)!;
      if (rule.jsx && (Object.keys(rule.jsx.props).length || rule.jsx.options.length)) flag(node, rule.component, `${node.text} is used outside JSX (${node.parent.getText(source).slice(0, 60)}); check its props by hand`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {output: applyEdits(content, edits), changes, manual};
}

export function transformFile(path: string, content: string, rules: CodemodRules): TransformResult {
  if (!shouldVisit(path)) return {output: content, changes: 0, manual: []};
  const components = rules.components;
  try {
    return /\.[cm]?[jt]sx?$/i.test(path) ? transformScript(path, content, components) : transformMarkup(content, components);
  } catch (error) {
    return {output: content, changes: 0, manual: [{line: 1, component: '', reason: `Could not be parsed, so it was left unchanged (${error instanceof Error ? error.message : String(error)})`}]};
  }
}
