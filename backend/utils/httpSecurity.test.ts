import express from 'express';
import type { Server } from 'http';
import { securityHeaders } from './httpSecurity';
import { isAdminRequest } from './adminAuth';
let server: Server, base: string;
beforeAll(async () => {
  const app=express();app.disable('x-powered-by');app.use(securityHeaders);
  app.get('/debug', (req,res)=>isAdminRequest(req)?res.json({ok:true}):res.status(404).end());
  app.get('/bad-error', (_req,res)=>res.status(500).json({ok:false,error:'mongodb://user:private-password@db.internal/data'}));
  app.use((_req,res)=>res.json({ok:true}));
  server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
it.each(['/.env','/.env.production','/.git/config','/key.pem','/bundle.map','/service-account.json'])('does not serve private paths: %s',async path=>{
  expect((await fetch(base+path)).status).toBe(404);
});
it('prevents caching authenticated responses and exposes no framework header',async()=>{
  const response=await fetch(base+'/data',{headers:{'x-install-id':'test-install'}});
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-powered-by')).toBeNull();
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});
it('requires the configured admin key for debugging',async()=>{
  process.env.ADMIN_SECRET='test-admin-key-value';
  expect((await fetch(base+'/debug')).status).toBe(404);
  expect((await fetch(base+'/debug',{headers:{'x-admin-key':'wrong'}})).status).toBe(404);
  expect((await fetch(base+'/debug',{headers:{'x-admin-key':'test-admin-key-value'}})).status).toBe(200);
  delete process.env.ADMIN_SECRET;
});
it('does not expose internal exception messages in API responses',async()=>{
  expect(await (await fetch(base+'/bad-error')).json()).toEqual({ok:false,error:'server_error'});
});
