import {openSync,closeSync,writeSync,fsyncSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {privateDir} from './accounts.ts';
/** Ordered browser playback chunks form one WebM stream; missing chunks fail visibly. */
export class AudioChunkWriter {
 sequence=0;bytes=0;
 constructor(private fd:number){}
 append(result:any){for(const chunk of result.chunks||[]){if(chunk.sequence!==this.sequence)throw new Error('Audio chunk sequence gap: expected '+this.sequence+', received '+chunk.sequence+'. Partial recording preserved.');const bytes=Buffer.from(chunk.base64||'','base64');if(!bytes.length||bytes.length!==chunk.bytes)throw new Error('Audio chunk size mismatch. Partial recording preserved.');writeSync(this.fd,bytes);this.sequence++;this.bytes+=bytes.length;}}
}
export async function captureAudio(browser:any,args:any,emit:(event:any)=>void){
 if(!args.output)throw new Error('Audio capture requires --output PATH.webm.');const duration=Number(args.duration??30);if(!Number.isFinite(duration)||duration<=0||duration>3600)throw new Error('Audio capture duration must be between 0 and 3600 seconds.');
 const path=resolve(args.output);privateDir(dirname(path));const fd=openSync(path,'wx',0o600),writer=new AudioChunkWriter(fd);let armed=false,last:any,primary:any;
 try{
  await browser.call('audio.output.arm',{surface:args.surface});armed=true;emit({type:'audio.capture.started',path,mimeType:'audio/webm;codecs=opus',source:'website playback',ambientMicrophone:false});const end=Date.now()+duration*1000;
  while(Date.now()<end&&!args._signal?.aborted){last=await browser.call('audio.output.read',{surface:args.surface});writer.append(last);if(last.chunks?.length)emit({type:'audio.chunk',path,chunks:writer.sequence,bytes:writer.bytes,audioDetected:last.audioDetected});if(last.overflow||last.error)throw new Error('Website audio capture stopped: '+(last.error||'capture buffer overflow')+'. Partial recording preserved.');await Bun.sleep(150);}
 }catch(error){primary=error;}
 finally{if(armed){try{last=await browser.call('audio.output.stop',{surface:args.surface});writer.append(last);}catch(error){primary??=error;}}fsyncSync(fd);closeSync(fd);}
 if(primary)throw primary;
 return {path,bytes:writer.bytes,chunks:writer.sequence,mimeType:'audio/webm;codecs=opus',audioDetected:last?.audioDetected===true,complete:last?.audioDetected===true&&!last?.overflow&&!last?.error&&!args._signal?.aborted,source:'website Web Audio playback',coverage:'connections created after capture was armed',ambientMicrophone:false};
}
