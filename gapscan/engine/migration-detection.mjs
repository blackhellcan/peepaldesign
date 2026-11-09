import migrationRegistry from './design_systems_db.json' with {type:'json'};

// Identity comparison only. Version ordering and behavioral compatibility are not inferred.
const MIGRATION_LIBRARY_ALIASES={
 'bootstrap':'bootstrap','bootstrap icons':'bootstrap-icons','material web':'@material/web',
 'material ui':'@mui/material','mui':'@mui/material','angular material':'@angular/material',
 'carbon web components':'@carbon/web-components','carbon react':'@carbon/react',
 'fluent ui':'@fluentui/react-components','fluent ui react':'@fluentui/react-components',
 'spectrum web components':'@spectrum-web-components','blueprint':'@blueprintjs/core',
 'web awesome':'@awesome.me/webawesome'
};
const MIGRATION_REPOSITORIES={
 'twbs/bootstrap':'bootstrap','twbs/icons':'bootstrap-icons','material-components/material-web':'@material/web',
 'mui/material-ui':'@mui/material','angular/components':'@angular/material','carbon-design-system/carbon':'@carbon/react',
 'carbon-design-system/carbon-web-components':'@carbon/web-components','microsoft/fluentui':'@fluentui/react-components',
 'adobe/spectrum-web-components':'@spectrum-web-components','palantir/blueprint':'@blueprintjs/core',
 'shoelace-style/webawesome':'@awesome.me/webawesome'
};
function migrationPackage(value){
 if(typeof value!=='string')return null;
 const match=value.trim().match(/^(@[\w.-]+\/[\w.-]+|[\w.-]+)(?:@[^/\s]+)?(?:\/.*)?$/);
 if(!match)return null;const name=match[1].toLowerCase();
 return name.startsWith('@spectrum-web-components/')?'@spectrum-web-components':name;
}
function migrationPackageIdentity(value){
 const name=migrationPackage(value);if(!name)return null;
 const record=migrationRegistry.systems.find(record=>(record.match?.package_names||[]).some(pkg=>pkg===name||pkg==='@spectrum-web-components'&&name.startsWith(pkg)));
 return {key:'package:'+name,name:record?.match?.package_names?.[0]===name?record.name:name};
}
function migrationRepository(value){
 try{const u=new URL(value);if(!['github.com','www.github.com','raw.githubusercontent.com'].includes(u.hostname))return null;const parts=u.pathname.split('/').filter(Boolean);if(parts.length<2||['topics','orgs','users','search'].includes(parts[0]))return null;const repo=parts.slice(0,2).join('/').replace(/\.git$/,'').toLowerCase();return MIGRATION_REPOSITORIES[repo]?migrationPackageIdentity(MIGRATION_REPOSITORIES[repo]):{key:'repository:'+repo,name:repo}}catch{return null}
}
function migrationUrl(value){
 try{const u=new URL(value);if(['npmjs.com','www.npmjs.com'].includes(u.hostname)&&u.pathname.startsWith('/package/'))return migrationPackageIdentity(decodeURIComponent(u.pathname.slice(9)).replace(/\/v\/[^/]+\/?$/,''));
 const repo=migrationRepository(value);if(repo)return repo;
 for(const record of migrationRegistry.systems)for(const domain of record.match?.domains||[]){const known=new URL('https://'+domain);if((u.hostname===known.hostname||u.hostname.endsWith('.'+known.hostname))&&(known.pathname==='/'||u.pathname===known.pathname||u.pathname.startsWith(known.pathname+'/')))return record.match.package_names?.[0]?migrationPackageIdentity(record.match.package_names[0]):{key:'system:'+record.id,name:record.name};}
 return null;}catch{return null}
}
function migrationLibraryName(value,version=''){
 if(typeof value!=='string')return null;let name=value.toLowerCase().trim().replace(/[®™]/g,'').replace(/\s+/g,' ');
 if(version&&name.endsWith(String(version).toLowerCase()))name=name.slice(0,-String(version).length).replace(/[\s·—_-]+$/,'');
 name=name.replace(/(?:\s+[vV]?\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?)$/,'').trim();
 if(!name||/^(?:source|target|current|new|old|local|unknown|design system|untitled)(?: library| system)?$/.test(name))return null;
 const alias=MIGRATION_LIBRARY_ALIASES[name];if(alias)return migrationPackageIdentity(alias);
 const record=migrationRegistry.systems.find(record=>record.name.toLowerCase()===name||record.id.replace(/_/g,' ')===name);
 if(record)return record.match.package_names?.[0]?migrationPackageIdentity(record.match.package_names[0]):{key:'system:'+record.id,name:record.name};
 return {key:'library:'+name,name:value.trim()};
}
function migrationIdentity(input={},library=null,resolved=null){
 const signals=[];const add=(identity,basis,priority)=>{if(identity)signals.push({...identity,basis,priority})};
 // Explicit package/manifest identity takes precedence over a shared monorepo or an editable display name.
 add(migrationPackageIdentity(input.npmPackage),'Declared package '+input.npmPackage,5);
 const repository=resolved?.coverage?.repository||library?.coverageSnapshot?.repository;
 for(const declared of repository?.versions||library?.provenance?.versions||[])if(declared.name)add(migrationPackageIdentity(declared.name),'Declared package '+declared.name,5);
 const code=typeof input.code==='string'?input.code:'';
 const sourceCodes=[code,...(resolved?.documents||[]).filter(doc=>/package\.json(?:[?#]|$)/.test(doc.url||doc.label||'')).map(doc=>doc.content||'')];
 for(const text of sourceCodes){try{const manifest=JSON.parse(text);if(manifest.name&&manifest.version)add(migrationPackageIdentity(manifest.name),'Package manifest '+manifest.name,5)}catch{}}
 const codeSources=[code,...(resolved?.documents||[]).map(doc=>doc.content||'')];
 const knownPackage=name=>migrationRegistry.systems.some(record=>(record.match?.package_names||[]).some(pkg=>name===pkg||name.startsWith(pkg+'/')))||Object.values(MIGRATION_LIBRARY_ALIASES).includes(name);
 for(const text of codeSources){
  for(const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g)){const name=migrationPackage(match[1]);if(name&&knownPackage(name))add(migrationPackageIdentity(name),'Code imports '+name,5)}
  // Recognizable namespaces carry identity; generic .button, .card and .container do not.
  for(const [pattern,pkg]of [[/<md-[a-z][\w-]*\b|\.(?:mdc)-[\w-]+/g,'@material/web'],[/<cds-[a-z][\w-]*\b/g,'@carbon/web-components'],[/<sp-[a-z][\w-]*\b/g,'@spectrum-web-components'],[/<wa-[a-z][\w-]*\b/g,'@awesome.me/webawesome'],[/\bbp[3456]-[a-z][\w-]*/g,'@blueprintjs/core'],[/\bfui-[a-z][\w-]*/g,'@fluentui/react-components'],[/\bPolaris-[A-Z][\w-]*/g,'@shopify/polaris'],[/\bslds-[a-z][\w-]*/g,'@salesforce-ux/design-system']])if(pattern.test(text))add(migrationPackageIdentity(pkg),'Distinctive component namespace in code',3);
  const bootstrapSignals=['btn-primary','navbar-expand','card-body','col-md-'].filter(signal=>text.includes(signal));if(bootstrapSignals.length>=2)add(migrationPackageIdentity('bootstrap'),'Multiple Bootstrap class signatures',3);
 }
 for(const [value,basis]of [[input.url,'Input URL'],[library?.sourceInput?.url,'Saved source URL'],[library?.provenance?.repository,'Saved repository'],[repository?.url,'Resolved repository']])add(migrationUrl(value),basis+': '+value,4);
 for(const pkg of resolved?.packages||[])if(knownPackage(pkg.name))add(migrationPackageIdentity(pkg.name),'Retrieved package '+pkg.name,5);
 const name=migrationLibraryName(library?.name,library?.version);add(name,'Saved library name'+(library?.version?' · version '+library.version:''),2);
 if(!signals.length)return {key:null,name:'Not identified',evidence:[],ambiguous:false};
 const priority=Math.max(...signals.map(signal=>signal.priority)),strongest=signals.filter(signal=>signal.priority===priority),keys=new Set(strongest.map(signal=>signal.key));
 if(keys.size!==1)return {key:null,name:'Multiple identities found',evidence:[...new Set(strongest.map(signal=>signal.basis))],ambiguous:true};
 const chosen=strongest[0];return {key:chosen.key,name:chosen.name,evidence:[...new Set(signals.filter(signal=>signal.key===chosen.key).map(signal=>signal.basis))],ambiguous:false};
}
export function detectMigrationType(inputs,{libraries={},resolved={},scenario='auto'}={}){
 const source=migrationIdentity(inputs.old,libraries.old,resolved.old),target=migrationIdentity(inputs.new,libraries.new,resolved.new);
 const explicit=['upgrade','switch'].includes(scenario);let type=explicit?scenario:source.key&&target.key?(source.key===target.key?'upgrade':'switch'):'unknown';
 // Names alone may identify saved systems, but cannot bridge unrelated forms of identity.
 if(!explicit&&source.key&&target.key&&source.key.split(':')[0]!==target.key.split(':')[0])type='unknown';
 const label=type==='upgrade'?'Same-system comparison':type==='switch'?'Cross-system comparison':'Comparison type not yet identified';
 const basis=explicit?['Retained from the explicit setting in this saved project or API request.']:type==='unknown'?['The available identities are incomplete or ambiguous. Comparison continues without an assumed cross-system effort allowance.']:[source.name+(type==='upgrade'?' is identified on both sides.':' → '+target.name+'.'),...source.evidence.map(value=>'Source: '+value),...target.evidence.map(value=>'Target: '+value)];
 return {schemaVersion:1,scenario:type,label,basis,mode:explicit?'explicit':'auto',source,target};
}
