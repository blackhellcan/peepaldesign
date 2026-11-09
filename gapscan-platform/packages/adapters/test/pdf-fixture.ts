// Builds a tiny, valid PDF in memory: text in a named font plus a filled swatch.
export function brandPdf(pages: {lines: [number, string][]; fill?: [number, number, number]}[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Name /F1 >>');
  const pageIds: number[] = [], pagesId = 2 + pages.length * 2;
  for (const page of pages) {
    let y = 760, stream = '';
    if (page.fill) stream += `${page.fill.map(v => (v / 255).toFixed(4)).join(' ')} rg 400 600 120 80 re f\n`;
    for (const [size, text] of page.lines) { stream += `BT /F1 ${size} Tf 50 ${y} Td (${text.replace(/[()\\]/g, m => '\\' + m)}) Tj ET\n`; y -= size + 12; }
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  add(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const offset = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${body}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
