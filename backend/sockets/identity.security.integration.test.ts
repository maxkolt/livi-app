import mongoose from 'mongoose';
import crypto from 'crypto';
import type { Server } from 'socket.io';
import type { AuthedSocket } from './types';
import User from '../models/User';
import Install from '../models/Install';
import registerIdentitySockets from './identity';
import { hashInstallSecret, verifyInstallSecret } from '../utils/installSecret';
jest.mock('./messagesReliable',()=>({mongoOfflineQueue:new Map(),getAndClearOfflineChatClearedQueue:()=>[]}));
jest.mock('./offlineMessageDelivery',()=>({deliverOfflineMessages:jest.fn(async()=>{})}));
jest.mock('../utils/friendOnlinePresence',()=>({scheduleGlobalFriendPresenceEmit:jest.fn()}));
jest.mock('../utils/welcomeOnlinePresence',()=>({bindWelcomeOnlinePresence:jest.fn()}));
jest.mock('./missedCallDelivery',()=>({getPendingMissedCalls:jest.fn(async()=>[]),registerMissedCallAck:jest.fn()}));
const suite=process.env.LIVI_REWARDS_TEST_MONGO_URI?describe:describe.skip;
suite('installation ownership security with isolated real MongoDB',()=>{
 const secret='a'.repeat(64);let userId:string;
 beforeAll(async()=>{await mongoose.connect(process.env.LIVI_REWARDS_TEST_MONGO_URI!,{dbName:`livi_security_test_${process.pid}_${Date.now()}`});await Promise.all([User.init(),Install.init()]);});
 afterAll(async()=>{await mongoose.connection.dropDatabase();await mongoose.disconnect();});
 beforeEach(async()=>{await Promise.all([User.deleteMany({}),Install.deleteMany({})]);userId=String((await User.create({nick:'security-owner'}))._id);});
 function fixture(){
  const handlers=new Map<string,Function>();let onConnect!: (sock:AuthedSocket)=>void;
  const io={on:(_name:string,fn:typeof onConnect)=>{onConnect=fn},sockets:{sockets:new Map()},to:()=>({emit:jest.fn()})} as unknown as Server;
  registerIdentitySockets(io);
  const sock={id:crypto.randomUUID(),data:{},handshake:{auth:{},query:{}},on:(name:string,fn:Function)=>{handlers.set(name,fn)},join:jest.fn(),emit:jest.fn()} as unknown as AuthedSocket;
  onConnect(sock);return {sock,invoke:async(name:string,payload:object)=>{let reply:unknown;await handlers.get(name)!(payload,(v:unknown)=>{reply=v});return reply;}};
 }
 it('cannot replace a device-bound installation secret by knowing its identifier',async()=>{
  const hash=hashInstallSecret(secret);await Install.create({installId:'inst_android_original1234',user:userId,installSecretHash:hash});
  const {invoke,sock}=fixture();
  expect(await invoke('identity:attach',{installId:'inst_android_original1234',installSecret:'b'.repeat(64)})).toMatchObject({ok:false,error:'unauthorized'});
  expect((await Install.findOne({installId:'inst_android_original1234'}))!.installSecretHash).toBe(hash);
  expect(sock.data.userId).toBeUndefined();
 });
 it('does not bootstrap legacy ownership from the identifier alone',async()=>{
  await Install.create({installId:'inst_android_legacy1234',user:userId});const {invoke}=fixture();
  expect(await invoke('identity:attach',{installId:'inst_android_legacy1234',installSecret:secret})).toMatchObject({ok:false,error:'account_recovery_required'});
  expect((await Install.findOne({installId:'inst_android_legacy1234'}))!.installSecretHash).toBeUndefined();
 });
 it('cannot wipe another account from an unauthenticated socket',async()=>{
  await Install.create({installId:'inst_android_original1234',user:userId,installSecretHash:hashInstallSecret(secret)});
  const {invoke}=fixture();expect(await invoke('identity:wipeMe',{installId:'inst_android_original1234'})).toMatchObject({ok:false,error:'unauthorized'});
  expect(await User.exists({_id:userId})).not.toBeNull();expect(await Install.countDocuments()).toBe(1);
 });
 it('upgrades an existing hash only after the original secret is verified and binds the same user',async()=>{
  const oldHash=crypto.createHmac('sha256','livi-dev-only-pepper-do-not-use-in-production').update(secret).digest('hex');
  await Install.create({installId:'inst_android_original1234',user:userId,installSecretHash:oldHash});
  const {invoke,sock}=fixture();expect(await invoke('identity:attach',{installId:'inst_android_original1234',installSecret:secret})).toMatchObject({ok:true,userId});
  const saved=await Install.findOne({installId:'inst_android_original1234'});
  expect(saved!.installSecretHash).toBe(hashInstallSecret(secret));expect(verifyInstallSecret(secret,saved!.installSecretHash)).toBe(true);
  expect(sock.data.userId).toBe(userId);expect(sock.data.verifiedInstallId).toBe('inst_android_original1234');
 });
 it('keeps an existing legacy account accessible in staged mode without enrolling an unproven secret',async()=>{
  process.env.INSTALL_AUTH_MODE='legacy-migration';
  try {
   await Install.create({installId:'inst_android_legacy1234',user:userId});const {invoke,sock}=fixture();
   expect(await invoke('identity:attach',{installId:'inst_android_legacy1234',installSecret:secret})).toMatchObject({ok:true,userId,legacyMigrationRequired:true});
   expect(sock.data.userId).toBe(userId);
   expect((await Install.findOne({installId:'inst_android_legacy1234'}))!.installSecretHash).toBeUndefined();
   expect(await invoke('identity:wipeMe',{installId:'inst_android_legacy1234'})).toMatchObject({ok:false,error:'unauthorized'});
   expect(await User.countDocuments()).toBe(1);
  } finally { delete process.env.INSTALL_AUTH_MODE; }
 });

});
