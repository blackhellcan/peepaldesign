// GapScan Importer: applies a GapScan "Export to Figma" file (format gapscan-figma/1) to the
// open Figma file. The export already decided names, scopes, aliases and component colours;
// this only creates them. Re-running updates variables and styles by name and skips
// component sets that already exist, so it never deletes anyone's work.
const FORMAT = 'gapscan-figma/1';
const WEIGHT_STYLES = {100: ['Thin'], 200: ['Extra Light', 'ExtraLight'], 300: ['Light'], 400: ['Regular', 'Book'], 500: ['Medium'], 600: ['Semi Bold', 'SemiBold'], 700: ['Bold'], 800: ['Extra Bold', 'ExtraBold'], 900: ['Black']};

figma.showUI(__html__, {width: 380, height: 520, themeColors: true});

// Standard Plugin API only: an auto-layout frame that hugs its content.
function autoLayout(direction, props) {
  const f = figma.createFrame();
  f.layoutMode = direction;
  f.primaryAxisSizingMode = 'AUTO';
  f.counterAxisSizingMode = 'AUTO';
  f.fills = [];
  for (const k of Object.keys(props || {})) f[k] = props[k];
  return f;
}

function post(type, data) { figma.ui.postMessage(Object.assign({type: type}, data || {})); }

async function chooseFont(plan) {
  const available = await figma.listAvailableFontsAsync();
  const families = {};
  for (const f of available) (families[f.fontName.family] = families[f.fontName.family] || []).push(f.fontName.style);
  const wanted = (plan.fonts.families || []).map(function (f) { return f.toLowerCase().replace(/[-_ ]?(web|variable|vf)$/, ''); });
  let family = Object.keys(families).find(function (f) { return wanted.indexOf(f.toLowerCase()) >= 0; });
  const substituted = !family;
  if (!family) family = plan.fonts.fallbacks.find(function (f) { return families[f]; }) || 'Inter';
  const styleFor = function (weight) {
    const names = WEIGHT_STYLES[Math.round(weight / 100) * 100] || ['Regular'];
    return names.find(function (n) { return families[family].indexOf(n) >= 0; }) || (families[family].indexOf('Regular') >= 0 ? 'Regular' : families[family][0]);
  };
  return {family: family, substituted: substituted, original: plan.fonts.families[0], styleFor: styleFor};
}

async function buildVariables(plan) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const existing = await figma.variables.getLocalVariablesAsync();
  const byName = {};
  let count = 0;
  for (const spec of plan.collections) {
    let collection = collections.find(function (c) { return c.name === spec.name; });
    if (!collection) { collection = figma.variables.createVariableCollection(spec.name); collection.renameMode(collection.modes[0].modeId, spec.mode); }
    const mode = collection.modes[0].modeId;
    for (const v of spec.variables) {
      let variable = existing.find(function (e) { return e.name === v.name && e.variableCollectionId === collection.id; });
      if (!variable) variable = figma.variables.createVariable(v.name, collection, v.type);
      const value = v.value && v.value.alias ? {type: 'VARIABLE_ALIAS', id: byName[v.value.alias].id} : v.value;
      variable.setValueForMode(mode, value);
      variable.scopes = v.scopes;
      if (v.web) variable.setVariableCodeSyntax('WEB', v.web);
      if (v.description) variable.description = v.description;
      byName[v.name] = variable;
      count++;
    }
  }
  return {byName: byName, count: count};
}

async function buildTextStyles(plan, font) {
  const existing = await figma.getLocalTextStylesAsync();
  const byName = {};
  for (const t of plan.textStyles) {
    const style = font.styleFor(t.weight);
    await figma.loadFontAsync({family: font.family, style: style});
    const s = existing.find(function (e) { return e.name === t.name; }) || figma.createTextStyle();
    s.name = t.name;
    s.fontName = {family: font.family, style: style};
    s.fontSize = t.size;
    s.lineHeight = t.lineHeight ? {unit: 'PIXELS', value: t.lineHeight} : {unit: 'AUTO'};
    s.description = t.description + (font.substituted && font.original ? ' Shown in ' + font.family + ' because ' + font.original + ' is not available in Figma.' : '');
    byName[t.name] = s;
  }
  return byName;
}

async function buildEffectStyles(plan) {
  const existing = await figma.getLocalEffectStylesAsync();
  for (const e of plan.effectStyles) {
    const s = existing.find(function (x) { return x.name === e.name; }) || figma.createEffectStyle();
    s.name = e.name;
    s.description = e.description;
    s.effects = e.shadows.map(function (sh) {
      return {type: sh.inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color: sh.color, offset: {x: sh.x, y: sh.y}, radius: sh.blur, spread: sh.spread, visible: true, blendMode: 'NORMAL'};
    });
  }
  return plan.effectStyles.length;
}

