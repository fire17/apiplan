import {realpath,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
/** Resolve a local attachment without contacting the website or reading its contents. */
export async function attachmentPath(value:string){
 if(!value.trim())throw new Error('Enter a local file path.');
 const expanded=value.trim().replace(/^~(?=\/|$)/,homedir()),path=await realpath(resolve(expanded)),info=await stat(path);
 if(!info.isFile())throw new Error('Attachment must be a regular file.');
 if(!info.size)throw new Error('Attachment file is empty.');
 return path;
}
export const mediaReference=(item:any):string=>String(item.reference||item.asset_pointer||item.src||item.url||item.id||'');
