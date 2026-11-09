/* Visual-first reports. Matching and scoring continue to run on the backend. */
function friendlyChangeSummary(item){
 if(!item.old)return 'Found only in the target system. Decide whether you want to use it.';
 if(!item.new)return 'No matching target item was found in this scan. Check other names or captured pages before replacing it.';
 if(item.status==='Unchanged')return 'The captured definitions match. Check how the component behaves in your app.';
 const names={color:'text color',background:'background','background-color':'background','border-radius':'corners','font-family':'font','font-size':'text size','font-weight':'text weight','line-height':'line spacing','letter-spacing':'letter spacing','box-shadow':'shadow'};
 const changes=[...new Set((item.insight?.differences||[]).map(change=>change.type==='markup'?'structure':change.type==='api'?'available options':change.type==='token'?'design value':names[change.property]||(/^padding/.test(change.property||'')?'inside spacing':/^margin/.test(change.property||'')?'outside spacing':/^border/.test(change.property||'')?'border':null)).filter(Boolean))];
 if(changes.length){const short=changes.slice(0,3);return short.map((name,index)=>index===0?name[0].toUpperCase()+name.slice(1):name).join(', ')+(changes.length>3?' and other details':'')+' differ. Review the examples before updating.'}
 return 'A possible match was found. Check the examples and available options before accepting it.';
}
function readablePresence(item){return !item.old?'Only in target':!item.new?'Only in source':item.status==='Unchanged'?'Looks consistent':['Changed','Renamed'].includes(item.status)?'Changes to review':'Check this match'}
function readableComponentName(item){return String(item?.name||'Component').replace(/^--|^\./,'').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[-_]+/g,' ').replace(/\bbtn\b/gi,'button').replace(/^./,letter=>letter.toUpperCase())}
function documentationLink(item){
 const value=item?.documentationUrl||item?.evidence?.find(entry=>entry.sectionUrl)?.sectionUrl;
 try{const url=new URL(value);return /^https?:$/.test(url.protocol)&&url.hostname!=='raw.githubusercontent.com'&&!/\.(?:css|s[ac]ss|less|jsx?|tsx?|json|svg)(?:$|[?#])/i.test(url.href)?url.href:null}catch{return null}
}
function componentTechnicalDetails(item,label='Component'){
 const details=document.createElement('details');details.className='component-details';
 const summary=document.createElement('summary');summary.textContent='Details, code & documentation';details.append(summary);
 details.addEventListener('toggle',()=>{
  if(!details.open||details.dataset.ready)return;details.dataset.ready='true';
  const name=document.createElement('p');name.className='technical-identifier';name.textContent=label+': '+item.name;details.append(name);
  const url=documentationLink(item);if(url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open component documentation';details.append(link)}
  for(const [title,value]of [['Markup',item.html],['Styles',item.css],['Design value',['token','foundation'].includes(item.kind)?item.resolvedValue||item.value:null]])if(value){const heading=document.createElement('h4'),pre=document.createElement('pre');heading.textContent=title;pre.textContent=value;details.append(heading,pre)}
  const evidence=document.createElement('details'),heading=document.createElement('summary');heading.textContent='Where this was found ('+(item.evidence?.length||0)+')';evidence.append(heading);
  evidence.addEventListener('toggle',()=>{if(!evidence.open||evidence.dataset.ready)return;evidence.dataset.ready='true';for(const entry of item.evidence||[]){const source=document.createElement('p'),pre=document.createElement('pre');source.textContent=entry.source+(entry.line?' · line '+entry.line:'');pre.textContent=entry.snippet||'Source location recorded; no excerpt available.';evidence.append(source,pre)}});
  details.append(evidence);
 });return details;
}
const originalSinglePreview=makeSinglePreview;
makeSinglePreview=function(item,label){
 const side=originalSinglePreview(item,label);
 if(!item){side.querySelector('.preview-box').textContent=/SOURCE|CURRENT/.test(label)?'No source example found':'No target example found';side.querySelector('.preview-kind').textContent='Not found in the captured pages.';return side}
 // Keep the actual specimen visible. Move raw values and asset information
 // into an explicit second layer without changing the extracted example.
 const details=componentTechnicalDetails(item,label);
 side.querySelector('.preview-label').textContent=(/LIBRARY/.test(label)?'Library':/SOURCE|CURRENT/.test(label)?'Source':'Target')+' · '+readableComponentName(item);
 for(const node of [...side.children])if(node.matches('.component-palette,.component-type,.variant-select'))details.append(node);else if(node.matches('.component-doc-link'))node.remove();
 const pre=side.querySelector('.preview-box > pre');if(pre){const value=pre.textContent;if(value.length<40&&!/[{};]|var\(/.test(value)){const text=document.createElement('span');text.className='simple-design-value';text.textContent=value;pre.replaceWith(text)}else{details.append(pre);const note=document.createElement('p');note.className='preview-unavailable';note.textContent='This design value has no visual preview.';side.querySelector('.preview-box').append(note)}}
 const missing=side.querySelector('.absent');if(missing)missing.textContent='No visual example was captured. You can inspect its definition below.';
 side.querySelectorAll('.preview-box > a').forEach(link=>link.remove());
 const states=side.querySelector('.state-examples > summary');if(states)states.textContent='See interaction states';
 side.append(details);return side;
};
function makeFriendlyComparisonCard(item,interactive=true){
 const card=document.createElement('article');card.className='comparison-card visual-comparison-card';
 const header=document.createElement('header');header.className='visual-card-heading';const text=document.createElement('div'),title=document.createElement('h3'),category=document.createElement('p');title.textContent=item.canonicalLabel||item.name;category.textContent=item.category;text.append(title,category);
 const status=document.createElement('span');status.className='comparison-presence';status.textContent=readablePresence(item);status.dataset.presence=!item.old||!item.new?'missing':item.status==='Unchanged'?'same':'changed';header.append(text,status);
 const summary=document.createElement('p');summary.className='visual-change-summary';summary.textContent=friendlyChangeSummary(item);
 const examples=document.createElement('div');examples.className='paired-variants';const pair=document.createElement('section');pair.className='variant-pair';pair.append(makeVariantPreview(item.old,'SOURCE','Captured example'),makeVariantPreview(item.new,'TARGET','Captured example'));examples.append(pair);
 const extra=document.createElement('details');extra.className='additional-examples';const extraTitle=document.createElement('summary');const oldCount=item.old?.variants?.filter(variant=>variant.html).length||Number(!!item.old?.html),newCount=item.new?.variants?.filter(variant=>variant.html).length||Number(!!item.new?.html);extraTitle.textContent='See all examples · '+oldCount+' source / '+newCount+' target';extra.append(extraTitle);extra.hidden=oldCount<=1&&newCount<=1;extra.addEventListener('toggle',()=>{if(!extra.open||extra.dataset.ready)return;extra.dataset.ready='true';extra.append(makeComparisonPreviews(item.old,item.new))});
 const technical=document.createElement('details');technical.className='comparison-reasoning';const label=document.createElement('summary');label.textContent='Why this result? Work estimate & checks';technical.append(label);
 technical.addEventListener('toggle',()=>{if(!technical.open||technical.dataset.ready)return;technical.dataset.ready='true';technical.append(migrationPlanningPanel(item),insightPanel(item));const note=document.createElement('p');note.textContent=item.match+' · '+item.confidence;technical.append(note);const controls=document.createElement('fieldset'),legend=document.createElement('legend'),hoursLabel=document.createElement('label'),hours=document.createElement('input'),includeLabel=document.createElement('label'),include=document.createElement('input');legend.textContent='Adjust the work estimate';hoursLabel.textContent='Hours per application';hours.type='number';hours.min=0;hours.max=1000;hours.step=.5;hours.value=edited[item.id]??item.hours;hours.disabled=!interactive||item.estimateAvailable===false;hours.setAttribute('aria-label',(item.canonicalLabel||item.name)+' hours per application');hours.onchange=()=>{const value=hours.valueAsNumber;if(Number.isFinite(value)&&value>=0&&value<=1000){edited[item.id]=value;updateTotals()}else{hours.value=edited[item.id]??item.hours;toast('Enter hours between 0 and 1,000.')}};include.type='checkbox';include.checked=item.estimateAvailable!==false&&!excluded.has(item.id);include.disabled=hours.disabled;include.onchange=()=>{if(include.checked)excluded.delete(item.id);else excluded.add(item.id);updateTotals()};hoursLabel.append(hours);includeLabel.append(include,document.createTextNode('Include in the work estimate'));controls.append(legend,hoursLabel,includeLabel);technical.append(controls)});
 card.append(header,summary,examples,extra,technical);return card;
}
const originalMakeCard=makeCard;
makeCard=function(item,interactive=true){return makeFriendlyComparisonCard(item,interactive)};
function reportOverviewFacts(data){const paired=data.items.filter(item=>item.old&&item.new),unmatched=data.items.filter(item=>!item.old||!item.new);return {paired:paired.length,changes:paired.filter(item=>['Changed','Renamed'].includes(item.status)).length,unmatched:unmatched.length}}
function renderFriendlyOverview(){
 if(!report)return;
 const root=$('friendly-overview');if(!root)return;const facts=reportOverviewFacts(report);root.replaceChildren();
 const title=document.createElement('h2');title.textContent='What needs attention';
 const copy=document.createElement('p');copy.textContent='Start with the items found in both systems. Review the remaining items before deciding what to replace.';
 const counts=document.createElement('dl');counts.className='friendly-summary-counts';
 for(const [value,label,description]of [[facts.paired,'Found in both','Ready to compare side by side'],[facts.changes,'Changes to review','Differences within those paired items'],[facts.unmatched,'No match found','Check other names and captured pages']]){const group=document.createElement('div'),number=document.createElement('dd'),term=document.createElement('dt'),note=document.createElement('p');number.textContent=value.toLocaleString();term.textContent=label;note.textContent=description;group.append(term,number,note);counts.append(group)}root.append(title,copy,counts);if(typeof renderDecisionOverview==='function')renderDecisionOverview(root);
 $('panel-comparison').querySelector('.snapshot-heading h2').textContent='Comparison overview';
 $('scenario-label').hidden=!report.migrationDetection?.confident||report.migrationDetection?.type==='unknown';
 for(const side of ['source','target']){const panel=$('panel-'+side);panel.querySelector('.extraction-title h2').textContent=(side==='source'?'Source':'Target')+' components & styles';panel.querySelector('.extraction-title .eyebrow')?.setAttribute('hidden','');const search=$(side+'-extraction-search');search.placeholder='Find a component, color or text style…';const summary=$(side+'-gallery-summary');const labels=['Items with a visual','Icons','Captured examples','Need a preview'];summary?.querySelectorAll(':scope > div > span').forEach((span,index)=>{if(labels[index])span.textContent=labels[index]})}
}
function initializeVisualReports(){
 const panel=$('panel-comparison'),heading=panel?.querySelector('.snapshot-heading');if(!heading)return;
 panel.classList.add('visual-first-report');
 const overview=document.createElement('section');overview.id='friendly-overview';overview.className='friendly-overview';$('comparison-system-pair').after(overview);
 for(const selector of ['.kpis','.decision-brief','.comparison-next-steps'])panel.querySelector(selector)?.setAttribute('hidden','');
 const advanced=document.createElement('section');advanced.className='report-more';const title=document.createElement('h2');title.textContent='Explore more';advanced.append(title);
 for(const [id,label]of [['analytics','Charts & detailed counts'],['mapping-dashboard','Review possible matches'],['deliverables-panel','Create an implementation brief']]){const section=$(id);if(!section)continue;const details=document.createElement('details'),summary=document.createElement('summary');details.className='report-disclosure';summary.textContent=label;details.append(summary,section);advanced.append(details)}panel.append(advanced);
 const actions=heading.querySelector('.export-actions');if(actions){const more=document.createElement('details'),summary=document.createElement('summary');more.className='report-downloads';summary.textContent='Download report';more.append(summary);for(const id of ['export-json','export-md','export-html'])if($(id))more.append($(id));actions.append(more)}
 panel.querySelector('.comparison-section .section-heading h2').textContent='Compare the examples';$('reset-scope').textContent='Reset work estimates';
 const view=$('comparison-view');view.value='cards';view.querySelector('[value="cards"]').textContent='Side-by-side examples';view.querySelector('[value="tree"]').textContent='Detailed category checklist';view.querySelector('[value="table"]').textContent='Comparison table';
 const toolbar=panel.querySelector('.comparison-section .toolbar'),filters=document.createElement('details'),filterTitle=document.createElement('summary');filters.className='visual-report-filters';filterTitle.textContent='Filter & view options';filters.append(filterTitle);for(const control of [...toolbar.children])if(!control.classList.contains('search'))filters.append(control);filters.append(panel.querySelector('.comparison-view-toolbar'),$('categories'));toolbar.append(filters);
 for(const side of ['source','target']){$(side+'-extraction-format').value='gallery';$(side+'-extraction-format').querySelector('[value="gallery"]').textContent='Visual gallery';$(side+'-extraction-format').querySelector('[value="tree"]').textContent='Detailed category checklist'}
 for(const side of ['source','target']){const page=$('panel-'+side),tools=page.querySelector('.extraction-tools'),options=document.createElement('details'),title=document.createElement('summary');options.className='visual-report-filters';title.textContent='Browse options';options.append(title);for(const control of [...tools.children])if(control.tagName!=='INPUT')options.append(control);options.append(page.querySelector('.comparison-view-toolbar'));tools.append(options);const capture=document.createElement('details'),captureTitle=document.createElement('summary');capture.className='capture-information';captureTitle.textContent='About this capture';capture.append(captureTitle);const gallery=$(side+'-gallery-summary');gallery.before(capture);capture.append(gallery)}
 const originalFiltered=filtered;filtered=function(){const rank=item=>item.old?.html&&item.new?.html?0:item.old&&item.new?1:2;return originalFiltered().sort((a,b)=>rank(a)-rank(b))};
 const originalGalleryPreview=makePreview;makePreview=function(item,label){if(!/^(?:SOURCE|TARGET) EXAMPLE$/.test(label))return originalGalleryPreview(item,label);const root=document.createElement('div');root.append(makeSinglePreview(item,label));const count=item.variants?.filter(variant=>variant.html).length||0;if(count>1){const details=document.createElement('details'),summary=document.createElement('summary');details.className='additional-examples';summary.textContent='See all '+count+' captured examples';details.append(summary);details.addEventListener('toggle',()=>{if(!details.open||details.dataset.ready)return;details.dataset.ready='true';details.append(originalGalleryPreview(item,label))});root.append(details)}return root};
 const mobile=matchMedia('(max-width:680px)');let wasCollapsed;const mobileMenu=()=>{const sidebar=document.querySelector('.sidebar'),toggle=$('sidebar-toggle');if(mobile.matches){wasCollapsed=sidebar.classList.contains('collapsed');sidebar.classList.add('collapsed');document.body.classList.add('sidebar-collapsed');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Expand sidebar')}else if(wasCollapsed!==undefined){sidebar.classList.toggle('collapsed',wasCollapsed);document.body.classList.toggle('sidebar-collapsed',wasCollapsed);toggle.setAttribute('aria-expanded',String(!wasCollapsed));toggle.setAttribute('aria-label',wasCollapsed?'Expand sidebar':'Collapse sidebar')}};mobile.addEventListener('change',mobileMenu);if(mobile.matches)mobileMenu();
 const sourceButton=document.querySelector('[data-index-target="panel-source"]'),targetButton=document.querySelector('[data-index-target="panel-target"]');if(sourceButton)sourceButton.textContent='Source components';if(targetButton)targetButton.textContent='Target components';
 const originalReport=renderReport;renderReport=function(){originalReport();renderFriendlyOverview()};
 const originalLanguage=applyPlainLanguage;applyPlainLanguage=function(){originalLanguage();renderFriendlyOverview()};
 const originalExtraction=renderExtraction;renderExtraction=function(side){originalExtraction(side);renderFriendlyOverview()};
}
initializeVisualReports();
