import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const worker=(await import(pathToFileURL(resolve('worker/index.js')))).default;
const port=Number(process.env.PORT||4173),host=process.env.HOST||'127.0.0.1';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be between 1 and 65535.');
const env={FIRECRAWL_API_KEY:process.env.FIRECRAWL_API_KEY||''};
const server=http.createServer(async(req,res)=>{
 let reader;
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks);
  const request=new Request('http://'+(req.headers.host||`localhost:${port}`)+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{})});
  const result=await worker.fetch(request,env,{});
  res.writeHead(result.status,Object.fromEntries(result.headers));res.flushHeaders();
  if(result.body){
   reader=result.body.getReader();
   res.on('close',()=>{if(!res.writableEnded)reader.cancel().catch(()=>{})});
   while(!res.destroyed){const {done,value}=await reader.read();if(done)break;if(!res.write(value))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve()};res.once('drain',done);res.once('close',done)})}
  }
  if(!res.destroyed)res.end();
 }catch(error){
  if(res.destroyed)return;
  if(res.headersSent){res.destroy(error);return}
  res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));
 }finally{reader?.releaseLock()}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Set another PORT in .env.`:error.message);process.exitCode=1});
server.listen(port,host,()=>console.log(`GapScan: http://localhost:${port}\nSource changes: stop this server, then run npm start again.`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
