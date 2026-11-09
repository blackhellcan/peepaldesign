// Saved evidence is a reusable local bundle. Retrieval limits describe its import,
// not a request to upload the same library again.
export function savedLibrarySummary(profile,inventory,previewAssets={}){
 const items=inventory.items;
 if(!Array.isArray(items)||!items.length)throw new Error('The saved design system has no implementation evidence. Re-import its public Git reference.');
 if(Number.isFinite(profile.itemCount)&&profile.itemCount!==items.length)throw new Error('Saved design-system integrity check failed. Re-import its public reference to restore the saved inventory.');
 const ids=items.map(item=>item.id);if(new Set(ids).size!==ids.length)throw new Error('Saved design-system integrity check failed: duplicate item identifiers.');
 const counts={components:0,colors:0,typography:0,tokens:0,icons:0,variants:0,examples:0};
 for(const item of items){if(item.kind==='component'&&!item.icon)counts.components++;if(item.visualFamily==='Colors')counts.colors++;if(item.visualFamily==='Typography')counts.typography++;if(item.kind==='token')counts.tokens++;if(item.icon)counts.icons++;counts.variants+=item.variants?.length||0;if(item.html)counts.examples++}
 return {schemaVersion:1,state:'ready',id:profile.id||null,name:profile.name,version:profile.version||'',items:items.length,counts,sourceFiles:profile.files?.length||0,styles:(previewAssets.styles?.length||0)+(previewAssets.pages||[]).filter(page=>page.css).length,runtimes:previewAssets.runtimes?.length||0,uploadRequired:false,statement:'All saved items, examples, tokens and preview assets are loaded from this library. No source upload is required. Import coverage and unresolved implementation facts remain in the evidence ledger.'};
}
export function applySavedLibraryContext(report,libraries){
 report.savedLibraries=libraries;
 report.savedLibraryComparison=!!libraries.old&&!!libraries.new;
 if(report.savedLibraryComparison){
  report.evidenceStatus='saved-library';
  report.notes=report.notes.filter(note=>!note.startsWith('Uploads are optional.'));
  report.notes.unshift('Both saved libraries are loaded in full. No uploads are required. Unverified mappings describe unresolved facts or counterparts within the saved evidence; they do not mean saved items were discarded. Import coverage is preserved in the source ledger.');
  for(const item of report.items)if(item.status==='Unverified'){
   const unresolved=[item.old,item.new].filter(Boolean).some(value=>value.sourceIssue||value.aliasIssues?.length);
   item.action=unresolved?'Review the saved source evidence and resolved token values before planning this change. No upload is required.':'Review the source and target galleries for an equivalent item. No counterpart was identified in the saved inventories; absence or a need to create one is not inferred.';
   item.insight={...item.insight,actions:[item.action]};
  }
 }
 return report;
}
export function websitePlaceholders(inventory){
 const items=inventory.items,placeholders=[];
 const add=(id,name,category,reason,itemId=null)=>placeholders.push({id,name,category,reason,itemId,status:'unknown',attachments:[]});
 for(const [name,category,predicate]of [['Colors','Foundations and tokens',item=>item.visualFamily==='Colors'],['Typography','Foundations and tokens',item=>item.visualFamily==='Typography'],['Design tokens','Foundations and tokens',item=>item.kind==='token'],['Icons','Media and identity',item=>item.icon],['Components','Actions',item=>item.kind==='component'&&!item.icon]])if(!items.some(predicate))add('family:'+name,name,category,'Not observed in the accessible website sample. This is an unknown capability, not a confirmed omission.');
 for(const item of items.filter(item=>item.kind==='component'&&!item.icon)){
  if(!item.html)add('example:'+item.id,item.name+' · visual example',item.category,'Implementation example not available from the static website sample.',item.id);
  if(!Object.entries(item.styleProfile||{}).some(([state,value])=>state!=='default'&&value&&Object.keys(value).length))add('states:'+item.id,item.name+' · interaction states',item.category,'Interactive and authenticated states cannot be verified from the retrieved static markup alone.',item.id);
 }
 return placeholders;
}
export function mergeSavedEvidence(inventory,supplement){
 const entries=new Map(inventory.items.map(item=>[item.id,structuredClone(item)]));
 for(const incoming of supplement.items){const prior=entries.get(incoming.id);if(!prior){entries.set(incoming.id,structuredClone(incoming));continue}
  const merged={...prior};for(const [key,value]of Object.entries(incoming))if(value!==null&&value!==undefined&&value!==''&&(!Array.isArray(value)||value.length))merged[key]=structuredClone(value);
  merged.values=[...new Set([...(prior.values||[]),...(incoming.values||[])])];merged.evidence=[...(prior.evidence||[]),...(incoming.evidence||[])];merged.variants=[...new Map([...(prior.variants||[]),...(incoming.variants||[])].map(variant=>[variant.html,variant])).values()];merged.css=[prior.css,incoming.css].filter(Boolean).join('\n');merged.previewCss=[prior.previewCss,incoming.previewCss].filter(Boolean).join('\n');entries.set(incoming.id,merged);
 }
 return {...inventory,items:[...entries.values()],documents:(inventory.documents||0)+(supplement.documents||0),characters:(inventory.characters||0)+(supplement.characters||0)};
}