async function page(name) {
  let p = figma.root.children.find(function (x) { return x.name === name; });
  if (!p) { p = figma.createPage(); p.name = name; }
  await p.loadAsync();
  return p;
}

function solid(ref, vars) {
  if (!ref) return null;
  if (ref.variable && vars[ref.variable]) return figma.variables.setBoundVariableForPaint({type: 'SOLID', color: {r: 0, g: 0, b: 0}}, 'color', vars[ref.variable]);
  const c = ref.hex || {r: 0, g: 0, b: 0, a: 1};
  return {type: 'SOLID', color: {r: c.r, g: c.g, b: c.b}, opacity: c.a};
}
function bindNumber(node, fields, ref, vars) {
  if (ref && typeof ref === 'object' && vars[ref.variable]) { for (const f of fields) node.setBoundVariable(f, vars[ref.variable]); return; }
  for (const f of fields) node[f] = typeof ref === 'number' ? ref : 0;
}

async function buildComponents(plan, vars, styles, target) {
  const created = [], skipped = [];
  let y = 100;
  for (const spec of plan.components) {
    if (target.findOne(function (n) { return n.type === 'COMPONENT_SET' && n.name === spec.name; })) { skipped.push(spec.name); continue; }
    const variants = [];
    for (const v of spec.variants) {
      const c = figma.createComponent();
      c.name = v.name;
      c.layoutMode = 'HORIZONTAL';
      c.primaryAxisAlignItems = v.width ? 'MIN' : 'CENTER';
      c.counterAxisAlignItems = 'CENTER';
      c.resize(v.width || 100, v.height);
      c.primaryAxisSizingMode = v.width ? 'FIXED' : 'AUTO';
      c.counterAxisSizingMode = 'FIXED';
      const fill = solid(v.fill, vars);
      c.fills = fill ? [fill] : [];
      const stroke = solid(v.stroke, vars);
      if (stroke && v.strokeWeight) { c.strokes = [stroke]; c.strokeWeight = v.strokeWeight; c.strokeAlign = 'INSIDE'; }
      bindNumber(c, ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'], v.radius, vars);
      bindNumber(c, ['paddingLeft', 'paddingRight'], v.paddingX, vars);
      const text = figma.createText();
      const style = styles[v.textStyle];
      if (style) { await figma.loadFontAsync(style.fontName); await text.setTextStyleIdAsync(style.id); }
      else await figma.loadFontAsync(text.fontName);
      text.characters = v.label;
      text.name = 'Label';
      text.fills = [solid(v.text, vars)];
      if (v.underline) text.textDecoration = 'UNDERLINE';
      c.appendChild(text);
      c.opacity = typeof v.opacity === 'number' ? v.opacity : 1;
      c.effects = (v.effects || []).map(function (e) {
        return {type: e.inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color: e.color, offset: {x: e.x, y: e.y}, radius: e.blur, spread: e.spread, visible: true, blendMode: 'NORMAL'};
      });
      variants.push(c);
    }
    const set = figma.combineAsVariants(variants, target);
    set.name = spec.name;
    set.description = spec.description;
    // Grid: a row per Style, a column per State (variants stack at 0,0 after combining).
    const rows = [], columns = [], cells = new Map();
    for (const comp of set.children) {
      const props = {};
      comp.name.split(',').forEach(function (part) { const kv = part.split('='); props[kv[0].trim()] = (kv[1] || '').trim(); });
      if (rows.indexOf(props.Style) < 0) rows.push(props.Style);
      if (columns.indexOf(props.State || 'Default') < 0) columns.push(props.State || 'Default');
      cells.set(comp.id, [rows.indexOf(props.Style), columns.indexOf(props.State || 'Default')]);
    }
    const colWidth = Math.max.apply(null, set.children.map(function (n) { return n.width; })) + 32, rowHeight = Math.max.apply(null, set.children.map(function (n) { return n.height; })) + 32;
    for (const comp of set.children) { const cell = cells.get(comp.id); comp.x = 32 + cell[1] * colWidth; comp.y = 32 + cell[0] * rowHeight; }
    set.resize(32 + columns.length * colWidth, 32 + rows.length * rowHeight);
    const key = set.addComponentProperty('Label', 'TEXT', spec.variants[0].label);
    for (const comp of set.children) comp.findOne(function (n) { return n.type === 'TEXT'; }).componentPropertyReferences = {characters: key};
    set.x = 100; set.y = y;
    y += set.height + 64;
    created.push(set.id);
  }
  return {created: created, skipped: skipped};
}

// A specimen sheet: every colour variable as a swatch, every text style as a sample.
async function buildFoundations(plan, vars, styles, font, target) {
  if (target.findOne(function (n) { return n.name === 'Foundations / ' + plan.name; })) return null;
  await figma.loadFontAsync({family: font.family, style: font.styleFor(400)});
  await figma.loadFontAsync({family: font.family, style: font.styleFor(700)});
  const label = function (text, size, weight) {
    const t = figma.createText();
    t.fontName = {family: font.family, style: font.styleFor(weight || 400)};
    t.fontSize = size || 12;
    t.characters = text;
    return t;
  };
  const sheet = autoLayout('VERTICAL', {name: 'Foundations / ' + plan.name, itemSpacing: 40, paddingLeft: 48, paddingRight: 48, paddingTop: 48, paddingBottom: 48});
  sheet.fills = [{type: 'SOLID', color: {r: 1, g: 1, b: 1}}];
  sheet.x = 100; sheet.y = 100;
  sheet.appendChild(label(plan.name, 32, 700));
  sheet.appendChild(label('Extracted from ' + plan.source + ' by GapScan.', 14));
  const primitives = plan.collections.find(function (c) { return c.name === 'Primitives'; });
  const groups = {};
  for (const v of primitives ? primitives.variables : []) (groups[v.name.split('/')[0]] = groups[v.name.split('/')[0]] || []).push(v.name);
  for (const g of Object.keys(groups)) {
    const block = autoLayout('VERTICAL', {name: 'Colour / ' + g, itemSpacing: 8});
    block.fills = [];
    block.appendChild(label(g, 14, 700));
    const row = autoLayout('HORIZONTAL', {name: 'Swatches', itemSpacing: 8});
    row.fills = [];
    for (const name of groups[g]) {
      const cell = autoLayout('VERTICAL', {name: name, itemSpacing: 4});
      cell.fills = [];
      const chip = figma.createRectangle();
      chip.resize(72, 48); chip.cornerRadius = 6;
      chip.fills = [solid({variable: name}, vars)];
      chip.strokes = [{type: 'SOLID', color: {r: 0, g: 0, b: 0}, opacity: 0.08}];
      cell.appendChild(chip);
      cell.appendChild(label(name.split('/').slice(1).join('/'), 11));
      row.appendChild(cell);
    }
    block.appendChild(row);
    sheet.appendChild(block);
  }
  const type = autoLayout('VERTICAL', {name: 'Text styles', itemSpacing: 12});
  type.fills = [];
  type.appendChild(label('Text styles', 14, 700));
  for (const t of plan.textStyles) {
    const sample = figma.createText();
    const style = styles[t.name];
    if (!style) continue;
    await figma.loadFontAsync(style.fontName);
    await sample.setTextStyleIdAsync(style.id);
    sample.characters = t.name + '  The quick brown fox jumps over the lazy dog';
    type.appendChild(sample);
  }
  sheet.appendChild(type);
  return sheet.id;
}

figma.ui.onmessage = async function (msg) {
  if (msg.type !== 'build') return;
  const plan = msg.plan;
  try {
    if (!plan || plan.format !== FORMAT) throw new Error('This is not a GapScan Figma export (expected ' + FORMAT + ').');
    post('progress', {message: 'Choosing fonts…'});
    const font = await chooseFont(plan);
    const result = {font: font.family, substituted: font.substituted};
    // Variables and styles always come first: the foundations page and components use them.
    post('progress', {message: 'Creating variables…'});
    const v = await buildVariables(plan), vars = v.byName;
    result.variables = v.count;
    post('progress', {message: 'Creating text and effect styles…'});
    const styles = await buildTextStyles(plan, font);
    result.textStyles = plan.textStyles.length;
    result.effectStyles = await buildEffectStyles(plan);
    if (msg.options.foundations) { post('progress', {message: 'Drawing the foundations page…'}); const p = await page('Foundations'); await figma.setCurrentPageAsync(p); result.foundations = await buildFoundations(plan, vars, styles, font, p); }
    if (msg.options.components) { post('progress', {message: 'Building components…'}); const p = await page('Components'); await figma.setCurrentPageAsync(p); const c = await buildComponents(plan, vars, styles, p); result.components = c.created.length; result.skipped = c.skipped; }
    post('done', {result: result});
  } catch (error) {
    post('error', {message: error && error.message ? error.message : String(error)});
  }
};
