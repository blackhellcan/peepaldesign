// Serialize plain report data in bounded chunks. JSON.stringify(report) plus
// UTF-8 encoding otherwise requires two complete copies of a large report.
export function* jsonChunks(value,max=32768){
 max=Math.max(2,max);
 function* tokens(value){
  if(value===null||typeof value!=='object'){yield JSON.stringify(value)??'null';return}
  if(Array.isArray(value)){yield '[';for(let index=0;index<value.length;index++){if(index)yield ',';yield* tokens(value[index])}yield ']';return}
  yield '{';let first=true;for(const key of Object.keys(value)){const child=value[key];if(child===undefined||typeof child==='function'||typeof child==='symbol')continue;if(!first)yield ',';first=false;yield JSON.stringify(key)+':';yield* tokens(child)}yield '}';
 }
 let buffer='';for(const token of tokens(value)){if(buffer.length&&buffer.length+token.length>max){yield buffer;buffer=''}if(token.length>max){if(buffer){yield buffer;buffer=''}for(let index=0;index<token.length;){let end=Math.min(token.length,index+max);if(end<token.length&&token.charCodeAt(end-1)>=0xd800&&token.charCodeAt(end-1)<=0xdbff)end--;yield token.slice(index,end);index=end}}else buffer+=token}if(buffer)yield buffer;
}
