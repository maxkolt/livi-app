const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const ts=require('typescript');
const root=path.resolve(__dirname,'../..');
const name='react-native+0.79.6-animated-props-retention.patch';
const relative='src/private/animated/createAnimatedPropsHook.js';
const runner=fs.readFileSync(path.join(root,'scripts/apply-patches.js'),'utf8');
const parsed=ts.createSourceFile('apply-patches.js',runner,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const loop=parsed.statements.find(node=>ts.isForOfStatement(node)&&node.expression.getText(parsed)==='patches');
assert(loop,'postinstall patch loop exists');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'livi-animated-props-patch-'));
 const target=path.join(dir,'node_modules/react-native'),source=path.join(target,relative),patches=path.join(dir,'patches');
 fs.mkdirSync(path.dirname(source),{recursive:true});fs.mkdirSync(patches);
 fs.copyFileSync(path.join(root,'node_modules/react-native',relative),source);
 fs.copyFileSync(path.join(root,'patches',name),path.join(patches,name));
 const options={cwd:target,stdio:'pipe'},args=['-p1','--batch','-i',path.join(patches,name)];
 // Recreate the original dependency in isolation; never reverse the real install.
 execFileSync('patch',[...args,'--reverse','--force'],options);
 const apply=()=>vm.runInNewContext(loop.getText(parsed),{
   patches:[{dir:'node_modules/react-native',file:name,required:true}],root:dir,patchesDir:patches,
   fs,path,execFileSync,console:{log(){},warn(){}},
 });
 return {dir,target,source,patches,apply,dispose:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('fresh postinstall applies the required React Native fix exactly and repeated runs verify it',()=>{
 const f=fixture();try{
  const pristine=fs.readFileSync(f.source,'utf8');f.apply();
  const patched=fs.readFileSync(f.source,'utf8');assert.notEqual(patched,pristine);
  assert.equal(patched,fs.readFileSync(path.join(root,'node_modules/react-native',relative),'utf8'));
  f.apply();assert.equal(fs.readFileSync(f.source,'utf8'),patched);
 }finally{f.dispose()}
});
test('an incompatible dependency fails before modifying its source',()=>{
 const f=fixture();try{
  const incompatible='// incompatible dependency version\n';fs.writeFileSync(f.source,incompatible);
  assert.throws(f.apply);assert.equal(fs.readFileSync(f.source,'utf8'),incompatible);
 }finally{f.dispose()}
});
test('a missing required patch fails the installation',()=>{
 const f=fixture();try{fs.unlinkSync(path.join(f.patches,name));assert.throws(f.apply,/required patch missing/)}finally{f.dispose()}
});
