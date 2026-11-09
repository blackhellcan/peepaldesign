import {fetchDocument,publicUrl} from './collect.mjs';
import {plain} from './extract.mjs';

// Public package files are read as text. No install scripts or package code execute here.
export function parsePackage(value){
  if(typeof value!=='string'||value.length>240)throw new Error('Use an npm package name with an optional version, such as @material/web@2.5.0.');
  let spec=value.trim();
  if(/^https:\/\//.test(spec)){
    const u=publicUrl(spec);
    if(!['www.npmjs.com','npmjs.com'].includes(u.hostname)||!u.pathname.startsWith('/package/'))throw new Error('Use an npm package name or an npmjs.com/package link.');
    spec=decodeURIComponent(u.pathname.slice(9)).replace(/\/$/,'');
    spec=spec.replace(/\/v\/([^/]+)$/,'@$1');
  }
  const match=spec.match(/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@([a-z0-9][a-z0-9.+_-]*|\d+\.\d+(?:\.\d+)?))?$/i);
  if(!match)throw new Error('Use an npm package name and an exact version or tag; URLs, install commands and version ranges are unsupported.');
  return {name:match[1],requested:match[2]||'latest',spec:match[1]+(match[2]?'@'+match[2]:'')};
}
export function discoverPackages(content){
  const specs=[],text=plain(content);
  const add=value=>{try{const parsed=parsePackage(value);if(!specs.some(s=>parsePackage(s).name===parsed.name))specs.push(parsed.spec)}catch{}};
  for(const match of text.matchAll(/(?:npm\s+(?:install|i|add)|pnpm\s+add|yarn\s+add)\s+(?:--?[\w-]+\s+)*((?:@[\w.-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[\w.+-]+)?)/g))add(match[1]);
  for(const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']((?:@[\w.-]+\/)?[\w.-]+)(?:\/[^"']*)?["']/g))if(!/^(?:react|react-dom|lit|typescript|vue|sass|next)$/.test(match[1]))add(match[1]);
  for(const match of content.matchAll(/https:\/\/(?:www\.)?npmjs\.com\/package\/((?:@[\w.-]+\/)?[\w.-]+(?:\/v\/[\w.+-]+)?)/g))add('https://www.npmjs.com/package/'+match[1]);
  try{const json=JSON.parse(content);for(const name of Object.keys({...json.dependencies,...json.peerDependencies}))if(/material|carbon|atlaskit|polaris|fluent|antd|bootstrap|spectrum|ui5|design-system|tokens|icons/.test(name))add(name)}catch{}
  return specs.slice(0,3);
}
const FAMILY_PACKAGES={bootstrap:'bootstrap',material3:'@material/web',atlassian:'@atlaskit/tokens',carbon:'@carbon/react',sap_fiori:'@ui5/webcomponents',polaris:'@shopify/polaris',fluent2:'@fluentui/react-components',ant_design:'antd',spectrum:'@adobe/react-spectrum',lightning:'@salesforce-ux/design-system'};
export function companionPackage(record,url){const name=FAMILY_PACKAGES[record?.id];if(!name)return null;const version=url?.match(/\/docs\/(\d+\.\d+(?:\.\d+)?)(?:\/|$)/)?.[1];return {spec:name+(version?'@'+version:''),basis:'Known family companion implementation; not proof of the website’s installed version'};}
function packageRole(path){return /\.(css|scss|sass|less)$/.test(path)?'styles':/color|palette/.test(path)?'colors':/typograph|font/.test(path)?'typography':/token|theme|foundation/.test(path)||/\.json$/.test(path)?'tokens':/icon|sprite|\.svg$/.test(path)?'icons':'components'}
function fileScore(path){return (/\.min\./.test(path)?-20:0)+(/\.css$/.test(path)?100:0)+(/\.svg$/.test(path)?70:0)+(/\.json$/.test(path)?65:0)+(/(?:index|all)\.(?:js|mjs|d\.ts)$/.test(path)?35:0)+(/(?:src|components)\//.test(path)?12:0)+(/\.d\.ts$/.test(path)?-25:0)+(/\.(?:js|mjs)$/.test(path)?15:0)+(/token|theme|color|typograph|variables|sprite/.test(path)?25:0)+(/(?:ref-palette|sys-color|sys-typescale|sys-shape|sys-motion)/.test(path)?45:0)-path.split('/').length;}

export function selectPackageFiles(files,budget){
  const candidates=files.filter(file=>typeof file.name==='string'&&file.name.startsWith('/')&&!file.name.split('/').some(p=>p==='..'||p==='.')&&/\.(?:css|scss|sass|less|js|mjs|cjs|ts|tsx|jsx|json|svg|html|mdx?)$/.test(file.name)&&!/(?:^|\/)(?:test[s]?|__tests__|__fixtures__|coverage|labs)(?:\/|$)|(?:\.test|\.spec)\.|\.cssresult\.d\.ts$|(?:package|tsconfig|jsconfig|package-lock)\.json$|CHANGELOG|LICENSE/i.test(file.name)&&(!file.size||file.size<=1500000));
  // Prefer one compiled distribution over duplicated minified/source declarations.
  const paths=new Set(candidates.map(f=>f.name));
  const queue=candidates.filter(f=>!(/\.min\.css$/.test(f.name)&&paths.has(f.name.replace('.min.css','.css')))&&!(/\.cssresult\.js$/.test(f.name)&&paths.has(f.name.replace('.cssresult.js','.css')))&&!(/\.scss$/.test(f.name)&&paths.has(f.name.replace('.scss','.css')))).sort((a,b)=>fileScore(b.name)-fileScore(a.name)||a.name.localeCompare(b.name)),selected=[],candidateCount=queue.length;
  const roles=['styles','colors','typography','tokens','icons','components'];let cursor=0;
  while(selected.length<budget&&queue.length){const role=roles[cursor++%roles.length],index=queue.findIndex(f=>packageRole(f.name)===role);if(index>=0)selected.push(queue.splice(index,1)[0]);}
  return {selected,pending:queue,candidateCount};
}
export async function collectPackage(spec,side,budget=12,fetcher=fetch,deadline=Date.now()+25000){
  const parsed=parsePackage(spec),documents=[],failed=[],warnings=[];
  let version=parsed.requested;
  // Resolve partial versions through the public CDN API, then verify the exact npm version.
  if(/^\d+(?:\.\d+)?$/.test(version)){
    const resolved=JSON.parse((await fetchDocument(`https://data.jsdelivr.com/v1/package/resolve/npm/${parsed.name}@${version}`,fetcher)).content);
    if(!resolved.version)throw new Error('No published version matches '+parsed.spec);version=resolved.version;
  }
  const metadata=JSON.parse((await fetchDocument(`https://registry.npmjs.org/${encodeURIComponent(parsed.name)}/${encodeURIComponent(version)}`,fetcher)).content);
  if(metadata.name!==parsed.name||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(metadata.version))throw new Error('Package registry returned invalid identity or version.');
  version=metadata.version;
  const pin=parsed.name+'@'+version,base='https://cdn.jsdelivr.net/npm/'+pin;
  const index=JSON.parse((await fetchDocument('https://data.jsdelivr.com/v1/package/npm/'+pin+'/flat',fetcher)).content);
  if(!Array.isArray(index.files))throw new Error('Public package file listing unavailable.');
  const plan=selectPackageFiles(index.files,Math.max(1,Math.min(40,budget)));let bytes=0;const scanned=new Set(),pending=[...plan.pending];
  for(let offset=0;offset<plan.selected.length;offset+=3){
    if(Date.now()>=deadline){pending.push(...plan.selected.slice(offset));break;}
    const batch=plan.selected.slice(offset,offset+3);
    const results=await Promise.allSettled(batch.map(async file=>{
      let doc;try{doc=await fetchDocument(base+file.name,fetcher,{raw:true})}catch{doc=await fetchDocument('https://unpkg.com/'+pin+file.name,fetcher,{raw:true});}
      if(file.hash){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(doc.content));const hash=btoa(String.fromCharCode(...new Uint8Array(digest)));if(hash!==file.hash)throw new Error('Package file integrity mismatch; excluded from extraction.');}
      return doc;
    }));
    for(let n=0;n<results.length;n++){
      const file=batch[n],url=base+file.name,result=results[n];scanned.add(file.name);
      if(result.status==='rejected'){failed.push({url,error:result.reason.message,status:result.reason.status||null});continue;}
      const doc=result.value;if(bytes+doc.content.length>4000000){pending.push(file);continue;}
      bytes+=doc.content.length;documents.push({...doc,package:{name:parsed.name,version,path:file.name}});
    }
  }
  const record={name:parsed.name,version,requested:parsed.requested,source:'Public npm registry + version-pinned jsDelivr package files',basis:'Published package artifacts; no install scripts executed',filesDiscovered:plan.candidateCount,filesRead:documents.length,filesPending:pending.length,documentation:typeof metadata.homepage==='string'&&/^https:\/\//.test(metadata.homepage)?metadata.homepage:null,dependencies:Object.keys(metadata.dependencies||{}).filter(name=>/token|theme|color|typograph|icons?/.test(name)).slice(0,5)};
  warnings.push(`Package ${pin}: read ${documents.length} of ${plan.candidateCount} eligible published files. Package contents may omit examples, states and accessibility guidance.`);
  return {documents,record,coverage:{input:spec,fetched:documents.length,pasted:false,discovered:plan.candidateCount,failed,warnings,budget,pending:pending.map(f=>base+f.name),visited:[...scanned].map(path=>base+path),complete:!pending.length&&!failed.length,bytes,sizeLimited:bytes>=4000000}};
}
