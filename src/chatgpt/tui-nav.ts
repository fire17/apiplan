/** Stable recency ordering across website timestamps expressed as seconds or ISO dates. */
export function recentFirst<T extends Record<string,any>>(items:T[]):T[]{
 const timestamp=(item:T)=>{const value=item.update_time??item.updated_at??item.updatedAt??item.updated??item.create_time??item.created_at??item.createdAt??item.localObservation?.seenAt;const numeric=typeof value==='number'?value:typeof value==='string'&&/^\d+(\.\d+)?$/.test(value)?Number(value):NaN;if(Number.isFinite(numeric))return numeric<1e12?numeric*1000:numeric;const date=Date.parse(value||'');return Number.isFinite(date)?date:0;};
 return items.map((item,index)=>({item,index,time:timestamp(item)})).sort((a,b)=>b.time-a.time||a.index-b.index).map(value=>value.item);
}
