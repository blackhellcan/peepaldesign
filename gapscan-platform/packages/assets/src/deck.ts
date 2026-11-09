// Branded PowerPoint template (architecture Part 3 §3.2). The theme's colour
// slots and fonts come from the brand kit, so any slide a team adds later picks
// them up: dk1 = text, lt1 = surface, accent1 = primary, major/minor = heading/body.
import {writeZip} from '@gapscan/adapters';
import {parseColor, toHex, toOklch} from '@gapscan/normalize';
import type {BrandKit} from './index.ts';

const EMU = 914400;                         // per inch
const W = 12192000, H = 6858000;            // 16:9, 13.333 × 7.5 in
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const xml = (text: string) => text.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!);
const hex = (color: string) => toHex({...parseColor(color)!, alpha: 1}).slice(1).toUpperCase();
// CSS keywords (system-ui, sans-serif…) are not font names Office understands; they become Arial.
export const CSS_GENERIC = /^(system-ui|-apple-system|blinkmacsystemfont|ui-sans-serif|sans-serif|serif|monospace|ui-monospace|cursive|fantasy|inherit|initial)$/i;
export const officeFont = (stack: string) => { const name = stack.split(',')[0]!.replace(/['"]/g, '').trim(); return !name || CSS_GENERIC.test(name) ? 'Arial' : name; };
const family = officeFont;

// Lighter and darker steps of the primary for the remaining accent slots.
function shade(color: string, deltaL: number): string {
  const {l, c, h} = toOklch(parseColor(color)!), rad = h * Math.PI / 180, L = Math.min(0.97, Math.max(0.15, l + deltaL));
  return hex(toHex(parseColor(`oklab(${L} ${c * Math.cos(rad)} ${c * Math.sin(rad)})`)!));
}

function theme(kit: BrandKit): string {
  const slot = (name: string, value: string) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;
  const {primary, text, surface, accent} = kit.colors;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme ${NS} name="${xml(kit.name)}"><a:themeElements>
<a:clrScheme name="${xml(kit.name)}">${slot('dk1', hex(text))}${slot('lt1', hex(surface))}${slot('dk2', shade(primary, -0.25))}${slot('lt2', shade(primary, 0.4))}
${slot('accent1', hex(primary))}${slot('accent2', hex(accent))}${slot('accent3', shade(primary, 0.2))}${slot('accent4', shade(primary, -0.15))}${slot('accent5', shade(accent, 0.2))}${slot('accent6', shade(accent, -0.15))}
${slot('hlink', hex(primary))}${slot('folHlink', shade(primary, -0.2))}</a:clrScheme>
<a:fontScheme name="${xml(kit.name)}"><a:majorFont><a:latin typeface="${xml(family(kit.fonts.heading))}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${xml(family(kit.fonts.body))}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="${xml(kit.name)}"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`;
}

type Box = {x: number; y: number; w: number; h: number};
const inches = (n: number) => Math.round(n * EMU);
let shapeId = 2;
function textBox(box: Box, paragraphs: {text: string; size: number; bold?: boolean; color: string; font: 'major' | 'minor'; bullet?: boolean}[]): string {
  const id = shapeId++;
  const runs = paragraphs.map(p => `<a:p>${p.bullet ? '<a:pPr marL="285750" indent="-285750"><a:buChar char="•"/></a:pPr>' : '<a:pPr><a:buNone/></a:pPr>'}<a:r><a:rPr lang="en-US" sz="${p.size * 100}"${p.bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:schemeClr val="${p.color}"/></a:solidFill><a:latin typeface="+${p.font === 'major' ? 'mj' : 'mn'}-lt"/></a:rPr><a:t>${xml(p.text)}</a:t></a:r></a:p>`).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>${runs}</p:txBody></p:sp>`;
}
function rect(box: Box, color: string, preset = 'rect'): string {
  const id = shapeId++;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.w}" cy="${box.h}"/></a:xfrm><a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
}
function slide(background: string, shapes: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="${background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

export type DeckContent = {title?: string; subtitle?: string; sections?: string[]; points?: string[]};
export function buildDeck(kit: BrandKit, content: DeckContent = {}): Buffer {
  shapeId = 2;
  const margin = inches(0.8), onPrimary = kit.colors.onPrimary === '#FFFFFF' ? 'lt1' : 'dk1';
  const title = content.title || `${kit.name} presentation`, points = content.points?.length ? content.points : ['First point', 'Second point', 'Third point'];
  const slides = [
    slide('accent1', [rect({x: margin, y: inches(5.9), w: inches(1.2), h: inches(0.08)}, onPrimary), textBox({x: margin, y: inches(2.4), w: W - 2 * margin, h: inches(2)}, [{text: title, size: 44, bold: true, color: onPrimary, font: 'major'}]),
      textBox({x: margin, y: inches(4.4), w: W - 2 * margin, h: inches(1)}, [{text: content.subtitle || kit.name, size: 20, color: onPrimary, font: 'minor'}])]),
    slide('lt1', [rect({x: 0, y: 0, w: inches(0.35), h: H}, 'accent1'), textBox({x: margin, y: inches(3), w: W - 2 * margin, h: inches(1.5)}, [{text: content.sections?.[0] || 'Section title', size: 36, bold: true, color: 'dk1', font: 'major'}])]),
    slide('lt1', [textBox({x: margin, y: inches(0.6), w: W - 2 * margin, h: inches(1)}, [{text: 'Slide title', size: 30, bold: true, color: 'dk1', font: 'major'}]), rect({x: margin, y: inches(1.55), w: inches(0.9), h: inches(0.06)}, 'accent1'),
      textBox({x: margin, y: inches(2), w: W - 2 * margin, h: inches(4.5)}, points.map(text => ({text, size: 20, color: 'dk1', font: 'minor', bullet: true})))]),
    slide('lt1', [textBox({x: margin, y: inches(0.6), w: W - 2 * margin, h: inches(1)}, [{text: 'Two columns', size: 30, bold: true, color: 'dk1', font: 'major'}]),
      rect({x: margin, y: inches(2), w: (W - 3 * margin) / 2, h: inches(4.3)}, 'lt2', 'roundRect'), rect({x: margin * 2 + (W - 3 * margin) / 2, y: inches(2), w: (W - 3 * margin) / 2, h: inches(4.3)}, 'lt2', 'roundRect'),
      textBox({x: margin + inches(0.3), y: inches(2.3), w: (W - 3 * margin) / 2 - inches(0.6), h: inches(3.8)}, [{text: 'Left', size: 22, bold: true, color: 'dk2', font: 'major'}, {text: 'Supporting text', size: 16, color: 'dk1', font: 'minor'}]),
      textBox({x: margin * 2 + (W - 3 * margin) / 2 + inches(0.3), y: inches(2.3), w: (W - 3 * margin) / 2 - inches(0.6), h: inches(3.8)}, [{text: 'Right', size: 22, bold: true, color: 'dk2', font: 'major'}, {text: 'Supporting text', size: 16, color: 'dk1', font: 'minor'}])]),
    slide('accent1', [textBox({x: margin, y: inches(3), w: W - 2 * margin, h: inches(1.5)}, [{text: 'Thank you', size: 44, bold: true, color: onPrimary, font: 'major'}])]),
  ];
  const slideRel = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>';
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>GapScan</dc:creator></cp:coreProperties>`,
    'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>GapScan</Application><Slides>${slides.length}</Slides></Properties>`,
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst>
<p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>${slides.map((_, i) => `<Relationship Id="rId${i + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`,
    'ppt/slideMasters/slideMaster1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    'ppt/theme/theme1.xml': theme(kit),
  };
  slides.forEach((body, i) => { files[`ppt/slides/slide${i + 1}.xml`] = body; files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = slideRel; });
  return writeZip(files);
}
