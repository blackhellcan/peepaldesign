export function createProjectSnapshot({name,scenario,inputs,report=null,excluded=[],edited={},calculator={},view={},id=null}){
  if(typeof name!=='string'||!name.trim()||name.length>120)throw new Error('Enter a project name of up to 120 characters.');
  return validateProjectSnapshot({schemaVersion:1,id:id||crypto.randomUUID(),name:name.trim(),scenario:scenario||null,inputs,report,excluded,edited,calculator,view,savedAt:new Date().toISOString()});
}
function savedHttps(value){try{const u=new URL(value),host=u.hostname.toLowerCase();return u.protocol==='https:'&&!u.username&&!u.password&&host.includes('.')&&!host.includes(':')&&!/^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.)/.test(host)&&!/^\d+(?:\.\d+){3}$/.test(host)&&!/[.]local$|[.]internal$/.test(host)?u.href:null}catch{return null}}
export function validateProjectSnapshot(project){
  if(!project||project.schemaVersion!==1||typeof project.name!=='string'||!project.name.trim()||project.name.length>120||!project.inputs?.old||!project.inputs?.new||!['upgrade','switch','auto',null].includes(project.scenario))throw new Error('This is not a supported GapScan project backup.');
  const clean=structuredClone(project);
  for(const input of Object.values(clean.inputs)){if(!input||typeof input!=='object'||['url','code','npmPackage','localProfileId'].some(key=>input[key]!=null&&typeof input[key]!=='string'))throw new Error('Project inputs are invalid.');}
  if(clean.report){const r=clean.report;if(!Array.isArray(r.items)||!r.summary||!r.extractions||!Array.isArray(r.extractions.old)||!Array.isArray(r.extractions.new)||!r.relevance?.old||!r.relevance?.new||!Array.isArray(r.domains)||!Array.isArray(r.notes)||!r.coverage?.old||!r.coverage?.new)throw new Error('The saved report is invalid.');}
  // Report previews remain sandboxed. Backup links cannot introduce executable or private URLs.
  const walk=(value,depth=0)=>{if(depth>50)throw new Error('Project nesting exceeds the supported limit.');if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(['documentationUrl','sectionUrl'].includes(key))value[key]=savedHttps(child);else if(key==='url'&&typeof child==='string'&&/^[a-z][\w+.-]*:/i.test(child)&&!child.startsWith('Local ')&&!child.startsWith('npm:'))value[key]=savedHttps(child)||'';else walk(child,depth+1)}};walk(clean);
  clean.excluded=Array.isArray(clean.excluded)?clean.excluded.filter(id=>typeof id==='string'):[];
  clean.edited=Object.fromEntries(Object.entries(clean.edited||{}).filter(([key,value])=>typeof key==='string'&&Number.isFinite(value)&&value>=0&&value<=1000));
  clean.calculator=clean.calculator&&typeof clean.calculator==='object'?clean.calculator:{};
  clean.view=clean.view&&typeof clean.view==='object'?clean.view:{};
  return clean;
}
