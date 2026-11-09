import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {brotliCompressSync,constants} from 'node:zlib';

const root=new URL('../',import.meta.url);
const assets={};
const webAssets=[['index.html','text/html; charset=utf-8'],['styles.css','text/css; charset=utf-8'],['app.js','text/javascript; charset=utf-8'],['category-tree.js','text/javascript; charset=utf-8'],['workspace-pages.js','text/javascript; charset=utf-8'],['local-library.js','text/javascript; charset=utf-8'],['file-import.js','text/javascript; charset=utf-8'],['library-viewer.js','text/javascript; charset=utf-8'],['mapping-review.js','text/javascript; charset=utf-8'],['preview.js','text/javascript; charset=utf-8'],['preview-frame.js','text/javascript; charset=utf-8'],['preview.html','text/html; charset=utf-8'],['stepper.js','text/javascript; charset=utf-8']];
webAssets.push(['comparison-transport.js','text/javascript; charset=utf-8']);
webAssets.push(['report-experience.js','text/javascript; charset=utf-8']);
webAssets.push(['report-experience.css','text/css; charset=utf-8']);
webAssets.push(['upgrade-guides.js','text/javascript; charset=utf-8']);
webAssets.push(['decision-brief.js','text/javascript; charset=utf-8']);
webAssets.push(['decision-brief.css','text/css; charset=utf-8']);
for(const [file,type] of webAssets)assets['/'+file]={body:await readFile(new URL('web/'+file,root),'utf8'),type};
assets['/index.html'].body=assets['/index.html'].body.replace('</body>','<script src="/upgrade-guides.js?v=1" defer></script><script src="/report-experience.js?v=2" defer></script><script src="/decision-brief.js?v=1" defer></script></body>');
assets['/index.html'].body=assets['/index.html'].body.replace('</head>','<link rel="stylesheet" href="/report-experience.css?v=1"></head>');
assets['/index.html'].body=assets['/index.html'].body.replace('</head>','<link rel="stylesheet" href="/decision-brief.css?v=1"></head>');
assets['/preview.html'].body=assets['/preview.html'].body.replace('<script src="/preview-frame.js" defer></script>','<script>'+assets['/preview-frame.js'].body.replace(/<\/script/gi,'<\\/script')+'</script>');
// Bump the stepper asset URL so browsers do not reuse a pre-fix cached script.
assets['/index.html'].body=assets['/index.html'].body.replace('/styles.css"','/styles.css?v=6"').replace('/stepper.js"','/stepper.js?v=5"').replace('/preview.js"','/preview.js?v=2"').replace('/category-tree.js"','/category-tree.js?v=2"');
assets['/index.html'].body=assets['/index.html'].body.replace('/stepper.js?v=5','/stepper.js?v=6');
const referenceIndex=JSON.parse(await readFile(new URL('references/index.json',root),'utf8'));
assets['/references/index.json']={body:JSON.stringify(referenceIndex),type:'application/json'};
for(const reference of referenceIndex)assets[reference.asset]={bodyBase64:brotliCompressSync(await readFile(new URL(reference.asset.slice(1),root)),{params:{[constants.BROTLI_PARAM_QUALITY]:6}}).toString('base64'),encoding:'br',type:'application/json'};

const database=JSON.parse(await readFile(new URL('engine/design_systems_db.json',root),'utf8'));
const readEngine=async name=>readFile(new URL('engine/'+name,root),'utf8');
const names=['packages.mjs','website.mjs','foundations.mjs','insights.mjs','resolution.mjs','category-tree.mjs','report-storage.mjs','saved-projects.mjs','deliverables.mjs','migration-planning.mjs','migration-detection.mjs','saved-library.mjs','local-training.mjs','taxonomy.mjs','relevance.mjs','extract.mjs','collect.mjs','preview.mjs'];
const values=await Promise.all(names.map(readEngine));
const [packages,website,foundations,insights,resolution,categoryTree,storage,projects,deliverables,migration,migrationDetection,savedLibrary,training,taxonomy,relevance,extract,collect,preview]=values;
const server=await readFile(new URL('server.mjs',root),'utf8');
const jsonStream=await readEngine('json-stream.mjs');
const upgradeGuides=await readEngine('upgrade-guides.mjs'),migrationBrief=await readEngine('migration-brief.mjs'),estimate=await readEngine('estimate.mjs');
const stripImports=source=>source.replace(/^import[^\n]+\n/gm,'');
const serverSource=server.replace("if(!['upgrade','switch'].includes(body.scenario))return json({error:'Choose a migration type first.'},400);","if(body.scenario!=null&&!['auto','upgrade','switch'].includes(body.scenario))return json({error:'Invalid comparison mode.'},400);").replace("if(url.pathname==='/api/extract')return extractReference(request,url,ctx,env);","if(url.pathname==='/api/extract')return extractReference(request,url,ctx,env);if(url.pathname==='/api/compare')return compareFingerprints(request,url,ctx);");
const localMigrationDetection=migrationDetection.replace(/^import[^\n]+\n/gm,'const migrationRegistry='+JSON.stringify(database)+';\n');
assets['/archive-files.js']={body:await readEngine('archive-files.mjs'),type:'text/javascript; charset=utf-8'};
// The browser-side engine must include the same saved-library helpers used by
// local comparisons. Without this module, selecting any saved system throws
// when it tries to build its reusable evidence summary/context.
assets['/local-engine.js']={body:[categoryTree,storage,projects,deliverables,migration,localMigrationDetection,savedLibrary,training,foundations,taxonomy,relevance,insights,estimate,extract,resolution,preview,upgradeGuides,migrationBrief].map(stripImports).join('\n'),type:'text/javascript; charset=utf-8'};
const output=[
  'const database='+JSON.stringify(database)+';',
  'const migrationRegistry=database;',
  'const ASSETS='+JSON.stringify(assets)+';',
  foundations,taxonomy,relevance,insights,estimate,extract,collect,packages,website,preview,categoryTree,storage,savedLibrary,deliverables,migration,migrationDetection,resolution,jsonStream,upgradeGuides,migrationBrief,serverSource.replace("if(url.pathname==='/api/compare')return compareFingerprints(request,url,ctx);","if(url.pathname==='/api/compare')return compareFingerprints(request,url,ctx);if(url.pathname==='/api/upgrade-guides')return processUpgradeGuides(request,url);")
].map(stripImports).join('\n');
for(const dir of ['worker','dist/server','dist/.openai'])await mkdir(new URL(dir,root),{recursive:true});
await writeFile(new URL('worker/index.js',root),output);
await writeFile(new URL('dist/server/index.js',root),output);
await writeFile(new URL('dist/.openai/hosting.json',root),await readFile(new URL('.openai/hosting.json',root)));
console.log('Built self-contained Worker with server-side extraction and embedded web assets.');
