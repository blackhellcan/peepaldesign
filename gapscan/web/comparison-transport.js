import {comparisonFingerprint} from '/local-engine.js';
// Encoding and parsing large evidence snapshots must not block the UI thread.
// Component matching itself runs exclusively on /api/compare.
let activeController;
self.onmessage = async ({data}) => {
 if(data.type==='cancel'){activeController?.abort();return}
 if(data.type!=='compare')return;
 activeController=new AbortController();
 let reader;
 try{
  for(const side of ['old','new']){const profile=data.payload[side];profile.fingerprint=comparisonFingerprint(profile.fingerprint);delete profile.previewAssets}
  const encoded=JSON.stringify(data.payload);
  const compressed=await new Response(new Blob([encoded]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  const response=await fetch('/api/compare',{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':'gzip'},body:compressed,signal:activeController.signal});
  if(!response.ok){let message;try{message=(await response.json()).error}catch{}throw new Error(message||`Comparison failed (HTTP ${response.status}).`)}
  if(!response.body)throw new Error('The comparison service returned no response stream.');
  reader=response.body.getReader();const decoder=new TextDecoder();let parts=[],found=false;
  const consume=line=>{
   if(!line.trim())return;
   let event;try{event=JSON.parse(line)}catch{throw new Error('The comparison connection returned an incomplete report. Your extracted systems are retained; retry the comparison.')}
   if(event.type==='error')throw new Error(event.message||'Backend comparison failed.');
   if(event.type==='progress')self.postMessage(event);
   if(event.type==='result'){found=true;self.postMessage(event)}
  };
  // Keep chunk fragments instead of copying and splitting an ever-growing
  // multi-megabyte result string on every network read.
  while(true){const chunk=await reader.read();if(chunk.done)break;const text=decoder.decode(chunk.value,{stream:true});let start=0,index;while((index=text.indexOf('\n',start))!==-1){parts.push(text.slice(start,index));consume(parts.join(''));parts=[];start=index+1}if(start<text.length)parts.push(text.slice(start))}
  parts.push(decoder.decode());if(parts.length)consume(parts.join(''));
  if(!found)throw new Error('The comparison connection ended before a complete report arrived. Retry the comparison.');
 }catch(error){self.postMessage({type:'error',name:error.name,message:error.message||'Comparison failed.'})}
 finally{reader?.releaseLock();activeController=null}
};
