// The design-system book: the laid-out system (the same page people see in GapScan) set
// for A4 print, followed by the documentation the team has approved. Rendered to PDF in
// a browser with no network, so everything here is self-contained and nothing is run.
import {renderDesignSystemHtml} from './design-system.ts';
import type {DesignSystemDoc} from './design-system.ts';

export type BookDocument = {title: string; sections: {title: string; content: string; missing?: string[]}[]};

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]!);
const inline = (text: string) => esc(text)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)]|$)/g, '$1<em>$2</em>')
  .replace(/(^|[\s(])\*([^*]+)\*(?=[\s.,;:)]|$)/g, '$1<em>$2</em>');

// The Markdown GapScan and Claude write: headings, lists, tables, fenced code, bold, italic, code.
export function markdownToHtml(source: string): string {
  const lines = source.split('\n'), out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```')) { const code: string[] = []; while (++i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i]!); out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue; }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) { out.push(`<h4>${inline(heading[2]!)}</h4>`); continue; }
    if (/^[-*] /.test(line)) { const items: string[] = []; while (i < lines.length && /^[-*] /.test(lines[i]!)) items.push(`<li>${inline(lines[i++]!.slice(2))}</li>`); i--; out.push(`<ul>${items.join('')}</ul>`); continue; }
    if (/^\d+\. /.test(line)) { const items: string[] = []; while (i < lines.length && /^\d+\. /.test(lines[i]!)) items.push(`<li>${inline(lines[i++]!.replace(/^\d+\. /, ''))}</li>`); i--; out.push(`<ol>${items.join('')}</ol>`); continue; }
    if (line.startsWith('|')) {
      const rows: string[] = []; while (i < lines.length && lines[i]!.startsWith('|')) rows.push(lines[i++]!); i--;
      const cells = (row: string) => row.split('|').slice(1, -1).map(c => c.trim());
      out.push(`<table><tr>${cells(rows[0]!).map(c => `<th>${inline(c)}</th>`).join('')}</tr>${rows.slice(2).map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`);
      continue;
    }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  return out.join('\n');
}

export function renderDesignSystemBook(doc: DesignSystemDoc, documents: BookDocument[]): string {
  const written = documents.filter(d => d.sections.length);
  const docs = written.length
    ? written.map(d => `<section class="book-doc"><h2>${esc(d.title)}</h2>${d.sections.map(s => `<article><h3>${esc(s.title)}</h3>${markdownToHtml(s.content)}${s.missing?.length
        ? `<aside class="missing"><strong>Missing</strong><ul>${s.missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul></aside>` : ''}</article>`).join('')}</section>`).join('')
    : '<section class="book-doc"><h2>Documentation</h2><p class="empty">No documentation has been written yet. Open Documents in GapScan to write it, and it appears here.</p></section>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(doc.name)} design system</title>
${renderDesignSystemHtml(doc, {})}
<style>
@page { size: A4; margin: 16mm 14mm; }
@media print {
  html, body { background: #fff !important; }
  nav { display: none !important; }
  .app { display: block !important; }
  main, .page { padding: 0 !important; margin: 0 !important; max-width: none !important; background: #fff !important; }
  section { break-before: page; }
  section#colours { break-before: auto; }
  .frame, .type, .variant, article, table, pre { break-inside: avoid; }
  .cover { break-after: page; }
}
.book-doc { font-family: var(--ui); color: var(--fg); max-width: 72ch; }
.book-doc h2 { font-size: 26px; margin: 0 0 16px; }
.book-doc h3 { font-size: 17px; margin: 22px 0 8px; }
.book-doc h4 { font-size: 14px; margin: 14px 0 6px; }
.book-doc p, .book-doc li { font-size: 13px; line-height: 1.55; }
.book-doc table { border-collapse: collapse; font-size: 12px; margin: 8px 0; }
.book-doc th, .book-doc td { border: 1px solid var(--line); padding: 5px 8px; text-align: left; }
.book-doc .missing { margin: 10px 0 4px; padding: 8px 12px; border: 1px solid #e9b949; background: #fff7df; border-radius: 6px; font-size: 12px; break-inside: avoid; }
.book-doc .missing strong { color: #8a5a00; } .book-doc .missing ul { margin: 4px 0 0; padding-left: 18px; }
.book-doc pre { font-family: var(--mono); font-size: 10.5px; background: var(--sidebar); padding: 10px; white-space: pre-wrap; border-radius: 6px; }
</style>
<div class="page book-docs">${docs}</div>
</html>`;
}
