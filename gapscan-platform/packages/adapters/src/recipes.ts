// Variant recipes: libraries that declare their styles as data rather than prop types.
//   cva(base, {variants: {variant: {...}, size: {...}}})        class-variance-authority (shadcn/ui)
//   tv({base, variants: {...}})                                 tailwind-variants
//   defineRecipe({className, variants}) / defineSlotRecipe(...) Chakra UI v3, Panda CSS
// The variant groups are the component's API; Tailwind state prefixes (hover:, focus-visible:,
// disabled:) and Chakra state keys (_hover, _disabled, focusVisibleRing) show which states are styled.
// Parses only; nothing is executed.
import ts from 'typescript';
import type {ComponentApi} from './typescript.ts';

const RECIPE_CALLS = /^(cva|tv|defineRecipe|defineSlotRecipe|sva|cv)$/;
const TAILWIND_STATES: [RegExp, string][] = [[/(^|[\s"'`])hover:/, 'hover'], [/(^|[\s"'`])focus-visible:/, 'focus-visible'], [/(^|[\s"'`])active:/, 'active'],
  [/(^|[\s"'`])disabled:|data-\[disabled\]|aria-disabled:/, 'disabled'], [/aria-invalid:|data-\[invalid\]/, 'error'], [/data-\[state=checked\]|(^|[\s"'`])checked:|aria-checked:/, 'checked'],
  [/data-\[state=open\]|aria-expanded:/, 'open'], [/aria-selected:|data-\[selected/, 'selected']];
const CHAKRA_STATES: [RegExp, string][] = [[/\b_hover\b/, 'hover'], [/\b(_focusVisible|focusVisibleRing)\b/, 'focus-visible'], [/\b_active\b/, 'active'], [/\b_disabled\b/, 'disabled'],
  [/\b_invalid\b/, 'error'], [/\b_checked\b/, 'checked'], [/\b_open\b/, 'open'], [/\b_selected\b/, 'selected']];
const VARIANT_GROUPS = /^(variant|kind|appearance|tone|color|colorScheme|colorPalette|intent|look|emphasis|status|severity|visual)$/;
const pascal = (text: string) => text.replace(/(^|[-_\s]+)(\w)/g, (_, __, c: string) => c.toUpperCase());

export function variantRecipes(source: string, fileName: string): ComponentApi[] {
  // shadcn/ui marks every component part with data-slot; those files are read even without a recipe.
  const slotted = /\bdata-slot=/.test(source);
  if (!slotted && !/\b(cva|tv|defineRecipe|defineSlotRecipe|sva)\s*\(/.test(source)) return [];
  const kind = /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : /\.jsx$/i.test(fileName) ? ts.ScriptKind.JSX : /\.js$/i.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const keyName = (p: ts.ObjectLiteralElementLike) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) ? p.name.text : null;
  const objectArg = (call: ts.CallExpression) => call.arguments.find((a): a is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(a) && a.properties.some(p => keyName(p) === 'variants'))
    ?? call.arguments.find(ts.isObjectLiteralExpression);
  const recipes: {variable: string; className?: string; call: ts.CallExpression; line: number}[] = [];
  const components: {name: string; typeText: string; node: ts.Node}[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && RECIPE_CALLS.test(node.initializer.expression.getText(file))) {
      const config = objectArg(node.initializer), cls = config?.properties.find(p => keyName(p) === 'className');
      recipes.push({variable: node.name.text, call: node.initializer, line: lineOf(node), ...(cls && ts.isPropertyAssignment(cls) && ts.isStringLiteral(cls.initializer) ? {className: cls.initializer.text} : {})});
    }
    // Components that use a recipe: `function Button(props: … VariantProps<typeof buttonVariants>)`.
    if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) components.push({name: node.name.text, typeText: node.parameters[0]?.type?.getText(file) ?? '', node});
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z]/.test(node.name.text) && node.initializer) components.push({name: node.name.text, typeText: node.initializer.getText(file).slice(0, 600), node});
    ts.forEachChild(node, visit);
  };
  visit(file);

  const states = (text: string) => [...new Set([...TAILWIND_STATES, ...CHAKRA_STATES].filter(([re]) => re.test(text)).map(([, s]) => s))];
  // Exported data-slot components without a recipe: no variants, but their own props and styled states.
  const exported = new Set([...source.matchAll(/export\s*\{([^}]+)\}/g)].flatMap(m => m[1]!.split(',').map(n => n.trim().split(/\s+as\s+/).pop()!)));
  const plain: ComponentApi[] = slotted ? components.filter(c => exported.has(c.name) && ts.isFunctionDeclaration(c.node) && /data-slot=/.test(c.node.getText(file))).map(c => {
    const fn = c.node as ts.FunctionDeclaration, type = fn.parameters[0]?.type;
    const literal = type ? (ts.isIntersectionTypeNode(type) ? [...type.types] : [type]).find((t): t is ts.TypeLiteralNode => ts.isTypeLiteralNode(t)) : undefined;
    const props = [...(literal?.members ?? [])].flatMap((m: ts.TypeElement) => ts.isPropertySignature(m) ? [{name: m.name.getText(file), type: m.type?.getText(file) ?? 'unknown', optional: Boolean(m.questionToken)}] : []);
    return {name: c.name, line: lineOf(fn), props, variants: [], sizes: [], states: states(fn.getText(file))};
  }) : [];
  return [...plain.filter(p => !recipes.some(r => components.find(c => c.name === p.name)?.typeText.includes(`typeof ${r.variable}`))), ...recipes.flatMap(recipe => {
    const config = objectArg(recipe.call);
    const variants = config?.properties.find(p => keyName(p) === 'variants');
    if (!variants || !ts.isPropertyAssignment(variants) || !ts.isObjectLiteralExpression(variants.initializer)) return [];
    const props = variants.initializer.properties.flatMap(group => {
      const name = keyName(group);
      if (!name || !ts.isPropertyAssignment(group) || !ts.isObjectLiteralExpression(group.initializer)) return [];
      const values = group.initializer.properties.map(keyName).filter((v): v is string => v !== null);
      const boolean = values.length && values.every(v => v === 'true' || v === 'false');
      return [{name, type: boolean ? 'boolean' : values.map(v => JSON.stringify(v)).join(' | '), ...(boolean ? {} : {values}), optional: true}];
    });
    // Name: the component that takes `typeof recipe`, else the recipe's own name (buttonVariants → Button, chakra-button → Button).
    const user = components.find(c => c.typeText.includes(`typeof ${recipe.variable}`) || new RegExp(`\\b${recipe.variable}\\s*\\(`).test(c.node.getText(file)));
    const name = user?.name ?? pascal(recipe.className?.replace(/^chakra-/, '') ?? recipe.variable.replace(/(Variants|Styles|Recipe|SlotRecipe|Style)$/, ''));
    const variantValues = props.filter(p => VARIANT_GROUPS.test(p.name) && p.values).flatMap(p => p.values!.map(v => p.name === 'variant' ? v : `${p.name}=${v}`));
    return [{name, line: recipe.line, props, variants: variantValues, sizes: props.find(p => p.name === 'size')?.values ?? [],
      states: states(recipe.call.getText(file) + (user ? user.node.getText(file) : ''))}];
  })];
}
