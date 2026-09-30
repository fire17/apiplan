// Build one online request for a given route + requested mode and report the `selection`
// the website driver would be handed — or the fault that refused it. No browser, no
// network, no site traffic: `build()` is pure, which is exactly what makes mode plumbing
// testable without spending a message on his account.
const {online}=await import('../../src/providers-online.ts');
const {resolve}=await import('../../src/registry.ts');
const [route,mode,effort]=process.argv.slice(2);
const probe=online.probe();
const output:any={probe:{connected:probe.connected}};
if(probe.connected){
 const creds=online.creds();
 const options:any={effort:effort||'low'};
 if(mode&&mode!=='none')options.mode=mode;
 try{output.selection=(online.build(resolve(route)!,[{role:'user',text:'hello'}],options,creds).body as any).selection;}
 catch(error:any){output.error={code:error?.code,message:error?.message};}
}
process.stdout.write(JSON.stringify(output));
