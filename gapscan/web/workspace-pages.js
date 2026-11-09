const WORKSPACE_PAGES={mapping:{hash:'mappings',title:'Mapping review'},viewer:{hash:'library-view',title:'Imported design system'},new:{hash:'overview',title:'New comparison'},comparison:{hash:'dashboard',title:'Gap analysis'},source:{hash:'source',title:'Source design system'},target:{hash:'target',title:'Target design system'},evidence:{hash:'evidence',title:'Evidence & coverage'},estimate:{hash:'calculator',title:'Effort & budget'},library:{hash:'library',title:'Design-system library'},projects:{hash:'projects',title:'Saved projects'},engine:{hash:'engine',title:'How the engine works'}};
let workspacePage='new';
let workspaceHasUserSelection=true;
function setFlowNavVisibility(visible=typeof currentProjectId!=='undefined'&&!!currentProjectId){for(const link of document.querySelectorAll('.flow-nav'))link.hidden=!visible}
function showWorkspacePage(page,updateHash=true){
 if(!WORKSPACE_PAGES[page])page='new';workspacePage=page;const config=WORKSPACE_PAGES[page];
 if(updateHash&&location.hash!=='#'+config.hash)history.pushState(null,'','#'+config.hash);
 setFlowNavVisibility();
 $('workspace-page-title').textContent=config.title;
 $('mapping-review-page').hidden=page!=='mapping';$('library-viewer').hidden=page!=='viewer';$('page-new').hidden=page!=='new';$('settings-section').hidden=page!=='library';$('projects-section').hidden=page!=='projects';$('engine-section').hidden=page!=='engine';
 const resultPage=['comparison','source','target','evidence','estimate'].includes(page);$('results').hidden=!resultPage||!report;
 $('workspace-empty').hidden=!resultPage||!!report;$('workspace-empty-title').textContent=config.title;
 for(const name of ['comparison','source','target','evidence','estimate'])$('panel-'+name).hidden=page!==name;
 $('shared-relevance').hidden=page!=='evidence';$('comparison-paused').hidden=!(page==='evidence'&&(report?.analysisIncomplete||report?.savedLibraryComparison));
 for(const button of document.querySelectorAll('[data-report-tab]')){const active=button.dataset.reportTab===page;button.setAttribute('aria-selected',active);button.tabIndex=active?0:-1}
 for(const nav of document.querySelectorAll('[data-workspace-page]')){const active=nav.dataset.workspacePage===page&&(page!=='new'||workspaceHasUserSelection||!!currentProjectId);nav.classList.toggle('active',active);if(active)nav.setAttribute('aria-current','page');else nav.removeAttribute('aria-current')}
 if(page==='mapping')prepareMappingResolution().catch(error=>toast(error.message));if(page==='source'||page==='target'){if(report)renderExtraction(page)}
 if(page==='evidence'&&report){$('exclusion-side').value='All';renderAudit()}
 if(page==='library')Promise.all([refreshLibrary(),refreshReferenceCatalog()]).catch(error=>$('settings-status').textContent=error.message);
 if(page==='projects')refreshProjects().catch(error=>toast(error.message));
 $('overview').scrollIntoView({behavior:'instant',block:'start'});
}
for(const link of document.querySelectorAll('[data-workspace-page]'))link.addEventListener('click',event=>{workspaceHasUserSelection=true;if(link.tagName==='A')event.preventDefault();showWorkspacePage(link.dataset.workspacePage)});
$('empty-new-comparison').onclick=()=>showWorkspacePage('new');
window.addEventListener('hashchange',()=>showWorkspacePage(Object.keys(WORKSPACE_PAGES).find(page=>WORKSPACE_PAGES[page].hash===location.hash.slice(1))||'new',false));
showWorkspacePage(Object.keys(WORKSPACE_PAGES).find(page=>WORKSPACE_PAGES[page].hash===location.hash.slice(1))||'new',false);
function migrationPlanningPanel(item){const plan=item.migration||{hours:item.estimateAvailable===false?null:item.hours,size:item.tier,ai:{label:'Needs review',canAssist:false,tasks:[],humanReview:[]}};const panel=document.createElement('section');panel.className='item-migration-plan';const title=document.createElement('strong');title.textContent='Change effort · '+(plan.hours===null?'Not estimated':num(edited[item.id]??plan.hours)+' hrs / app')+' · '+plan.size;const label=document.createElement('span');label.className='pill '+(plan.ai.canAssist?'blue':'neutral');label.textContent=plan.ai.label;panel.append(title,label);const text=document.createElement('p');text.textContent=plan.hours===null?'Evidence must be reviewed before implementation can be estimated.':'Heuristic estimate. AI assistance does not automatically reduce these hours.';panel.append(text);if(plan.ai.tasks.length){const tasks=document.createElement('p');tasks.textContent='AI can help: '+plan.ai.tasks.join(' ');panel.append(tasks)}const checks=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Human review & validation';checks.append(summary);const list=document.createElement('ul');for(const value of plan.ai.humanReview){const li=document.createElement('li');li.textContent=value;list.append(li)}checks.append(list);panel.append(checks);return panel}
