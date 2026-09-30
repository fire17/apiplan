"""Feed an explicit local audio fixture into the website's next microphone stream."""
import base64
import json
import mimetypes
from pathlib import Path
from nodriver import cdp

async def capture(worker):
    tab=worker.tab
    if getattr(worker,'audio_capture',None):
        raise ValueError('Clear the previous audio capture first.')
    state={'tab':tab,'receipt':None}
    async def response(event):
        try:
            body,encoded=await tab.send(cdp.fetch.get_response_body(event.request_id))
            if encoded:body=base64.b64decode(body).decode('utf-8')
            if len(body)>1024*1024:raise ValueError('Transcription receipt exceeded its limit.')
            state['receipt']={'status':event.response_status_code,'body':json.loads(body)}
        except Exception:
            state['receipt']={'status':event.response_status_code,'error':'Transcription receipt was unavailable.'}
        finally:
            await tab.send(cdp.fetch.continue_response(event.request_id))
    state['handler']=response
    worker.audio_capture=state
    tab.add_handler(cdp.fetch.RequestPaused,response)
    await tab.send(cdp.fetch.enable(patterns=[cdp.fetch.RequestPattern(url_pattern='https://chatgpt.com/backend-api/transcribe',request_stage=cdp.fetch.RequestStage.RESPONSE)]))

async def prepare(worker, args):
    if not isinstance(args.get('path'),str) or not args['path'].strip():
        raise ValueError('Audio input requires an explicit local file path.')
    path = Path(args['path']).expanduser().resolve(strict=True)
    if not path.is_file():
        raise ValueError('Audio input path must be a regular file.')
    mime = mimetypes.guess_type(str(path))[0]
    if mime not in ('audio/wav','audio/x-wav','audio/mpeg','audio/mp4','audio/ogg','audio/webm','audio/aiff','audio/x-aiff'):
        raise ValueError('Audio input requires a WAV, MP3, M4A, Ogg, WebM or AIFF file.')
    if not 0 < path.stat().st_size <= 16*1024*1024:
        raise ValueError('Audio input files must be nonempty and at most 16 MiB.')
    spec = json.dumps({'mime':mime,'base64':base64.b64encode(path.read_bytes()).decode()})
    result=await worker.evaluate("""(async()=>{
      if(window.__apiplanAudioInput)throw new Error('Clear the previous audio input first.');
      const a=SPEC,bytes=Uint8Array.from(atob(a.base64),c=>c.charCodeAt(0));
      const context=new AudioContext();let buffer;try{buffer=await context.decodeAudioData(bytes.buffer);}catch(error){await context.close();throw new Error('Browser could not decode this audio file. Convert it to PCM WAV or MP3 and retry.');}
      const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const state={context,original,buffer,used:false,source:null,stream:null};
      navigator.mediaDevices.getUserMedia=async constraints=>{
        const state=window.__apiplanAudioInput;if(!state)return original(constraints);
        if(!constraints?.audio||constraints.video)return original(constraints);
        if(state.used)throw new Error('The explicit audio input has already been consumed.');
        state.used=true;await context.resume();
        const source=context.createBufferSource(),destination=context.createMediaStreamDestination();
        source.buffer=buffer;source.connect(destination);state.source=source;source.onended=()=>{state.ended=true;};state.stream=destination.stream;
        state.analyser=context.createAnalyser();source.connect(state.analyser);state.peak=0;
        state.meter=setInterval(()=>{const samples=new Float32Array(state.analyser.fftSize);state.analyser.getFloatTimeDomainData(samples);for(const value of samples)state.peak=Math.max(state.peak,Math.abs(value));},100);
        return destination.stream;
      };
      window.__apiplanAudioInput=state;
      return {prepared:true,duration:buffer.duration,channels:buffer.numberOfChannels,sampleRate:buffer.sampleRate,source:'explicit local audio file',ambientMicrophone:false,requiresPlay:true};
    })()""".replace('SPEC',spec))
    try:
        await capture(worker)
    except Exception:
        try:await clear(worker)
        except Exception:pass
        raise
    return result

async def clear(worker):
    capture_state=getattr(worker,'audio_capture',None)
    if capture_state:
        tab=capture_state['tab']
        try:await tab.send(cdp.fetch.disable())
        except Exception:pass
        handlers=getattr(tab,'handlers',{}).get(cdp.fetch.RequestPaused,[])
        if capture_state['handler'] in handlers:handlers.remove(capture_state['handler'])
        worker.audio_capture=None
    return await worker.evaluate("""(async()=>{const s=window.__apiplanAudioInput;if(!s)return {cleared:false};navigator.mediaDevices.getUserMedia=s.original;clearInterval(s.meter);try{s.source?.stop();}catch{}s.stream?.getTracks().forEach(t=>t.stop());await s.context.close();delete window.__apiplanAudioInput;return {cleared:true};})()""")

async def status(worker):
    result=await worker.evaluate("""(()=>{const s=window.__apiplanAudioInput;return s?{prepared:true,used:s.used,duration:s.buffer.duration,contextState:s.context.state,elapsed:s.context.currentTime,peak:s.peak||0,playing:!!s.playing&&!s.ended,ended:!!s.ended,tracks:s.stream?.getTracks().map(t=>({kind:t.kind,readyState:t.readyState}))||[]}:{prepared:false};})()""")
    result['transcription']=(getattr(worker,'audio_capture',None) or {}).get('receipt')
    return result

async def play(worker):
    return await worker.evaluate("""(async()=>{const s=window.__apiplanAudioInput;if(!s?.used||!s.source)throw new Error('Start website dictation or voice before playing the audio file.');if(s.playing)throw new Error('Audio file was already played; prepare a new explicit input to replay.');await s.context.resume();s.source.start(s.context.currentTime+.1);s.playing=true;return {playing:true,duration:s.buffer.duration,ambientMicrophone:false};})()""")

async def outputs(worker):
    return await worker.evaluate("""(()=>[...document.querySelectorAll('audio,video')].map((e,index)=>({index,tag:e.tagName,paused:e.paused,readyState:e.readyState,currentTime:e.currentTime,muted:e.muted,volume:e.volume,stream:!!e.srcObject,canCapture:typeof e.captureStream==='function',tracks:e.srcObject?.getTracks?.().map(t=>({kind:t.kind,readyState:t.readyState}))||[]})))()""")
