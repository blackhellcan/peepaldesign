// Small, hand-written Office documents built in memory for adapter tests.
import {writeZip} from '../src/zip.ts';

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
export const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme ${A} name="Acme"><a:themeElements>
 <a:clrScheme name="Acme">
  <a:dk1><a:sysClr val="windowText" lastClr="1A1A1A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
  <a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
  <a:accent1><a:srgbClr val="0052CC"/></a:accent1><a:accent2><a:srgbClr val="FF5630"/></a:accent2>
  <a:accent3><a:srgbClr val="36B37E"/></a:accent3><a:accent4><a:srgbClr val="FFAB00"/></a:accent4>
  <a:accent5><a:srgbClr val="6554C0"/></a:accent5><a:accent6><a:srgbClr val="00B8D9"/></a:accent6>
  <a:hlink><a:srgbClr val="0052CC"/></a:hlink><a:folHlink><a:srgbClr val="5243AA"/></a:folHlink>
 </a:clrScheme>
 <a:fontScheme name="Acme"><a:majorFont><a:latin typeface="Inter Display"/></a:majorFont><a:minorFont><a:latin typeface="Inter"/></a:minorFont></a:fontScheme>
</a:themeElements></a:theme>`;

export function pptx(): Buffer {
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const slide = (title: string, body: string) => `<p:sld ${P} ${A}><p:cSld><p:spTree>
   <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:rPr sz="4000"><a:latin typeface="Inter Display"/></a:rPr><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
   <p:sp><p:spPr><a:solidFill><a:srgbClr val="0052CC"/></a:solidFill></p:spPr><p:txBody><a:p><a:r><a:rPr sz="1800"/><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  return writeZip({
    '[Content_Types].xml': '<Types/>', 'ppt/presentation.xml': `<p:presentation ${P}/>`, 'ppt/theme/theme1.xml': THEME,
    'ppt/slides/slide1.xml': slide('Acme brand', 'We keep things simple &amp; direct.'),
    'ppt/slides/slide2.xml': slide('Our voice', 'Plain words. Short sentences.'),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${P}><p:cSld name="Title Slide"/></p:sldLayout>`,
    'ppt/media/acme-logo.png': new Uint8Array([137, 80, 78, 71]),
  });
}

export function docx(): Buffer {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const p = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  return writeZip({
    'word/document.xml': `<w:document ${W}><w:body>${p('Acme brand guidelines', 'Title')}${p('Voice and tone', 'Heading1')}${p('We sound like a helpful expert, never a salesperson.')}${p('Logo', 'Heading1')}${p('Keep clear space equal to the cap height.')}</w:body></w:document>`,
    'word/styles.xml': `<w:styles ${W}>
      <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Inter"/><w:sz w:val="22"/><w:color w:val="1A1A1A"/></w:rPr></w:style>
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:rFonts w:ascii="Inter Display"/><w:b/><w:sz w:val="48"/><w:color w:val="0052CC"/></w:rPr></w:style>
    </w:styles>`,
    'word/theme/theme1.xml': THEME,
  });
}
