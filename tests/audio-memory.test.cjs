const {test}=require('node:test');
const assert=require('node:assert/strict');
const {StashAudioMemory}=require('../web/audio-memory.js');
const ref='storage://stash-audio/user/recording.mp3';
function setup({remoteSpeed=null,remotePosition=null,fail=false}={}) {
 const store=new Map(), elements=new Map(), calls=[];
 global.localStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)};
 global.document={hidden:false,addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,{value:'',textContent:'',style:{}});return elements.get(id);}};
 global.window={addEventListener(){}};
 const app={user:{id:'user'},formatTime:s=>String(s),supabase:{
  from(table){return {select(){return this;},eq(){return this;},abortSignal(){return this;},
   async maybeSingle(){return {data:table==='audio_preferences'?remoteSpeed:remotePosition,error:fail?{}:null};}};},
  rpc(name,args){calls.push({name,args});return {abortSignal:async()=>({error:fail?{}:null})};}
 }};
 const memory=new StashAudioMemory(app);
 function audio(){const a=new EventTarget();Object.assign(a,{duration:120,currentTime:0,playbackRate:1});app.audio=a;return a;}
 return {memory,app,calls,store,audio};
}
const event=(a,name)=>a.dispatchEvent(new Event(name));
const tick=()=>new Promise(r=>setImmediate(r));
test('remote speed and position restore, with no write caused by restoration',async()=>{
 const {memory,audio,calls}=setup({remoteSpeed:{speed:1.5,changed_at:'2026-10-20T12:00:00Z'},remotePosition:{audio_url:ref,position_seconds:42,duration_seconds:120,completed:false,changed_at:'2026-10-20T12:00:00Z'}});
 const restored=await memory.restore('save',ref);const a=audio();memory.attach(a,'save',ref,restored);event(a,'loadedmetadata');
 assert.equal(a.playbackRate,1.5);assert.equal(a.currentTime,42);event(a,'seeked');event(a,'timeupdate');
 assert.equal(calls.length,0);memory.detach();assert.equal(calls.length,0);
});
test('regenerated and completed recordings start from the beginning',async()=>{
 for(const completed of [true,false]){
  const {memory,audio}=setup({remotePosition:{audio_url:ref,position_seconds:120,duration_seconds:120,completed,changed_at:'2026-10-20T12:00:00Z'}});
  const target=completed?ref:ref+'-new';const a=audio();memory.attach(a,'save',target,await memory.restore('save',target));event(a,'loadedmetadata');assert.equal(a.currentTime,0);
 }
});
test('offline pause and close retain a resume point and chosen speed locally',async()=>{
 const {memory,audio}=setup({fail:true});const a=audio();memory.attach(a,'save',ref,{speed:1,position:null});event(a,'loadedmetadata');event(a,'play');a.currentTime=37;event(a,'pause');memory.setSpeed(1.5);memory.detach();await tick();
 const restored=await memory.restore('save',ref);assert.equal(restored.speed,1.5);assert.equal(restored.position.position,37);assert.equal(restored.position.pending,true);
});
test('completed state survives detach, and stale detached audio cannot change it',async()=>{
 const {memory,audio}=setup();const a=audio();memory.attach(a,'save',ref,{speed:1,position:null});event(a,'loadedmetadata');event(a,'play');a.currentTime=120;event(a,'ended');memory.detach();a.currentTime=9;event(a,'timeupdate');await tick();
 const data=memory.read('user');assert.equal(data.positions.save.completed,true);assert.equal(data.positions.save.position,120);
});
test('account caches are isolated and storage failures do not break playback',()=>{
 const {memory,app,audio}=setup();memory.setSpeed(1.5);app.user={id:'other'};assert.equal(memory.read('other').speed,null);
 global.localStorage={getItem(){throw Error('denied');},setItem(){throw Error('full');}};
 memory.setSpeed(2);assert.equal(memory.read('other').speed.value,2);const a=audio();memory.attach(a,'s',ref,{speed:2,position:null});event(a,'loadedmetadata');event(a,'play');a.currentTime=12;memory.detach();assert.equal(memory.read('other').positions.s.position,12);
});
test('an in-flight older sync cannot clear a newer local speed choice',async()=>{
 const {memory,app,calls}=setup();let release;let first=true;
 app.supabase.rpc=(name,args)=>{calls.push({name,args});return{abortSignal:()=>first?(first=false,new Promise(r=>release=()=>r({error:null}))):Promise.resolve({error:null})};};
 memory.setSpeed(1.25);memory.setSpeed(1.5);release();await tick();await tick();
 assert.equal(calls.at(-1).args.p_speed,1.5);assert.equal(memory.read('user').speed.pending,false);
});

test('obsolete local recording cannot mask a current remote resume point',async()=>{
 const current=ref+'-new';const {memory}=setup({remotePosition:{audio_url:current,position_seconds:28,duration_seconds:120,completed:false,changed_at:'2020-01-01T00:00:00Z'}});
 memory.write('user',{speed:null,positions:{save:{ref,position:80,duration:120,changedAt:new Date().toISOString(),pending:true}}});
 const restored=await memory.restore('save',current);assert.equal(restored.position.position,28);
});

test('page-exit flush uses authenticated keepalive delivery',async()=>{
 const {memory,app}=setup();app.readStoredSession=()=>({access_token:'fixture-token'});
 global.CONFIG={SUPABASE_URL:'https://example.test',SUPABASE_ANON_KEY:'fixture-public-key'};
 let options;const savedFetch=global.fetch;
 global.fetch=async(url,opts)=>{options=opts;return{ok:true};};
 memory.write('user',{speed:{value:1.5,changedAt:new Date().toISOString(),pending:true},positions:{}});
 await memory.flush(true);assert.equal(options.keepalive,true);assert.equal(JSON.parse(options.body).p_speed,1.5);assert.equal(memory.read('user').speed.pending,false);
 global.fetch=savedFetch;delete global.CONFIG;
});
