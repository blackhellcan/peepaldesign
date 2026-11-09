// ZIP contents stay in memory. No filesystem writes or project scripts are run.
export const SOURCE_EXTENSIONS=/\.(?:html?|css|scss|sass|less|m?js|jsx|tsx?|json|svg|mdx?|txt)$/i;
export const SOURCE_BYTES_LIMIT=10000000;
const ARCHIVE_BYTES_LIMIT=50000000;
const decoder=new TextDecoder('utf-8',{fatal:true});
function checkedPath(name){const path=name.replaceAll('\\','/');if(path.startsWith('/')||/^[a-z]:/i.test(path)||path.split('/').includes('..')||path.includes('\0'))throw Error('ZIP contains an invalid file path.');return path}
export function archiveSourceReason(path,paths=new Set()){
 if(path.endsWith('/'))return 'Folder';
 if(/(?:^|\/)(?:__MACOSX|node_modules|\.git|__tests__|__mocks__|fixtures|coverage|archives?|backups?)(?:\/|$)|(?:^|\/)\.[^/]+$|\.(?:test|spec)\.[a-z]+$/i.test(path))return 'Supporting, dependency or archived file';
 if(/(?:^|\/)(?:package-lock|yarn\.lock|pnpm-lock|tsconfig[^/]*|jsconfig|manifest)|\.(?:map|lock)$/i.test(path))return 'Build metadata';
 if(/\.min\.(?:css|js)$/i.test(path)&&paths.has(path.replace(/\.min(?=\.(?:css|js)$)/i,'')))return 'Duplicate minified distribution';
 if(!SOURCE_EXTENSIONS.test(path))return 'Not a supported source format';
 return null;
}
export function readZipIndex(input){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input);if(bytes.length>ARCHIVE_BYTES_LIMIT)throw Error('Use a ZIP archive smaller than 50 MB.');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),u16=offset=>view.getUint16(offset,true),u32=offset=>view.getUint32(offset,true);
 let end=-1;for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--)if(u32(offset)===0x06054b50&&offset+22+u16(offset+20)===bytes.length){end=offset;break}
 if(end<0)throw Error('This file is not a valid ZIP archive.');if(u16(end+4)||u16(end+6)||u16(end+8)!==u16(end+10))throw Error('Split ZIP archives are unsupported.');
 const count=u16(end+10),size=u32(end+12),offset=u32(end+16);if(count===65535||size===0xffffffff||offset===0xffffffff)throw Error('ZIP64 archives are unsupported. Use a standard ZIP under 50 MB.');if(count>10000||offset+size>end)throw Error('ZIP directory exceeds the supported limits.');
 const entries=[],names=new Set();let cursor=offset;
 for(let n=0;n<count;n++){
  if(cursor+46>offset+size||u32(cursor)!==0x02014b50)throw Error('ZIP directory is damaged.');
  const flags=u16(cursor+8),method=u16(cursor+10),compressedSize=u32(cursor+20),uncompressedSize=u32(cursor+24),nameLength=u16(cursor+28),extraLength=u16(cursor+30),commentLength=u16(cursor+32),localOffset=u32(cursor+42),attributes=u32(cursor+38);
  if(cursor+46+nameLength+extraLength+commentLength>offset+size)throw Error('ZIP directory is truncated.');
  const name=checkedPath(decoder.decode(bytes.subarray(cursor+46,cursor+46+nameLength)));if(names.has(name))throw Error('ZIP contains duplicate file paths.');names.add(name);
  entries.push({name,flags,method,compressedSize,size:uncompressedSize,crc:u32(cursor+16),localOffset,symlink:((attributes>>>16)&0xf000)===0xa000});cursor+=46+nameLength+extraLength+commentLength;
 }
 for(const entry of entries){entry.reason=archiveSourceReason(entry.name,names)||(entry.symlink?'Symbolic link':entry.flags&1?'Encrypted file':![0,8].includes(entry.method)?'Unsupported compression method':entry.size>SOURCE_BYTES_LIMIT?'File exceeds 10 MB':null);entry.eligible=!entry.reason}
 return {bytes,entries,totalEntries:entries.length};
}
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return (crc^0xffffffff)>>>0}
async function inflateBounded(bytes,limit){let stream;try{stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))}catch{throw Error('This browser cannot extract compressed ZIPs. Use a current browser or drop the unzipped source files.');}const reader=stream.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('ZIP file exceeded its declared extraction size.');chunks.push(value)}}catch(error){await reader.cancel().catch(()=>{});throw error}finally{reader.releaseLock()}const output=new Uint8Array(size);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length}return output}
export async function extractZipFiles(archive,selectedNames){
 const selected=new Set(selectedNames),entries=archive.entries.filter(entry=>selected.has(entry.name));if(entries.length!==selected.size)throw Error('A selected ZIP entry is unavailable.');if(entries.some(entry=>!entry.eligible))throw Error('Select only supported source files from this ZIP.');if(entries.reduce((sum,entry)=>sum+entry.size,0)>SOURCE_BYTES_LIMIT)throw Error('Select less than 10 MB of extracted source files.');
 const bytes=archive.bytes,view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),files=[];
 for(const entry of entries){const offset=entry.localOffset;if(offset+30>bytes.length||view.getUint32(offset,true)!==0x04034b50)throw Error('ZIP file header is damaged: '+entry.name);const flags=view.getUint16(offset+6,true),method=view.getUint16(offset+8,true),nameLength=view.getUint16(offset+26,true),extraLength=view.getUint16(offset+28,true),start=offset+30+nameLength+extraLength;
  if(flags&1||method!==entry.method||start+entry.compressedSize>bytes.length||checkedPath(decoder.decode(bytes.subarray(offset+30,offset+30+nameLength)))!==entry.name)throw Error('ZIP file metadata does not match: '+entry.name);
  const data=bytes.subarray(start,start+entry.compressedSize),content=method===0?data:await inflateBounded(data,entry.size);
  if(content.length!==entry.size||crc32(content)!==entry.crc)throw Error('ZIP file failed its integrity check: '+entry.name);
  let text;try{text=decoder.decode(content)}catch{throw Error('This source file is not UTF-8 text: '+entry.name)}
  files.push({name:entry.name,content:text,size:content.length,type:/\.css$/i.test(entry.name)?'text/css':/\.html?$/i.test(entry.name)?'text/html':/\.svg$/i.test(entry.name)?'image/svg+xml':'text/plain'});
 }
 return files;
}
