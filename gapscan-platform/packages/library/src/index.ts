// Curated reference library: versioned ReferenceDS snapshots built from each
// library's published artifacts (not trained models, not hand-typed lists).
// `scripts/build.ts` rebuilds them; this module only reads the pinned files.
import {readdir, readFile} from 'node:fs/promises';
import {ReferenceDS} from '@gapscan/schema';
import type {ReferenceDS as ReferenceDSType} from '@gapscan/schema';

// `css` references are read from a published stylesheet (with previews); `types` references from published TypeScript declarations (APIs only).
// `bundles` read declaration files that are split across a folder: each component's index.d.ts, the
// same-folder files it imports, and shared prelude files, read together as one document.
export type ReferenceSource = {id: string; library: string; version: string; homepage: string; framework: string; kind: 'css' | 'types';
  artifacts: {url: string; name: string; classPrefix?: string}[]; bundles?: {base: string; components: string[]; prelude: string[]};
  // Web-component libraries: one folder per component, its tags are the style variants.
  customElements?: {package: string; version: string; folders: Record<string, string>};
  // How code reaches the library, for codemods: the package its components are imported from (and
  // the exports it is known to publish), or how its modifier classes are written.
  codemod?: CodemodBinding;
  // Libraries written one component per file (shadcn/ui): keep the component named after its file and drop its parts.
  onePerFile?: boolean};
// `modulePattern`: libraries copied into projects (shadcn) import each component from its own file, e.g. '@/components/ui/{file}'.
export type CodemodBinding = {package?: string; modulePattern?: string; exports?: string[] | 'all'; classes?: {style: 'suffix' | 'chained'; prefix: string; separator: string}};
const pascal = (folder: string) => folder.replace(/(^|-)(\w)/g, (_, __, ch: string) => ch.toUpperCase());
const MUI_COMPONENTS = ['Button', 'TextField', 'Checkbox', 'Radio', 'Switch', 'Select', 'Chip', 'Badge', 'Alert', 'Snackbar', 'Dialog', 'Tabs', 'Tooltip', 'Card', 'Avatar', 'Table', 'Slider', 'Menu', 'Breadcrumbs', 'Pagination', 'LinearProgress', 'CircularProgress', 'IconButton', 'ButtonGroup', 'AppBar', 'Drawer', 'Accordion', 'Fab', 'ToggleButton', 'Autocomplete', 'Link'];

const ANTD_COMPONENTS = ['button', 'input', 'checkbox', 'radio', 'switch', 'select', 'tag', 'badge', 'alert', 'modal', 'tabs', 'tooltip', 'card', 'avatar', 'table', 'slider', 'menu', 'breadcrumb', 'pagination', 'progress', 'dropdown', 'drawer', 'collapse', 'float-button', 'segmented', 'auto-complete', 'steps', 'notification'];

// Fluent 2 (Microsoft): each component package ships one rolled-up declaration file. Versions are
// the ones @fluentui/react-components 9.74.10 depends on; it re-exports all of them.
const FLUENT_PACKAGES: Record<string, string> = {
  button: '9.11.2', input: '9.8.8', textarea: '9.7.8', checkbox: '9.6.6', radio: '9.6.7', switch: '9.7.7', select: '9.5.7', combobox: '9.17.8', field: '9.5.6',
  slider: '9.6.7', spinbutton: '9.6.8', search: '9.4.8', badge: '9.5.7', 'message-bar': '9.7.8', toast: '9.8.5', dialog: '9.18.6', drawer: '9.13.5', popover: '9.14.10',
  tooltip: '9.10.8', tabs: '9.12.6', breadcrumb: '9.4.7', link: '9.8.6', menu: '9.25.7', card: '9.7.4', avatar: '9.11.9', persona: '9.7.11', table: '9.19.23',
  accordion: '9.12.5', progress: '9.5.7', spinner: '9.8.7', skeleton: '9.7.7', tags: '9.9.8', divider: '9.7.6', rating: '9.4.7', toolbar: '9.8.6',
};

