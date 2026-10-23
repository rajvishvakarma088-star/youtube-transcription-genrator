import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {videoId,captions} from './lib/transcript.js';

const root = path.resolve('public');
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/api/media-config'){
    const url=process.env.CLOUD_DOWNLOADER_URL||'';
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({base:/^https:\/\/[^/]+$/.test(url)?url:null}));return;
  }
  if(u.pathname==='/api/transcript'){
    const id=videoId(u.searchParams.get('url')||''); if(!id){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:'Enter a valid YouTube video URL.'}));return}
    try{const data=await captions(id,u.searchParams.get('lang'));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data))}catch(e){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}))}return;
  }
  const requested=u.pathname==='/'||u.pathname==='/transcript'?'/index.html':u.pathname;
  const file=path.resolve(root,'.'+requested);if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
  try{const data=await fs.readFile(file);res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});res.end(data)}catch{res.writeHead(404);res.end('Not found')}
});
server.listen(process.env.PORT||3000,'127.0.0.1',()=>console.log('Open http://localhost:'+(process.env.PORT||3000)));
