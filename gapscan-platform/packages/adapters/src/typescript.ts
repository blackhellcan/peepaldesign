// Component APIs from TypeScript / TSX source and published `.d.ts` files.
// Parses only (no type checking, nothing executed): finds components and their
// props interfaces, then reads variants, sizes and states from the prop types.
import ts from 'typescript';
import type {Observation} from './types.ts';
import {variantRecipes} from './recipes.ts';

export type ComponentApi = {
  name: string; line: number;
  props: {name: string; type: string; values?: string[]; optional: boolean}[];
  variants: string[]; sizes: string[]; states: string[];
};

const NOISE = /^(children|className|classes|style|sx|ref|key|id|as|component|slots?|slotProps|theme|tabIndex|role)$|^(aria|data)[-A-Z]|^on[A-Z]/;
const VARIANT_PROPS = /^(variant|kind|appearance|tone|color|colorScheme|intent|look|emphasis|status|severity)$/;
const STATE_PROPS: Record<string, string> = {
  disabled: 'disabled', isDisabled: 'disabled', loading: 'loading', isLoading: 'loading', busy: 'loading', selected: 'selected', isSelected: 'selected',
  checked: 'checked', isChecked: 'checked', error: 'error', invalid: 'error', isInvalid: 'error', readOnly: 'read-only', isReadOnly: 'read-only',
  required: 'required', isRequired: 'required', active: 'active', pressed: 'active', indeterminate: 'indeterminate', open: 'open', expanded: 'expanded',
};
const literals = (text: string) => [...new Set([...text.matchAll(/'([^'\n]{1,40})'|"([^"\n]{1,40})"/g)].map(m => m[1] ?? m[2]!))];
const pascal = (name: string) => /^[A-Z][A-Za-z0-9]*$/.test(name);

export function componentApis(source: string, fileName: string): ComponentApi[] {
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : /\.jsx$/i.test(fileName) ? ts.ScriptKind.JSX : /\.js$/i.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const shapes = new Map<string, {members: ts.TypeElement[]; bases: string[]}>(), values = new Set<string>(), usesProps = new Map<string, string>();
  // Type aliases and declared const types, so `ButtonType = (typeof _ButtonTypes)[number]` resolves to its literals.
  const aliasText = new Map<string, string>(), constText = new Map<string, string>();
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const refName = (type: ts.TypeNode | undefined): string | undefined => {
    if (!type) return undefined;
    if (ts.isTypeReferenceNode(type)) return type.typeName.getText(file);
    if (ts.isIntersectionTypeNode(type)) return type.types.map(refName).find(Boolean);
    return undefined;
  };
  const propsOf = (fn: ts.SignatureDeclarationBase) => refName(fn.parameters[0]?.type);

  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node)) shapes.set(node.name.text, {members: [...node.members], bases: (node.heritageClauses ?? []).flatMap(h => h.types.map(t => t.expression.getText(file)))});
    else if (ts.isTypeAliasDeclaration(node)) {
      aliasText.set(node.name.text, node.type.getText(file));
      const parts = ts.isIntersectionTypeNode(node.type) ? node.type.types : [node.type];
      // Generic wrappers (`ExtendPaperTypeMap<{props: …}>`) carry their members in a type-literal argument.
      const literalsIn = (p: ts.TypeNode): ts.TypeElement[] => ts.isTypeLiteralNode(p) ? [...p.members] : ts.isTypeReferenceNode(p) ? (p.typeArguments ?? []).flatMap(literalsIn) : [];
      const refsIn = (p: ts.TypeNode): string[] => ts.isTypeReferenceNode(p) ? [p.typeName.getText(file), ...(p.typeArguments ?? []).flatMap(refsIn)] : ts.isIntersectionTypeNode(p) ? p.types.flatMap(refsIn) : [];
      shapes.set(node.name.text, {members: parts.flatMap(literalsIn), bases: parts.flatMap(refsIn)});
    } else if (ts.isFunctionDeclaration(node) && node.name && pascal(node.name.text)) {
      values.add(node.name.text);
      const props = propsOf(node); if (props) usesProps.set(node.name.text, props);
    } else if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.type) constText.set(d.name.text, d.type.getText(file));
      if (!ts.isIdentifier(d.name) || !pascal(d.name.text)) continue;
      values.add(d.name.text);
      // const Button = (props: ButtonProps) => …, forwardRef<HTMLButtonElement, ButtonProps>(…), React.FC<ButtonProps>
      let init = d.initializer;
      while (init && ts.isCallExpression(init)) {
        const typeArg = init.typeArguments?.map(t => refName(t)).filter(Boolean).at(-1);
        if (typeArg) { usesProps.set(d.name.text, typeArg); break; }
        init = init.arguments[0];
      }
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && propsOf(init)) usesProps.set(d.name.text, propsOf(init)!);
      const declared = d.type && ts.isTypeReferenceNode(d.type) ? d.type.typeArguments?.map(t => refName(t)).find(Boolean) : undefined;
      if (declared && !usesProps.has(d.name.text)) usesProps.set(d.name.text, declared);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const membersOf = (name: string, seen = new Set<string>()): ts.TypeElement[] => {
    const shape = shapes.get(name);
    if (!shape || seen.has(name)) return [];
    seen.add(name);
    // MUI-style type maps keep the real props one level down: `{props: AdditionalProps & {…}; defaultComponent: …}`.
    const unwrapped = shape.members.flatMap(m => {
      if (!ts.isPropertySignature(m) || m.name.getText(file) !== 'props' || !m.type) return [m];
      const parts = ts.isIntersectionTypeNode(m.type) ? m.type.types : [m.type];
      return parts.flatMap(p => ts.isTypeLiteralNode(p) ? [...p.members] : ts.isTypeReferenceNode(p) ? membersOf(p.typeName.getText(file), seen) : []);
    }).filter(m => !(ts.isPropertySignature(m) && m.name.getText(file) === 'defaultComponent'));
    return [...unwrapped, ...shape.bases.flatMap(b => membersOf(b.replace(/<.*$/, ''), seen))];
  };
  const expand = (text: string, depth = 0): string => depth > 4 ? text : text
    .replace(/typeof\s+([A-Za-z_$][\w$]*)/g, (whole, name: string) => constText.has(name) ? expand(constText.get(name)!, depth + 1) : whole)
    .replace(/\b([A-Z][A-Za-z0-9_]*)\b(?!\s*[:<(])/g, (whole, name: string) => aliasText.has(name) && !shapes.get(name)?.members.length ? `(${expand(aliasText.get(name)!, depth + 1)})` : whole);
  const propCount = (name: string) => membersOf(name).filter(m => ts.isPropertySignature(m) && !NOISE.test(m.name.getText(file).replace(/['"]/g, ''))).length;
  // Components: values typed by a props shape, plus `XProps` / `XOwnProps` shapes for an exported X or the file's own name.
  const stem = fileName.split('/').pop()!.replace(/\.(d\.)?[jt]sx?$/, '');
  const found = new Map<string, string>(usesProps);
  for (const name of shapes.keys()) {
    const raw = name.match(/^(?:Base)?([A-Z][A-Za-z0-9]*?)(Own|Base)?Props$/), match = raw && ['', raw[1]!] as const;
    // A value typed through a generic map (MUI's ExtendButtonBase<ButtonTypeMap>) has no readable members; the props interface wins.
    if (match && (values.has(match[1]!) || match[1] === stem) && (!found.has(match[1]!) || propCount(name) > propCount(found.get(match[1]!)!))) found.set(match[1]!, name);
  }
  return [...found].flatMap(([name, propsType]) => {
    const members = membersOf(propsType);
    if (!members.length) return [];
    const props = members.flatMap(m => {
      if (!ts.isPropertySignature(m) || !m.name) return [];
      const prop = m.name.getText(file).replace(/['"]/g, '');
      if (NOISE.test(prop)) return [];
      const type = m.type?.getText(file).replace(/\s+/g, ' ').slice(0, 160) ?? 'unknown', options = literals(expand(m.type?.getText(file) ?? ''));
      return [{name: prop, type, optional: Boolean(m.questionToken), ...(options.length ? {values: options} : {})}];
    }).filter((p, i, all) => all.findIndex(q => q.name === p.name) === i);
    // `type` is a style in some libraries (antd) and the HTML button type in others; only the former is a variant.
    const isStyleType = (p: {name: string; values?: string[]}) => p.name === 'type' && Boolean(p.values?.some(v => !/^(button|submit|reset)$/.test(v)));
    const variants = props.filter(p => (VARIANT_PROPS.test(p.name) || isStyleType(p)) && p.values).flatMap(p => p.values!.map(v => p.name === 'variant' ? v : `${p.name}=${v}`));
    const sizes = props.find(p => p.name === 'size')?.values ?? [];
    const states = [...new Set(props.filter(p => STATE_PROPS[p.name] && /boolean/.test(p.type)).map(p => STATE_PROPS[p.name]!))];
    return [{name, line: lineOf(file), props, variants, sizes, states}];
  });
}

export function typescriptObservations(source: string, fileName: string): Observation[] {
  // Prop types and variant recipes describe the same components; a recipe adds the variants and styled states.
  const apis = componentApis(source, fileName);
  for (const recipe of variantRecipes(source, fileName)) {
    const same = apis.find(a => a.name === recipe.name);
    if (!same) { apis.push(recipe); continue; }
    same.props = [...same.props, ...recipe.props.filter(p => !same.props.some(q => q.name === p.name))];
    same.variants = [...new Set([...same.variants, ...recipe.variants])];
    same.sizes = [...new Set([...same.sizes, ...recipe.sizes])];
    same.states = [...new Set([...same.states, ...recipe.states])];
  }
  return apis.map(c => ({
    type: 'component' as const, channel: 'code_tokens' as const, name: c.name, variants: [...c.variants, ...c.sizes.map(s => `size=${s}`)], states: c.states,
    props: c.props.map(p => ({name: p.name, type: p.type, ...(p.values ? {values: p.values} : {})})), locator: `${fileName}:${c.line}`, raw: `${c.props.length} props`,
  }));
}

// Web components (Material Web and similar): a folder of tags such as `md-filled-button`,
// each a style variant, whose public class properties (including inherited ones) are the API.
export function customElementApi(source: string, fileName: string, component: string, tagPrefix = 'md-'): ComponentApi | null {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tags = new Map<string, string>(), classes = new Map<string, {members: ts.ClassElement[]; base?: string}>();
  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'HTMLElementTagNameMap')
      for (const m of node.members) if (ts.isPropertySignature(m) && m.type) tags.set(m.name.getText(file).replace(/['"]/g, ''), m.type.getText(file));
    if (ts.isClassDeclaration(node) && node.name) classes.set(node.name.text, {members: [...node.members], ...(node.heritageClauses?.[0]?.types[0] ? {base: node.heritageClauses[0].types[0].expression.getText(file)} : {})});
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!tags.size) return null;
  const isPublic = (m: ts.ClassElement) => !(ts.getCombinedModifierFlags(m as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static));
  const fields = (name: string | undefined, seen = new Set<string>()): ts.PropertyDeclaration[] => {
    if (!name || seen.has(name) || !classes.has(name)) return [];
    seen.add(name);
    const shape = classes.get(name)!;
    return [...shape.members.filter((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && isPublic(m) && ts.isIdentifier(m.name) && !m.name.text.startsWith('_')), ...fields(shape.base, seen)];
  };
  const word = component.toLowerCase().replace(/\s+/g, '-');
  // Tags for parts (`md-list-item`, `md-chip-set`, `md-select-option`, `md-sub-menu`) are anatomy, not styles;
  // a single remaining tag means the component has no style variants.
  const singular = word.replace(/s$/, '').replace(/-/g, '-?');
  const styleTags = [...tags.keys()].filter(t => t.startsWith(tagPrefix) && !/-(item|option|set|group)$|^[a-z]+-sub-|-sub$/.test(t.slice(tagPrefix.length)) && !new RegExp(`^sub-`).test(t.slice(tagPrefix.length)));
  const names = styleTags.map(t => t.slice(tagPrefix.length).replace(new RegExp(`-?${singular}s?$`), '').replace(/-$/, '') || 'standard');
  const variants = names.length > 1 ? names : [];
  const props = [...tags.values()].flatMap(cls => fields(cls)).flatMap(f => {
    const name = (f.name as ts.Identifier).text;
    if (NOISE.test(name) || /^(styles|shadowRootOptions|formAssociated)$/.test(name)) return [];
    const type = f.type?.getText(file).replace(/\s+/g, ' ').slice(0, 160) ?? 'unknown', values = literals(type);
    return [{name, type, optional: Boolean(f.questionToken), ...(values.length ? {values} : {})}];
  }).filter((p, i, all) => all.findIndex(q => q.name === p.name) === i);
  const states = [...new Set(props.filter(p => /boolean/.test(p.type)).flatMap(p => STATE_PROPS[p.name] ?? (p.name === 'softDisabled' ? 'disabled' : p.name === 'hasError' ? 'error' : [])))];
  return {name: component.replace(/\s+/g, ''), line: 1, props, variants: [...new Set(variants)], sizes: props.find(p => p.name === 'size')?.values ?? [], states};
}
