export type PaletteChoice={label:string;run:()=>void|Promise<void>};
export function paletteGroup(label:string){
 if(/^(Invoices)/.test(label))return 'Billing';
 if(/^(Takeout)/.test(label))return 'Archive';
 if(/^(Media|Inspect media)/.test(label))return 'Media';
 if(/^(Voice|Dictation)/.test(label))return 'Voice & dictation';
 if(/^(Flow|Runtime|Monitor|Discover account)/.test(label))return 'Automation & runtime';
 if(/^(Settings|Map website)/.test(label))return 'Settings';
 if(/^(GPTs|Browse|Search|Refresh)/.test(label))return 'Library';
 if(/^(Select|Use website|Switch account)/.test(label))return 'Model & account';
 if(/browser/i.test(label))return 'Browser';
 return 'Conversation';
}
export function groupPalette<T extends {label:string}>(items:T[]){const groups=new Map<string,T[]>();for(const item of items){const name=paletteGroup(item.label);groups.set(name,[...(groups.get(name)||[]),item]);}return [...groups].map(([label,items])=>({label,items}));}