// shadcn/ui has no package: its components are source files copied into each project. Pinned to a
// commit of the official registry (raw files are immutable per commit; each one is checksummed).
const SHADCN_COMMIT = '4233ed1caded8c38f4bc14b14afe1f93ebcaf966';
const SHADCN_FILES = ['accordion', 'alert', 'alert-dialog', 'avatar', 'badge', 'breadcrumb', 'button', 'button-group', 'card', 'checkbox', 'collapsible', 'combobox', 'command',
  'context-menu', 'dialog', 'drawer', 'dropdown-menu', 'empty', 'field', 'hover-card', 'input', 'input-group', 'input-otp', 'item', 'kbd', 'label', 'menubar', 'native-select',
  'navigation-menu', 'pagination', 'popover', 'progress', 'radio-group', 'scroll-area', 'select', 'separator', 'sheet', 'sidebar', 'skeleton', 'slider', 'sonner', 'spinner',
  'switch', 'table', 'tabs', 'textarea', 'toggle', 'toggle-group', 'tooltip'];
// Chakra UI v3 styles every component with a recipe; the package's theme holds all of them.
const CHAKRA_RECIPES = ['accordion', 'action-bar', 'alert', 'avatar', 'badge', 'blockquote', 'breadcrumb', 'button', 'card', 'checkbox', 'checkbox-card', 'code', 'collapsible',
  'color-picker', 'combobox', 'dialog', 'drawer', 'editable', 'empty-state', 'field', 'fieldset', 'file-upload', 'heading', 'hover-card', 'input', 'kbd', 'link', 'list', 'listbox',
  'menu', 'native-select', 'number-input', 'pin-input', 'popover', 'progress', 'progress-circle', 'radio-card', 'radio-group', 'rating-group', 'segment-group', 'select', 'separator',
  'skeleton', 'slider', 'spinner', 'stat', 'status', 'steps', 'switch', 'table', 'tabs', 'tag', 'tags-input', 'textarea', 'timeline', 'toast', 'tooltip', 'tree-view'];
// Single-part recipes are plain components (<Button>); multi-part ones are namespaces (<Dialog.Root>) a rename can't produce.
const CHAKRA_SINGLE = ['badge', 'button', 'code', 'heading', 'input', 'kbd', 'link', 'separator', 'skeleton', 'spinner', 'textarea'];

