// A small, non-validating XML reader for Office Open XML parts. OOXML is
// machine-written and has no DTDs, so elements, attributes, text and the five
// predefined entities are all we need. External entities are never resolved.
export type XmlNode = {name: string; attrs: Record<string, string>; children: XmlNode[]; text: string};

const ENTITY: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
const decode = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(Math.min(0x10ffff, e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))) : ENTITY[e.toLowerCase()] ?? '');

export function parseXml(source: string): XmlNode {
  const root: XmlNode = {name: '#document', attrs: {}, children: [], text: ''}, stack = [root];
  const tag = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0, match: RegExpExecArray | null;
  while ((match = tag.exec(source))) {
    const current = stack[stack.length - 1]!;
    if (match.index > last) current.text += decode(source.slice(last, match.index));
    last = tag.lastIndex;
    if (match[1] !== undefined) { current.text += match[1]; continue; }
    if (match[2]) {
      if (stack.length > 1 && current.name === match[2]) stack.pop();
      continue;
    }
    if (!match[3]) continue;   // comment, processing instruction or doctype
    const attrs: Record<string, string> = {};
    for (const a of (match[4] ?? '').matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = decode(a[2] ?? a[3] ?? '');
    const node: XmlNode = {name: match[3], attrs, children: [], text: ''};
    current.children.push(node);
    if (!match[5]) stack.push(node);
  }
  return root;
}

const local = (name: string) => name.slice(name.indexOf(':') + 1);
// Matches by local name so `a:srgbClr` and `srgbClr` are found alike.
export function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.name === name || local(child.name) === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}
export const find = (node: XmlNode, name: string): XmlNode | undefined => findAll(node, name)[0];
export const child = (node: XmlNode | undefined, name: string) => node?.children.find(c => c.name === name || local(c.name) === name);
export const textOf = (node: XmlNode): string => node.text + node.children.map(textOf).join('');
export const attr = (node: XmlNode | undefined, name: string) => node ? node.attrs[name] ?? Object.entries(node.attrs).find(([k]) => local(k) === name)?.[1] : undefined;
