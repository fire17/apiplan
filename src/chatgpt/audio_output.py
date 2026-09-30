"""Capture explicit website Web Audio playback, never the ambient microphone.

Arm before starting Voice. WebM chunks form one ordered stream, not independent
files; an overflow stops recording rather than silently discarding its header.
"""
import json


def _integer(args, key, default, minimum, maximum):
    value = args.get(key, default)
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f'{key} must be an integer from {minimum} to {maximum}.')
    return value


async def arm(worker, args=None):
    args = args or {}
    if args.get('muteBrowser', False) is not False:
        raise ValueError('Browser playback muting is not supported; capture preserves playback.')
    spec = json.dumps({
        'timesliceMs': _integer(args, 'timesliceMs', 250, 100, 5000),
        'maxChunks': _integer(args, 'maxChunks', 128, 2, 512),
        'maxBytes': _integer(args, 'maxBytes', 8 * 1024 * 1024, 65536, 16 * 1024 * 1024),
    })
    return await worker.evaluate(_ARM.replace('__SPEC__', spec))


async def status(worker, args=None):
    return await worker.evaluate("""(()=>{const s=window.__apiplanAudioOutput;return s?s.status():{armed:false,ambientMicrophone:false};})()""")


async def read(worker, args=None):
    limit = _integer(args or {}, 'maxChunks', 32, 1, 512)
    return await worker.evaluate("""(async()=>{const s=window.__apiplanAudioOutput;if(!s)return {armed:false,chunks:[],ambientMicrophone:false};await s.pending;const chunks=s.queue.splice(0,__LIMIT__);for(const c of chunks)s.bytes-=c.bytes;return {...s.status(),chunks};})()""".replace('__LIMIT__', str(limit)))


async def stop(worker, args=None):
    return await worker.evaluate("""(async()=>{const s=window.__apiplanAudioOutput;if(!s)return {armed:false,stopped:false,chunks:[],ambientMicrophone:false};await s.stop();const result={...s.status(),stopped:true,chunks:s.queue.splice(0)};delete window.__apiplanAudioOutput;return result;})()""")