export const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  {id: 'bootstrap-5.3.3', library: 'Bootstrap', version: '5.3.3', homepage: 'https://getbootstrap.com/docs/5.3/', framework: 'HTML/CSS', kind: 'css',
    artifacts: [{url: 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.css', name: 'bootstrap.css'}], codemod: {classes: {style: 'suffix', prefix: '', separator: '-'}}},
  {id: 'polaris-13.9.5', library: 'Shopify Polaris', version: '13.9.5', homepage: 'https://polaris.shopify.com/', framework: 'React', kind: 'css',
    artifacts: [{url: 'https://cdn.jsdelivr.net/npm/@shopify/polaris@13.9.5/build/esm/styles.css', name: 'polaris.css', classPrefix: 'Polaris-'},
      {url: 'https://cdn.jsdelivr.net/npm/@shopify/polaris-tokens@9.4.2/dist/css/styles.css', name: 'polaris-tokens.css'}]},
  {id: 'carbon-styles-1.68.0', library: 'IBM Carbon', version: '@carbon/styles 1.68.0', homepage: 'https://carbondesignsystem.com/', framework: 'React / Web Components', kind: 'css',
    artifacts: [{url: 'https://cdn.jsdelivr.net/npm/@carbon/styles@1.68.0/css/styles.css', name: 'carbon.css', classPrefix: 'cds--'}], codemod: {classes: {style: 'suffix', prefix: 'cds--', separator: '--'}}},
  {id: 'bulma-1.0.2', library: 'Bulma', version: '1.0.2', homepage: 'https://bulma.io/', framework: 'HTML/CSS', kind: 'css',
    artifacts: [{url: 'https://cdn.jsdelivr.net/npm/bulma@1.0.2/css/bulma.css', name: 'bulma.css'}], codemod: {classes: {style: 'chained', prefix: '', separator: 'is-'}}},
  {id: 'mui-6.4.7', library: 'MUI (Material UI)', version: '6.4.7', homepage: 'https://mui.com/material-ui/', framework: 'React', kind: 'types',
    artifacts: MUI_COMPONENTS.map(c => ({url: `https://cdn.jsdelivr.net/npm/@mui/material@6.4.7/${c}/${c}.d.ts`, name: `${c}.d.ts`})), codemod: {package: '@mui/material', exports: MUI_COMPONENTS}},
  {id: 'material-web-2.3.0', library: 'Material Design 3 (Material Web)', version: '2.3.0', homepage: 'https://m3.material.io/', framework: 'Web Components', kind: 'types', artifacts: [],
    customElements: {package: '@material/web', version: '2.3.0', folders: {button: 'Button', checkbox: 'Checkbox', chips: 'Chip', dialog: 'Dialog', divider: 'Divider', fab: 'Fab', iconbutton: 'Icon Button',
      list: 'List', menu: 'Menu', progress: 'Progress', radio: 'Radio', select: 'Select', slider: 'Slider', switch: 'Switch', tabs: 'Tabs', textfield: 'Text Field'}}},
  {id: 'antd-5.24.2', library: 'Ant Design', version: '5.24.2', homepage: 'https://ant.design/', framework: 'React', kind: 'types', artifacts: [],
    bundles: {base: 'https://cdn.jsdelivr.net/npm/antd@5.24.2/es', prelude: ['config-provider/SizeContext.d.ts', '_util/statusUtils.d.ts'],
      components: ANTD_COMPONENTS}, codemod: {package: 'antd', exports: ANTD_COMPONENTS.filter(c => c !== 'notification').map(pascal)}},
  {id: 'fluent-9.74.10', library: 'Fluent 2 (Microsoft)', version: '@fluentui/react-components 9.74.10', homepage: 'https://fluent2.microsoft.design/', framework: 'React', kind: 'types',
    artifacts: Object.entries(FLUENT_PACKAGES).map(([pkg, version]) => ({url: `https://cdn.jsdelivr.net/npm/@fluentui/react-${pkg}@${version}/dist/index.d.ts`, name: `${pkg}.d.ts`})),
    codemod: {package: '@fluentui/react-components', exports: 'all'}},
  {id: 'shadcn-ui-2026-10', library: 'shadcn/ui', version: `registry ${SHADCN_COMMIT.slice(0, 7)} (new-york-v4)`, homepage: 'https://ui.shadcn.com/', framework: 'React + Tailwind', kind: 'types',
    artifacts: SHADCN_FILES.map(f => ({url: `https://raw.githubusercontent.com/shadcn-ui/ui/${SHADCN_COMMIT}/apps/v4/registry/new-york-v4/ui/${f}.tsx`, name: `${f}.tsx`})),
    codemod: {modulePattern: '@/components/ui/{file}', exports: 'all'}, onePerFile: true},
  {id: 'chakra-3.37.0', library: 'Chakra UI', version: '3.37.0', homepage: 'https://chakra-ui.com/', framework: 'React', kind: 'types',
    artifacts: CHAKRA_RECIPES.map(f => ({url: `https://cdn.jsdelivr.net/npm/@chakra-ui/react@3.37.0/dist/esm/theme/recipes/${f}.js`, name: `${f}.js`})),
    codemod: {package: '@chakra-ui/react', exports: CHAKRA_SINGLE.map(pascal)}},
];

export const codemodBinding = (referenceId: string): CodemodBinding => REFERENCE_SOURCES.find(r => r.id === referenceId)?.codemod ?? {};

const ROOT = new URL('../references/', import.meta.url);
export type ReferenceSummary = {id: string; library: string; version: string; homepage: string; framework: string; kind: 'css' | 'types'; components: number; tokens: number; pinnedAt: string};

export async function listReferences(): Promise<ReferenceSummary[]> {
  const files = (await readdir(ROOT).catch(() => [] as string[])).filter(f => f.endsWith('.json')).sort();
  return Promise.all(files.map(async file => {
    const data = JSON.parse(await readFile(new URL(file, ROOT), 'utf8')) as ReferenceDSType & {meta?: {homepage?: string; framework?: string; kind?: 'css' | 'types'}};
    return {id: data.id, library: data.library, version: data.libraryVersion, homepage: data.meta?.homepage ?? '', framework: data.meta?.framework ?? '', kind: data.meta?.kind ?? 'css', components: data.components.length, tokens: data.tokens.length, pinnedAt: data.pinnedAt};
  }));
}

export async function loadReference(id: string): Promise<ReferenceDSType | null> {
  if (!/^[a-z0-9.@-]+$/i.test(id)) return null;
  try { return ReferenceDS.parse(JSON.parse(await readFile(new URL(`${id}.json`, ROOT), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
