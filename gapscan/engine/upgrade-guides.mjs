// Documentation evidence is kept separate from implementation inventories.
// Commands are displayed as text and are never executed.
function guideClean(value){return String(value||'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim()}
function guideSafeUrl(value,base){try{const u=new URL(value,base),host=u.hostname.toLowerCase();if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||!host.includes('.')||host.includes(':')||/^\d+(?:\.\d+){3}$/.test(host)||/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)|\.(?:local|internal|localhost)$/.test(host))return null;return u.href}catch{return null}}
function guideKind(value){const text=String(value||'');if(/(?:^|[\s/_-])(?:migrat(?:e|ion|ing)|upgrad(?:e|ing))(?:[\s/_.-]|$)/i.test(text))return 'upgrade';if(/breaking[ -]changes|changelog|release[ -]notes/i.test(text))return 'release-notes';if(/install(?:ation|ing)?|getting[ -]started|quick[ -]start/i.test(text))return 'installation';return null}
function guideVersion(value){return String(value||'').match(/(?:\/docs\/|\/versions?\/|(?:^|[\s/_-])v)(\d+(?:\.\d+){0,2})(?=[\s/_.#-]|$)/i)?.[1]||null}
export function compatibleGuideVersion(declared,selected){const from=String(declared||'').match(/\d+(?:\.\d+){0,2}/)?.[0],to=String(selected||'').match(/\d+(?:\.\d+){0,2}/)?.[0];if(!from||!to)return null;const a=from.split('.'),b=to.split('.');return a.every((value,index)=>value===b[index])}
export function guideApplicability(candidate,context={}){
 const pinned=candidate.declaredVersion||guideVersion(candidate.url+' '+candidate.title);
 if(candidate.kind==='installation'&&!candidate.fromVersion&&!candidate.toVersion){const side=candidate.side==='source'?'source':'target',match=compatibleGuideVersion(pinned,side==='source'?context.sourceVersion:context.targetVersion);return {status:match===false?'different-version':match===true?'version-matched':'unverified',label:match===true?(side==='source'?'Source':'Target')+' installation instructions match the selected version series; check patch coverage.':match===false?'Installation instructions cover a different '+side+' version.':'Installation version coverage not confirmed',fromVersion:side==='source'?pinned:null,toVersion:side==='target'?pinned:null}}
 const from=candidate.fromVersion||null,to=candidate.toVersion||pinned;
 const target=compatibleGuideVersion(to,context.targetVersion),source=compatibleGuideVersion(from,context.sourceVersion);
 if(target===false||source===false)return {status:'different-version',label:'Different version — check applicability',fromVersion:from,toVersion:to};
 if(target===true&&(!from||source===true))return {status:'version-matched',label:from?'Source and target version series match; check patch and feature coverage.':'Matches the target version series; supported source versions and patch differences still need checking.',fromVersion:from,toVersion:to};
 return {status:'unverified',label:'Version range not confirmed',fromVersion:from,toVersion:to};
}
export function compareUpgradeGuideFindings(documents=[]){
 const source=documents.filter(doc=>doc.side==='source'&&doc.status==='read'),target=documents.filter(doc=>doc.side==='target'&&doc.status==='read'),key=action=>String(action.text||'').toLowerCase().replace(/\s+/g,' ').trim(),unique=docs=>[...new Map(docs.flatMap(doc=>(doc.actions||[]).map(action=>[key(action),{...action,document:doc.title}]))).values()];
 const before=unique(source),after=unique(target),a=new Set(before.map(key)),b=new Set(after.map(key));
 return {status:source.length&&target.length?'compared':target.length?'target-only':source.length?'source-only':'unreadable',sourceDocuments:source.length,targetDocuments:target.length,shared:after.filter(action=>a.has(key(action))),onlyInTarget:after.filter(action=>!a.has(key(action))),onlyInSource:before.filter(action=>!b.has(key(action))),statement:source.length&&target.length?'Instructions are compared by their published wording. A source-only instruction is not proof that a requirement was removed.':target.length?'Target guidance was reviewed. No source guide was reviewed, so these are target instructions, not verified changes between documents.':source.length?'Only source guidance was reviewed. Target instructions have not been checked.':'No readable document instructions were available for comparison.'};
}
export function detectUpgradeGuides(documents=[],{side='target'}={}){
 const found=new Map();
 const add=candidate=>{const key=candidate.url||candidate.localId;if(!key)return;const previous=found.get(key);if(!previous||candidate.content&&!previous.content)found.set(key,candidate)};
 for(const [index,doc]of documents.entries()){
  const source=String(doc.url||doc.source||doc.name||''),body=String(doc.content||'');
  if(/\.(?:css|scss|sass|less|js|jsx|ts|tsx|json|svg|zip|woff2?)(?:[?#]|$)/i.test(source)||/text\/css|javascript|application\/json/.test(doc.type||''))continue;
  const title=guideClean(body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||body.match(/^#\s+(.+)$/m)?.[1]||body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||doc.label||doc.name||source.split('/').at(-1));
  const kind=guideKind(title+' '+source);
  if(kind){const url=guideSafeUrl(doc.documentationUrl)||guideSafeUrl(source),local=!guideSafeUrl(source);add({id:side+':'+(url||source||index),localId:side+':'+source+':'+index,url,title:title||'Upgrade documentation',kind,side,status:'captured',declaredVersion:guideVersion(source+' '+title),content:body,source,local});}
  for(const match of body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>|\[([^\]]+)\]\(([^\s)]+)(?:\s+[^)]*)?\)/gi)){
   const href=match[1]||match[4],label=guideClean(match[2]||match[3]),url=guideSafeUrl(href,guideSafeUrl(source)||guideSafeUrl(doc.documentationUrl));if(!url)continue;
   const kind=guideKind(new URL(url).pathname+' '+label);if(!kind||/\/(?:pricing|billing|checkout|account)\b/i.test(new URL(url).pathname)||/\.(?:zip|css|js|json|svg)(?:[?#]|$)/i.test(url))continue;
   add({id:side+':'+url,url,title:label||new URL(url).pathname.split('/').filter(Boolean).at(-1),kind,side,status:'link-found',declaredVersion:guideVersion(url),source});
  }
 }
 return [...found.values()].sort((a,b)=>Number(b.kind==='upgrade')-Number(a.kind==='upgrade')||Number(b.side==='target')-Number(a.side==='target')||a.title.localeCompare(b.title));
}
export function analyzeUpgradeGuide(document,context={}){
 const raw=String(document.content||''),blocks=[];
 if(/<\w+\b/.test(raw))for(const match of raw.matchAll(/<(h[1-6]|li|p|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi)){const text=guideClean(match[2]);if(text)blocks.push({text,line:raw.slice(0,match.index).split('\n').length,heading:/^h[1-6]$/.test(match[1])})}
 else raw.split('\n').forEach((line,index)=>{const text=guideClean(line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/,''));if(text)blocks.push({text,line:index+1,heading:/^\s*#{1,6}\s/.test(line)})});
 const versionText=(document.title||'')+' '+blocks.map(block=>block.text).join('\n');
 const range=versionText.match(/(?:from\s+|migrat(?:e|ing|ion)\s+)(?:version\s+)?v?(\d+(?:\.\d+){0,2})\s*(?:to|→|->)\s*(?:version\s+)?v?(\d+(?:\.\d+){0,2})/i);
 const candidate={...document,fromVersion:range?.[1]||document.fromVersion,toVersion:range?.[2]||document.toVersion,declaredVersion:document.declaredVersion||guideVersion(document.url+' '+document.title)};
 const actions=[],commands=[],seen=new Set();
 for(const block of blocks){
  const text=block.text;if(block.heading||text.length>2500)continue;
  const isCommand=/(?:^|\s)(?:npm (?:install|i|update)|pnpm (?:add|update)|yarn (?:add|upgrade)|npx [\w@/-]+|bun (?:add|update))\b/.test(text);if(isCommand)commands.push({text,line:block.line,source:document.url||document.source});
  if(!isCommand&&!/\b(?:replace|rename|remove|install|upgrade|migrate|update|change|deprecated|breaking|must|requires?|test|verify|check|run|switch)\b/i.test(text)||seen.has(text))continue;
  seen.add(text);const type=isCommand?'installation':/\btest|verify|keyboard|accessib|contrast|focus|screen reader\b/i.test(text)?'validation':/\binstall|dependency|dependencies|requires?\b/i.test(text)?'installation':/\bremove|deprecated|breaking|rename|replace\b/i.test(text)?'breaking-change':'update';
  actions.push({type,text,line:block.line,source:document.url||document.source});
 }
 return {id:document.id,url:document.url||null,source:document.source||document.url,title:document.title||'Upgrade documentation',kind:document.kind||'upgrade',side:document.side||'target',status:'read',applicability:guideApplicability(candidate,context),actions,commands,versionEvidence:{from:range?.[1]||null,to:range?.[2]||null},limitations:['Document instructions are evidence, not confirmation that a component is used in your application.','Runtime behaviour, accessibility and total project effort still require validation.'],readAt:new Date().toISOString()};
}
