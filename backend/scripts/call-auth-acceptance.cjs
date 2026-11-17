// Full backend acceptance with disposable local MongoDB and synthetic credentials.
// Requires frontend dependencies for the Socket.IO test client. Never loads backend/.env.
const fs=require('fs'), path=require('path'), os=require('os'),crypto=require('crypto'),assert=require('assert');
const root=path.resolve(__dirname,'../..');
const {MongoClient,ObjectId}=require(root+'/backend/node_modules/mongodb');
const {io}=require(root+'/frontend/node_modules/socket.io-client');
const nacl=require(root+'/frontend/node_modules/tweetnacl');
const {spawn}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'livi-call-auth-')),dbName='livi_auth_acceptance_'+Date.now(),uri='mongodb://127.0.0.1:27017/'+dbName;
const secret='a'.repeat(64),pepper='local-test-only-pepper-'.repeat(3),hash='v1:'+crypto.createHmac('sha256',pepper).update(secret).digest('hex');
const client=new MongoClient(uri);const sockets=[];let server;const results=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const ack=(s,event,payload,ms=7000)=>new Promise((r,j)=>{const timer=setTimeout(()=>j(Error(event+' timeout')),ms);s.emit(event,payload,b=>{clearTimeout(timer);r(b)})});
const record=(scenario,details)=>{results.push({scenario,...details});fs.writeFileSync(path.join(dir,'auth-acceptance-results.json'),JSON.stringify({database:dbName,results},null,2));console.log(JSON.stringify(results.at(-1)))};
(async()=>{
 await client.connect(); const db=client.db();const users=[new ObjectId(),new ObjectId(),new ObjectId()];
 await db.collection('users').insertMany(users.map((id,i)=>({_id:id,nick:'local-call-test-'+i,friends:[],createdAt:new Date()})));
 await db.collection('installs').insertMany(users.map((id,i)=>({installId:'inst_android_acceptance_'+i,user:id,installSecretHash:hash})));
 const log=fs.openSync(path.join(dir,'local-backend.log'),'w');
 server=spawn(process.execPath,[root+'/backend/dist/index.js'],{cwd:fs.mkdtempSync(path.join(os.tmpdir(),'livi-empty-env-')),env:{PATH:process.env.PATH,NODE_ENV:'test',PORT:'18080',HOST:'127.0.0.1',MONGO_DB:uri,INSTALL_SECRET_PEPPER:pepper,LIVEKIT_API_KEY:'local-test',LIVEKIT_API_SECRET:'b'.repeat(40),LIVEKIT_URL:'ws://127.0.0.1:17880',LOG_LEVEL:'info'},stdio:['ignore',log,log]});
 for(let i=0;i<100;i++){try{const h=await(await fetch('http://127.0.0.1:18080/health')).json();if(h.mongo===1)break;}catch{}if(i===99)throw Error('backend_not_ready');await pause(100)}
 const connect=async(i,proof)=>{const s=io('http://127.0.0.1:18080',{transports:['websocket'],reconnection:false,auth:{installId:'inst_android_acceptance_'+i,...(proof?{installSecret:secret}:{})}});sockets.push(s);await new Promise((r,j)=>{s.once('connect',r);s.once('connect_error',j)});await pause(80);return s;};
 const caller=await connect(0,true);assert.equal((await ack(caller,'reauth',{installSecret:secret})).ok,true);
 const key=()=>({pk:Buffer.from(nacl.box.keyPair().publicKey).toString('base64')});
 const initiate=()=>ack(caller,'call:initiate',{to:String(users[1]),e2ee:key()});
 const attach=s=>ack(s,'identity:attach',{installId:'inst_android_acceptance_1',installSecret:secret});
 let callee=await connect(1,false);
 let init=await initiate();assert.equal(init.ok,true,JSON.stringify(init));
 const start=Date.now();const accepting=ack(callee,'call:accept',{callId:init.callId,e2ee:key()});
 await pause(300);const attached=await attach(callee);assert.equal(attached.ok,true,JSON.stringify(attached));
 let accepted=await accepting;assert.equal(accepted.ok,true,JSON.stringify(accepted));record('release211_accept_before_attach',{ok:true,waitMs:Date.now()-start});
 caller.emit('call:end',{callId:init.callId});await pause(200);callee.disconnect();
 callee=await connect(1,false);init=await initiate();assert.equal(init.ok,true,JSON.stringify(init));
 const refused=ack(callee,'call:accept',{callId:init.callId,e2ee:key()});
 const wrong=await ack(callee,'identity:attach',{installId:'inst_android_acceptance_1',installSecret:'c'.repeat(64)});assert.equal(wrong.ok,false);
 accepted=await refused;assert.equal(accepted.error,'unauthorized');record('guessed_identifier_wrong_secret',{ok:true,accepted:false});
 caller.emit('call:cancel',{callId:init.callId});await pause(200);callee.disconnect();
 callee=await connect(1,false);init=await initiate();assert.equal(init.ok,true,JSON.stringify(init));
 const canceled=ack(callee,'call:accept',{callId:init.callId,e2ee:key()});caller.emit('call:cancel',{callId:init.callId});await pause(150);await attach(callee);
 accepted=await canceled;assert.equal(accepted.ok,false,JSON.stringify(accepted));assert.equal(accepted.error,'not_found');record('hangup_while_waiting_for_identity',{ok:true,revived:false});
 callee.disconnect();await pause(150);callee=await connect(1,false);
 const outgoing=ack(callee,'call:initiate',{to:String(users[0]),e2ee:key()});await pause(150);await attach(callee);
 const sent=await outgoing;assert.equal(sent.ok,true,JSON.stringify(sent));record('release211_initiate_before_attach',{ok:true});callee.emit('call:cancel',{callId:sent.callId});await pause(150);
 init=await initiate();assert.equal(init.ok,true,JSON.stringify(init));
 const outsider=await connect(2,true);assert.equal((await ack(outsider,'reauth',{installSecret:secret})).ok,true);
 const thirdParty=await ack(outsider,'call:accept',{callId:init.callId,e2ee:key()});
 record('third_party_accept',{ok:thirdParty.ok===false,response:thirdParty});assert.equal(thirdParty.ok,false,'another authenticated account accepted someone else call');
 outsider.emit('call:cancel',{callId:init.callId});outsider.emit('call:decline',{callId:init.callId});await pause(150);
 const properAccept=await ack(callee,'call:accept',{callId:init.callId,e2ee:key()});assert.equal(properAccept.ok,true,'third party cancel/decline destroyed the call');
 let remoteEnds=0;callee.on('call:ended',()=>remoteEnds++);caller.on('call:ended',()=>remoteEnds++);
 outsider.emit('call:end',{callId:init.callId});await pause(150);assert.equal(remoteEnds,0,'third party ended the call');
 outsider.emit('call:end',{roomId:'room_'+[String(users[0]),String(users[1])].sort().join('_')});await pause(150);assert.equal(remoteEnds,0,'third party ended room');
 callee.emit('call:end',{callId:init.callId});await pause(200);assert(remoteEnds>0,'legitimate hangup failed');
 record('third_party_cancel_decline_end',{ok:true,legitimateHangup:true});
 record('complete',{ok:true,scenarios:6});
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(async()=>{
 for(const s of sockets)s.disconnect();if(server){server.kill('SIGTERM');await new Promise(r=>{server.once('exit',r);setTimeout(()=>{server.kill('SIGKILL');r()},4000).unref()})}
 if(dbName.startsWith('livi_auth_acceptance_'))await client.db(dbName).dropDatabase();await client.close();
});