_ARM = r"""(async()=>{
 if(window.__apiplanAudioOutput)throw new Error('Stop the previous audio output capture first.');
 if(!window.AudioContext||!window.MediaRecorder||!window.AudioNode)throw new Error('Browser Web Audio recording is unavailable.');
 const mime='audio/webm;codecs=opus';
 if(!MediaRecorder.isTypeSupported(mime))throw new Error('Browser cannot record WebM/Opus.');
 const options=__SPEC__,context=new AudioContext();
 const proto=AudioNode.prototype,connect=proto.connect,disconnect=proto.disconnect;
 const rtcProto=window.RTCPeerConnection?.prototype,rtcSetRemote=rtcProto?.setRemoteDescription,rtcObserved=new WeakSet();
 const s={context,queue:[],bytes:0,next:0,pending:Promise.resolve(),tees:[],remotes:[],peers:[],rms:0,peakRms:0,overflow:false,error:null,armed:true,observedConnections:0,observedRemoteTracks:0};
 const destination=context.createMediaStreamDestination(),analyser=context.createAnalyser();
 analyser.fftSize=2048;const samples=new Float32Array(analyser.fftSize);
 s.status=()=>({armed:s.armed,source:'website Web Audio and WebRTC playback',ambientMicrophone:false,mimeType:mime,
   browserPlaybackPreserved:true,preArmConnections:'unobserved',coverage:'Web Audio destination connections and WebRTC remote tracks observed after arm only',
   observedConnections:s.observedConnections,observedRemoteTracks:s.observedRemoteTracks,activeConnections:s.tees.length+s.remotes.length,contextState:context.state,
   recorderState:s.recorder?.state||'inactive',queuedChunks:s.queue.length,queuedBytes:s.bytes,
   nextSequence:s.next,rms:s.rms,peakRms:s.peakRms,audioDetected:s.peakRms>0.0001,overflow:s.overflow,error:s.error});
 const remove=t=>{try{disconnect.call(t.node,t.tap,t.output);}catch{}try{t.mix.disconnect();}catch{}t.tap.stream.getTracks().forEach(track=>track.stop());s.tees=s.tees.filter(x=>x!==t);};
 const removeRemote=remote=>{try{remote.track.removeEventListener?.('ended',remote.onEnded);}catch{}try{remote.source.disconnect();}catch{}s.remotes=s.remotes.filter(item=>item!==remote);};
 s.stop=async()=>{
   s.armed=false;
   if(proto.connect===hookConnect)proto.connect=connect;
   if(proto.disconnect===hookDisconnect)proto.disconnect=disconnect;
   if(rtcProto?.setRemoteDescription===hookSetRemote)rtcProto.setRemoteDescription=rtcSetRemote;
   for(const observed of s.peers){try{observed.peer.removeEventListener('track',observed.onTrack);observed.peer.removeEventListener('connectionstatechange',observed.onState);}catch{}}
   s.peers=[];
   clearInterval(s.meter);
   if(s.recorder&&s.recorder.state!=='inactive'){
     await new Promise(resolve=>{s.recorder.addEventListener('stop',resolve,{once:true});s.recorder.stop();});
   }
   await s.pending;
   for(const t of [...s.tees])remove(t);
   for(const remote of [...s.remotes])removeRemote(remote);
   destination.stream.getTracks().forEach(track=>track.stop());
   await context.close();
 };
 function hookConnect(target,output=0,input=0){
   const result=connect.apply(this,arguments);
   if(s.armed&&this.context!==context&&target===this.context.destination&&!s.tees.some(t=>t.node===this&&t.output===output)){
     let tap,mix;
     try{
       tap=this.context.createMediaStreamDestination();connect.call(this,tap,output,0);
       mix=context.createMediaStreamSource(tap.stream);connect.call(mix,destination);connect.call(mix,analyser);
       s.tees.push({node:this,output,tap,mix});s.observedConnections++;
     }catch(error){
       if(tap){try{disconnect.call(this,tap,output);}catch{}tap.stream.getTracks().forEach(t=>t.stop());}
       try{mix?.disconnect();}catch{}s.error=String(error);
     }
   }
   return result;
 }
 function hookDisconnect(target,output=0,input=0){
   const result=disconnect.apply(this,arguments);
   if(this.context!==context){
     for(const t of [...s.tees])if(t.node===this&&(
       arguments.length===0||(typeof target==='number'&&target===t.output)||
       (target===this.context.destination&&(arguments.length===1||output===t.output))))remove(t);
   }
   return result;
 }
 function observePeer(peer){
   if(rtcObserved.has(peer))return;rtcObserved.add(peer);
   const onTrack=event=>{
     if(!s.armed||['closed','failed'].includes(peer.connectionState)||event.track?.kind!=='audio'||s.remotes.some(remote=>remote.track===event.track))return;
     try{
       const stream=new MediaStream([event.track]),source=context.createMediaStreamSource(stream);
       connect.call(source,destination);connect.call(source,analyser);const remote={peer,track:event.track,source,onEnded:null};remote.onEnded=()=>removeRemote(remote);s.remotes.push(remote);s.observedRemoteTracks++;
       event.track.addEventListener?.('ended',remote.onEnded,{once:true});
     }catch(error){s.error=String(error);}
   },onState=()=>{if(['closed','failed'].includes(peer.connectionState))for(const remote of [...s.remotes])if(remote.peer===peer)removeRemote(remote);};
   peer.addEventListener('track',onTrack);peer.addEventListener('connectionstatechange',onState);s.peers.push({peer,onTrack,onState});
 }
 function hookSetRemote(){observePeer(this);return rtcSetRemote.apply(this,arguments);}
 try{
   await context.resume();
   s.recorder=new MediaRecorder(destination.stream,{mimeType:mime,audioBitsPerSecond:96000});
   s.recorder.ondataavailable=event=>{
     if(!event.data.size)return;
     const sequence=s.next++;
     s.pending=s.pending.then(async()=>{
       if(s.overflow)return;
       if(s.queue.length>=options.maxChunks||s.bytes+event.data.size>options.maxBytes){
         s.overflow=true;s.error='Audio output queue overflow: drain chunks more frequently; recording stopped.';
         if(s.recorder.state!=='inactive')s.recorder.stop();return;
       }
       const bytes=new Uint8Array(await event.data.arrayBuffer());let binary='';
       for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
       s.queue.push({sequence,bytes:bytes.length,base64:btoa(binary),mimeType:mime});s.bytes+=bytes.length;
     }).catch(error=>{s.error=String(error);});
   };
   s.recorder.onerror=event=>{s.error=String(event.error||'MediaRecorder error');};
   s.meter=setInterval(()=>{analyser.getFloatTimeDomainData(samples);let sum=0;for(const sample of samples)sum+=sample*sample;s.rms=Math.sqrt(sum/samples.length);s.peakRms=Math.max(s.peakRms,s.rms);},100);
   s.recorder.start(options.timesliceMs);
   proto.connect=hookConnect;proto.disconnect=hookDisconnect;
   if(rtcProto&&rtcSetRemote)rtcProto.setRemoteDescription=hookSetRemote;
   window.__apiplanAudioOutput=s;
   return s.status();
 }catch(error){await s.stop();throw error;}
})()"""
