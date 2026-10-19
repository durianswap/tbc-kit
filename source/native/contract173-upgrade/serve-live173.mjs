import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,join} from 'node:path';
const consumer=resolve(process.argv[2]);assert.match(consumer,/^\/private\/tmp\/tbc-dart-kit-f3-contract173-ios-live-[a-z]+$/);
const page=await readFile(join(consumer,'assets/dapp.html'));
const server=createServer((req,res)=>{
 if(req.method!=='GET'||req.url!=='/dapp'){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(page);
});
server.listen(41893,'127.0.0.1',()=>console.log('PRIVATE_TESTNET_DAPP_READY_41893'));
