// What a design system usually has that this extraction didn't find, so people can add it.
// Components are matched with GapScan's own classifier, so "btn" or "PrimaryButton" counts as a Button.
import {classifyItem} from '@gapscan/taxonomy';
import type {ExtractedDesignSystem} from '@gapscan/schema';

// The components most design systems have: a name people use, and the classifier words that mean it.
export const EXPECTED_COMPONENTS: readonly {name: string; matches: readonly string[]}[] = [
  {name: 'Button', matches: ['button', 'btn']}, {name: 'Link', matches: ['link']},
  {name: 'Text field', matches: ['text field', 'textfield', 'text input', 'input', 'field']}, {name: 'Text area', matches: ['text area', 'textarea']},
  {name: 'Checkbox', matches: ['checkbox', 'check box']}, {name: 'Radio', matches: ['radio']}, {name: 'Select', matches: ['select', 'combobox', 'combo box', 'listbox', 'dropdown']},
  {name: 'Switch', matches: ['switch', 'toggle', 'toggle switch']}, {name: 'Card', matches: ['card']}, {name: 'Table', matches: ['table', 'data grid']},
  {name: 'Tabs', matches: ['tabs', 'tab', 'tab list']}, {name: 'Navigation bar', matches: ['navbar', 'navigation', 'side nav', 'sidenav', 'sidebar']},
  {name: 'Breadcrumb', matches: ['breadcrumb']}, {name: 'Menu', matches: ['menu', 'dropdown']}, {name: 'Alert', matches: ['alert', 'banner', 'message bar', 'notification', 'callout']},
  {name: 'Badge', matches: ['badge', 'chip', 'tag', 'pill', 'lozenge']}, {name: 'Progress', matches: ['progress', 'spinner', 'busy indicator', 'skeleton']},
  {name: 'Toast', matches: ['toast', 'snackbar', 'notification']}, {name: 'Modal', matches: ['modal', 'dialog']}, {name: 'Tooltip', matches: ['tooltip', 'popover']},
  {name: 'Avatar', matches: ['avatar']}, {name: 'Accordion', matches: ['accordion', 'collapse', 'expander', 'disclosure']},
];

export type MissingItems = {components: string[]; foundations: string[]; found: {components: number}};
export function missingItems(eds: ExtractedDesignSystem): MissingItems {
  // Found when GapScan's classifier says so, or when a component's own name contains the words
  // ("Radio button" is a Radio even though the classifier files it under buttons).
  const names = eds.components.flatMap(c => [c.canonical, ...c.rawNames]);
  const found = new Set(names.map(name => classifyItem({name, kind: 'component'}).matchedBy.toLowerCase()));
  const words = names.map(name => ` ${name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `);
  const named = (match: string) => words.some(w => w.includes(` ${match} `) || w.includes(` ${match}s `));
  const components = EXPECTED_COMPONENTS.filter(e => !e.matches.some(m => found.has(m) || named(m))).map(e => e.name);
  const has = (test: (path: string, type: string) => boolean) => eds.tokens.some(t => t.status !== 'unresolved' && test(t.path, t.type));
  const foundations = [
    has((p, t) => t === 'color') ? null : 'Colours',
    has(p => p.startsWith('font.family.')) ? null : 'Typefaces',
    has(p => p.startsWith('font.size.')) ? null : 'Type sizes',
    has(p => p.startsWith('space.')) ? null : 'Spacing',
    has((p, t) => p.startsWith('radius.') || t === 'radius') ? null : 'Corner radius',
    has((p, t) => p.startsWith('shadow.') || t === 'shadow') ? null : 'Shadows',
  ].filter((x): x is string => x !== null);
  return {components, foundations, found: {components: eds.components.length}};
}
