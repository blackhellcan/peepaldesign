/* Original examples only. Each runtime lives in an opaque-origin sandbox. */
const previewFrames=new Map();
const previewLocalCss=new WeakMap();
function previewResources(item,label){const key=/CURRENT|SOURCE/.test(label)?'old':'new',system=(label.startsWith('LIBRARY')?libraryViewer?.assets:report?.previewSystems?.[key])||{pages:[],styles:[],runtimes:[]};const source=item.selectedVariant?.source||item.variants?.find(v=>v.html===item.html)?.source||item.documentationUrl?.split('#')[0]||item.evidence?.find(e=>/html|components?\//.test(e.source))?.source||item.evidence?.[0]?.source;const page=system.pages.find(p=>p.source===source)||system.pages.find(p=>p.base)||system.pages[0]||{};let local=previewLocalCss.get(system);if(local===undefined){local=(system.pages||[]).filter(p=>!p.base).map(p=>p.css||'').join('\n');previewLocalCss.set(system,local)}return {base:page.base||'',styles:[...new Set([...(system.styles||[]),...(page.styles||[])])],css:[local,page.base?page.css:'',item.contextCss||'',item.previewCss||item.css||'',item.selectedVariant?.css||item.variants?.find(v=>v.html===item.html)?.css||''].filter(Boolean).join('\n'),sprites:/<use\b/i.test(item.html||'')?(page.base?page.sprites||'':system.pages.filter(p=>!p.base).map(p=>p.sprites||'').join('')):'',bodyClass:page.bodyClass||'',htmlAttributes:page.htmlAttributes||{},bodyAttributes:page.bodyAttributes||{},runtimes:(system.runtimes||[]).filter(runtime=>!runtime.tags?.length||runtime.tags.some(tag=>item.html?.includes('<'+tag)))}}
// Pass the workspace theme into the sandbox so extracted examples use the same
// surface treatment as the surrounding review cards.
const previewResourcesWithTheme=previewResources;
previewResources=(item,label)=>({...previewResourcesWithTheme(item,label),theme:document.body?.dataset.theme||'light'});
// Keep every specimen available; initialize sandbox runtimes only near the viewport.
const previewSlots=new Map();
const previewBatches=new Map();
let previewSweepScheduled=false;
function releasePreview(slot){if(slot.frame){slot.frame.remove();slot.frame=null;previewFrames.delete(slot.id)}slot.host.classList.remove('preview-mounted');if(slot.host.isConnected&&!slot.frame)slot.host.textContent='Original example loads when visible'}
function sweepPreviews(){previewSweepScheduled=false;for(const [id,slot]of previewSlots)if(!slot.host.isConnected){releasePreview(slot);previewObserver.unobserve(slot.host);previewSlots.delete(id)}for(const [root,observer]of previewBatches)if(!root.isConnected){observer.disconnect();previewBatches.delete(root)}pumpPreviews()}
function schedulePreviewSweep(){if(!previewSweepScheduled){previewSweepScheduled=true;requestAnimationFrame(sweepPreviews)}}
function pumpPreviews(){for(const slot of previewSlots.values()){if(!slot.visible||slot.frame||!slot.host.isConnected)continue;mountPreview(slot)}}
const previewObserver=new IntersectionObserver(entries=>{for(const observation of entries){const slot=previewSlots.get(observation.target.dataset.previewId);if(!slot)continue;slot.visible=observation.isIntersecting;if(!slot.visible&&slot.frame)releasePreview(slot)}schedulePreviewSweep()},{rootMargin:'80px'});
new MutationObserver(schedulePreviewSweep).observe(document.documentElement,{childList:true,subtree:true});
function mountPreview(slot){
 const {item,label,state,onStatus}=slot,frame=document.createElement('iframe');frame.title=label+' '+item.name+' '+state;frame.sandbox='allow-scripts';frame.src='/preview.html';slot.frame=frame;slot.host.replaceChildren(frame);slot.host.classList.add('preview-mounted');
 const entry={frame,onStatus,started:false};previewFrames.set(slot.id,entry);frame.addEventListener('load',()=>{if(slot.frame!==frame)return;const payload={id:slot.id,html:item.html,icon:!!item.icon,...previewResources(item,label),tokens:item.tokens||[],state,properties:item.styleProfile?.[state]||{}};frame.contentWindow.postMessage({type:'gapscan-preview',payload},'*')});
}
function originalFrame(item,label,state='default',onStatus=()=>{}){if(!item?.html)return null;const host=document.createElement('div'),id=crypto.randomUUID();host.className='preview-runtime-host';host.dataset.previewId=id;host.textContent='Original example loads when visible';previewSlots.set(id,{id,host,item,label,state,onStatus,frame:null,visible:false});previewObserver.observe(host);return host}
window.addEventListener('message',event=>{const message=event.data;if(message?.type!=='gapscan-preview-status')return;const entry=previewFrames.get(message.id);if(!entry||event.source!==entry.frame.contentWindow)return;entry.started=true;entry.onStatus(message.message,message.error)});

// Display every retrieved example; pair only explicit matching presentation labels.
function retrievedPreviewVariants(item){
 if(!item)return [];if(!item.html||item.icon||['token','foundation'].includes(item.kind))return [{item,key:'default',label:'Default'}];
 const variants=item.variants?.length?item.variants:[{html:item.html}];return variants.filter(variant=>variant.html).map((variant,index)=>{
  const html=variant.html,first=html.match(/^<[^>]+>/)?.[0]||html;
  const names=[variant.label,variant.name,...[...first.matchAll(/(?:variant|appearance|size)=["']([^"']+)/gi)].map(match=>match[1])].filter(Boolean);
  const classes=[...first.matchAll(/class(?:Name)?=["']([^"']+)/gi)].flatMap(match=>match[1].split(/\s+/));
  const flags=[...new Set([...classes.flatMap(name=>name.toLowerCase().split(/[-_]/)).filter(word=>['primary','secondary','tertiary','outline','outlined','filled','solid','text','ghost','danger','success','warning','small','sm','medium','large','lg','tonal','loading','selected','disabled'].includes(word)),...['disabled','checked','readonly'].filter(word=>new RegExp('\\b'+word+'(?:[= >])','i').test(first))])].map(word=>({sm:'small',md:'medium',lg:'large',outlined:'outline'})[word]||word).sort();
  const explicit=[...new Set([...names,...flags])].join(' · '),label=(variant.completeExample?'Full example · ':'')+(explicit||'Example '+(index+1));
  const key=(variant.completeExample?'full:':'')+(explicit?explicit.toLowerCase():'unlabelled:'+index);
  return {item:{...item,name:variant.specimenName||item.name,styleProfile:variant.styleProfile||item.styleProfile,tokens:variant.tokens||item.tokens,documentationUrl:variant.sectionUrl||variant.documentationUrl||item.documentationUrl,html:variant.html,selectedVariant:variant,variants:[]},key,label};
 });
}
function pairPreviewVariants(source,target){
 const a=retrievedPreviewVariants(source),b=retrievedPreviewVariants(target),used=new Set(),rows=[];
 for(const entry of a){const match=b.findIndex((other,index)=>!used.has(index)&&other.key===entry.key);if(match>=0)used.add(match);rows.push({old:entry.item,new:match>=0?b[match].item:null,label:entry.label});}
 for(let index=0;index<b.length;index++)if(!used.has(index))rows.push({old:null,new:b[index].item,label:b[index].label});return rows.length?rows:[{old:source,new:target,label:'Default'}];
}
function makeVariantPreview(item,side,label){const specimen=makeSinglePreview(item,side+' · '+label);specimen.classList.add('variant-specimen');return specimen}
// Build long lists only as they approach the viewport. All variants remain
// reachable by scrolling; detached lists stop allocating nodes immediately.
function appendPreviewBatches(root,entries,create){let next=0;const sentinel=document.createElement('div');sentinel.className='preview-batch-sentinel';sentinel.setAttribute('aria-hidden','true');root.append(sentinel);const observer=new IntersectionObserver(observations=>{if(!observations.some(entry=>entry.isIntersecting))return;if(!root.isConnected){observer.disconnect();previewBatches.delete(root);return}observer.unobserve(sentinel);const fragment=document.createDocumentFragment(),end=Math.min(next+12,entries.length);while(next<end)fragment.append(create(entries[next++]));sentinel.before(fragment);if(next===entries.length){observer.disconnect();previewBatches.delete(root);sentinel.remove()}else observer.observe(sentinel)},{rootMargin:'300px'});previewBatches.set(root,observer);observer.observe(sentinel)}
function makePreview(item,label){const entries=retrievedPreviewVariants(item);if(entries.length<=1)return makeSinglePreview(entries[0]?.item||item,label);const stack=document.createElement('div');stack.className='variant-stack';appendPreviewBatches(stack,entries,entry=>makeVariantPreview(entry.item,label,entry.label));return stack}
function makeComparisonPreviews(source,target){const root=document.createElement('div');root.className='paired-variants';appendPreviewBatches(root,pairPreviewVariants(source,target),pair=>{const row=document.createElement('section');row.className='variant-pair';const title=document.createElement('h4');title.textContent=pair.label;row.append(title,makeVariantPreview(pair.old,'SOURCE',pair.label),makeVariantPreview(pair.new,'TARGET',pair.label));return row});return root}

function exportPreviewHosts(card,runtimeCode){for(const host of card.querySelectorAll('.preview-runtime-host')){const slot=previewSlots.get(host.dataset.previewId);if(!slot)continue;const payload=JSON.stringify({id:slot.id,html:slot.item.html,icon:!!slot.item.icon,...previewResources(slot.item,slot.label),tokens:slot.item.tokens||[],state:slot.state,properties:slot.item.styleProfile?.[slot.state]||{}}).replace(/</g,'\\u003c');const frame=document.createElement('iframe');frame.title=slot.label+' '+slot.item.name;frame.sandbox='allow-scripts';frame.loading='lazy';frame.srcdoc='<!doctype html><html><head><meta charset="utf-8"></head><body><script>'+runtimeCode.replace(/<\/script/gi,'<\\/script')+'<\/script><script>window.addEventListener("DOMContentLoaded",()=>window.dispatchEvent(new MessageEvent("message",{source:parent,data:{type:"gapscan-preview",payload:'+payload+'}})));<\/script></body></html>';previewObserver.unobserve(host);previewSlots.delete(slot.id);host.replaceChildren(frame)}}
