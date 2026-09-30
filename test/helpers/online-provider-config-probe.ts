const {online}=await import('../../src/providers-online.ts');
const {resolve}=await import('../../src/registry.ts');
const probe=online.probe(),output:any={probe};
if(probe.connected){
 const creds=online.creds();
 output.creds={account:creds.account,source:creds.source};
 output.chat=(online.build(resolve('online/chat')!,[{role:'user',text:'hello'}],{effort:'low'},creds).body as any).selection;
 output.astra=(online.build(resolve('online/astra')!,[{role:'user',text:'hello'}],{effort:'low'},creds).body as any).selection;
}
process.stdout.write(JSON.stringify(output));
