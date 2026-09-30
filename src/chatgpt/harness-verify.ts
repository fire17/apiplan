/** Evidence checks only: no browser access, retries, or mutation of the run record. */
export function verifyHarnessRun(state:any,token:string){
 const rows:any[]=Array.isArray(state.driverTurns)?state.driverTurns:[],events:any[]=Array.isArray(state.events)?state.events:[];
 const parents=rows.filter(row=>row.agentId==='parent'),children=rows.filter(row=>row.agentId!=='parent'),taskChildren=children.filter(row=>row.kind==='turn');
 const expectedModel=state.model||'Latest',expectedEffort=state.effort||'Instant';
 const selectionVerified=(row:any)=>{const selection=row.driver?.selection;return selection?.mode?.verified===true&&selection.mode.selected==='Chat'&&selection.model?.verified===true&&selection.model.selected===expectedModel&&selection.effort?.verified===true&&String(selection.effort.selected).toLowerCase()===expectedEffort.toLowerCase();};
 const identityVerified=(row:any)=>row.driver?.identity?.verified===true&&row.driver.identity.userId===state.account?.userId&&row.driver.identity.account===state.account?.id;
 const conversation=(row:any)=>{try{const url=new URL(row.url);return url.origin==='https://chatgpt.com'&&url.pathname.match(/^\/c\/([A-Za-z0-9_-]+)\/?$/)?.[1]===row.conversation&&typeof row.conversation==='string'&&!!row.conversation;}catch{return false;}};
 const stable=(turns:any[])=>turns.length>0&&turns.every(conversation)&&new Set(turns.map(row=>row.conversation)).size===1;
 const allSubmissionsObserved=rows.length>0&&rows.every(row=>row.submitted===true&&row.driver?.submission?.verified===true&&!row.error&&!!row.finished);
 const allSelectionsVerified=rows.length>0&&rows.every(selectionVerified);
 const allIdentitiesVerified=!!state.account?.userId&&rows.length>0&&rows.every(identityVerified);
 const parentConversationStable=stable(parents);
 const childIds=[...new Set(children.map(row=>row.agentId))];
 const childConversationsStable=childIds.length>0&&childIds.every(id=>stable(children.filter(row=>row.agentId===id)));
 const conversationGroups=[parents,...childIds.map(id=>children.filter(row=>row.agentId===id))];
 const agentConversationsDistinct=conversationGroups.every(stable)&&new Set(conversationGroups.map(group=>group[0]?.conversation)).size===conversationGroups.length;
 const parallelChildGenerations=taskChildren.some((a,i)=>taskChildren.some((b,j)=>i!==j&&a.agentId!==b.agentId&&a.submitted===true&&b.submitted===true&&Number.isFinite(Date.parse(a.submittedAt))&&Number.isFinite(Date.parse(b.submittedAt))&&Date.parse(a.submittedAt)<Date.parse(b.finished)&&Date.parse(b.submittedAt)<Date.parse(a.finished)));
 const dispatchDuringParentStream=events.some(event=>{
  if(event.type!=='tool.call'||event.agentId!=='parent'||event.source!=='stream'||!Number.isFinite(event.seq))return false;
  return events.some(start=>{
   if(start.type!=='turn.started'||start.agentId!=='parent'||event.turnId!==start.turnId||!(start.seq<event.seq))return false;
   const end=events.find(end=>end.type==='turn.completed'&&end.agentId==='parent'&&end.turnId===start.turnId&&end.seq>event.seq);
   if(!end)return false;
   return events.some(chunk=>chunk.type==='turn.event'&&chunk.agentId==='parent'&&chunk.turnId===start.turnId&&chunk.seq>start.seq&&chunk.seq<event.seq&&['protocol.text','protocol.replace'].includes(chunk.event?.type));
  });
 });
 const failedEvents=events.filter(event=>['protocol.error','tool.error','turn.failed'].includes(event.type)||event.type==='tool.result'&&event.ok===false);
 const failedCalls=(state.snapshot?.calls||[]).filter((call:any)=>call.status==='error');
 const noFailures=!state.error&&rows.every(row=>!row.error)&&failedEvents.length===0&&failedCalls.length===0;
 const sequence=(name:string,expected:number[])=>{
  const named=children.filter(row=>row.name===name),agents=[...new Set(named.map(row=>row.agentId))],observed:number[]=[],ambiguous:string[]=[];
  for(const row of named){
   if(row.kind==='bootstrap')continue;
   const matches=[...String(row.text||'').matchAll(new RegExp('\\b'+name.toUpperCase()+'_VALUE:\\s*(-?\\d+)\\b','g'))];
   if(!matches.length)continue;
   const tokens=[...String(row.text||'').matchAll(/\bTOKEN:\s*([A-Za-z0-9_-]+)/g)];
   if(matches.length!==1||tokens.length!==1||tokens[0][1]!==token){ambiguous.push(row.requestId||row.started||name);continue;}
   observed.push(Number(matches[0][1]));
  }
  return {observed,expected,ambiguous,verified:agents.length===1&&ambiguous.length===0&&JSON.stringify(observed)===JSON.stringify(expected)};
 };
 const alpha=sequence('alpha',[42,47,42]),beta=sequence('beta',[17,42,17]);
 const parentRows:any[]=Array.isArray(state.parentTurns)?state.parentTurns:[],parentTurns=parentRows.length,eventBySeq=new Map(events.filter(event=>Number.isSafeInteger(event.seq)).map(event=>[event.seq,event])),usedDeliverySeqs=new Set<number>();let deliveryReferencesValid=true;
 const delivered=parentRows.flatMap((row,index)=>{const seqs=Array.isArray(row.deliveredEventSeqs)?row.deliveredEventSeqs:[];if(row.deliveredEvents!==seqs.length)deliveryReferencesValid=false;return seqs.flatMap((seq:any)=>{if(!Number.isSafeInteger(seq)||usedDeliverySeqs.has(seq)){deliveryReferencesValid=false;return [];}usedDeliverySeqs.add(seq);const event=eventBySeq.get(seq);if(!event){deliveryReferencesValid=false;return [];}return event.type==='agent.message'&&event.agentId==='parent'?[{event,row,index}]:[];});});
 const deliveredSequence=(name:string,expected:number[])=>{const observed:number[]=[],ambiguous:number[]=[],sources=new Set<string>();for(const item of delivered.filter(item=>item.event.fromName===name)){const text=String(item.event.text||''),values=[...text.matchAll(new RegExp('\\b'+name.toUpperCase()+'_VALUE:\\s*(-?\\d+)\\b','g'))],tokens=[...text.matchAll(/\bTOKEN:\s*([A-Za-z0-9_-]+)/g)],source=taskChildren.find(row=>(row.agentId===item.event.fromAgentId||row.name===name)&&row.name===name&&row.text===text);if(values.length!==1||tokens.length!==1||tokens[0][1]!==token||!source){ambiguous.push(item.event.seq);continue;}observed.push(Number(values[0][1]));sources.add(source.requestId||source.turnId||source.started);}return {observed,expected,ambiguous,sources:[...sources],verified:ambiguous.length===0&&JSON.stringify(observed)===JSON.stringify(expected)};};
 const deliveredAlpha=deliveredSequence('alpha',[42,47,42]),deliveredBeta=deliveredSequence('beta',[17,42,17]);
 const deliveryTurns=[...new Set(delivered.map(item=>item.index))],deliveredNames=[...new Set(delivered.map(item=>item.event.fromName).filter((name:any)=>typeof name==='string'))];
 const childMessagesDelivered=deliveryReferencesValid&&deliveredNames.includes('alpha')&&deliveredNames.includes('beta')&&deliveryTurns.length>=2&&deliveryTurns.every(index=>index>0)&&deliveredAlpha.verified&&deliveredBeta.verified;
 const finalText=String(parentRows.at(-1)?.text||'').trim(),finalMatches=[...finalText.matchAll(/\bALPHA_FINAL:\s*(-?\d+)\s+BETA_FINAL:\s*(-?\d+)\s+TOKEN:\s*([A-Za-z0-9_-]+)\b/g)],latestAlpha=deliveredAlpha.observed.at(-1),latestBeta=deliveredBeta.observed.at(-1);
 const finalGrounded=finalMatches.length===1&&finalMatches[0][0]===finalText&&finalMatches[0][3]===token&&Number(finalMatches[0][1])===latestAlpha&&Number(finalMatches[0][2])===latestBeta;
 const requiredTurns=Number(state.requestedParentTurns??(state.test?5:1));
 const enoughParentTurns=Number.isSafeInteger(requiredTurns)&&requiredTurns>0&&parentTurns>=requiredTurns&&(!state.test||parentTurns>=5);
 const idle=state.idle===true&&(state.snapshot?.counts?.pending===undefined||state.snapshot.counts.pending===0);
 const checks:Record<string,boolean>={enoughParentTurns,allSubmissionsObserved,allSelectionsVerified,allIdentitiesVerified,parentConversationStable,noFailures,idle};
 if(state.test)Object.assign(checks,{childConversationsStable,agentConversationsDistinct,parallelChildGenerations,dispatchDuringParentStream,alphaSequence:alpha.verified,betaSequence:beta.verified,childMessagesDelivered,finalGrounded});
 const failures=Object.entries(checks).filter(([,pass])=>!pass).map(([name])=>name);
 return {complete:failures.length===0,parentTurns,requiredParentTurns:requiredTurns,allSubmissionsObserved,allSelectionsVerified,allIdentitiesVerified,parentConversationStable,childConversationsStable,agentConversationsDistinct,children:children.length,parallelChildGenerations,dispatchDuringParentStream,alpha,beta,deliveredAlpha,deliveredBeta,deliveryReferencesValid,deliveryParentTurns:deliveryTurns.map(index=>parentRows[index]?.number??index+1),deliveredChildNames:deliveredNames,childMessagesDelivered,finalGrounded,alpha42:alpha.observed.includes(42),alpha47:alpha.observed.includes(47),beta17:beta.observed.includes(17),beta42:beta.observed.includes(42),noFailures,failureEvents:failedEvents.map(event=>({type:event.type,seq:event.seq,agentId:event.agentId,code:event.error?.code})),failures,token,idle};
}
