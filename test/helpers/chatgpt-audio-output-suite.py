import asyncio
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'chatgpt'))
import audio_output


class Worker:
    def __init__(self):
        self.scripts = []

    async def evaluate(self, script):
        self.scripts.append(script)
        return {'ok': True}


class AudioOutputTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_limits_never_touch_browser(self):
        worker = Worker()
        for args in ({'maxBytes': 1}, {'maxChunks': True}, {'timesliceMs': 99}, {'muteBrowser': True}):
            with self.assertRaises(ValueError):
                await audio_output.arm(worker, args)
        with self.assertRaises(ValueError):
            await audio_output.read(worker, {'maxChunks': 0})
        self.assertEqual(worker.scripts, [])

    async def test_browser_graph_recording_and_cleanup_with_simulated_audio(self):
        worker = Worker()
        await audio_output.arm(worker, {'maxChunks': 2})
        arm = worker.scripts[-1]
        await audio_output.read(worker)
        read = worker.scripts[-1]
        await audio_output.stop(worker)
        stop = worker.scripts[-1]
        program = r'''
const assert=require('node:assert/strict');
global.window=global;let timer;
global.setInterval=fn=>{timer=fn;return 1};global.clearInterval=()=>{timer=null};
class AudioNode {
 constructor(context){this.context=context;this.edges=[];}
 connect(target,output=0){this.edges.push({target,output});return target;}
 disconnect(target,output){this.edges=this.edges.filter(e=>arguments.length&&!(typeof target==='number'?e.output===target:e.target===target&&(output===undefined||e.output===output)));}
}
class AudioContext {
 constructor(){this.state='suspended';this.destination=new AudioNode(this);this.nodes=[];}
 createMediaStreamDestination(){const n=new AudioNode(this);const track={stop(){this.stopped=true;}};n.stream={getTracks:()=>[track]};this.nodes.push(n);return n;}
 createMediaStreamSource(){const n=new AudioNode(this);this.nodes.push(n);return n;}
 createAnalyser(){const n=new AudioNode(this);n.getFloatTimeDomainData=samples=>samples.fill(.25);return n;}
 async resume(){this.state='running';} async close(){this.state='closed';}
}
class MediaRecorder extends EventTarget {
 static isTypeSupported(){return true;}
 constructor(){super();this.state='inactive';}
 start(){if(MediaRecorder.failStart)throw new Error('recorder start failed');this.state='recording';}
 emit(data){this.ondataavailable({data:new Blob([data])});}
 stop(){this.state='inactive';this.emit('tail');this.dispatchEvent(new Event('stop'));}
}
class RTCPeerConnection extends EventTarget {constructor(){super();this.connectionState='new';}async setRemoteDescription(){return true;}close(){this.connectionState='closed';this.dispatchEvent(new Event('connectionstatechange'));}}
class MediaStream {constructor(tracks){this.tracks=tracks;}getTracks(){return this.tracks;}}
Object.assign(global,{AudioNode,AudioContext,MediaRecorder,RTCPeerConnection,MediaStream});
(async()=>{
const originalConnect=AudioNode.prototype.connect, originalDisconnect=AudioNode.prototype.disconnect,originalSetRemote=RTCPeerConnection.prototype.setRemoteDescription;
const page=new AudioContext(),old=new AudioNode(page);old.connect(page.destination);
const armed=await eval(ARM);
assert.equal(armed.observedConnections,0);assert.equal(armed.preArmConnections,'unobserved');
assert.equal(armed.ambientMicrophone,false);
assert.equal(armed.source,'website Web Audio and WebRTC playback');assert.match(armed.coverage,/WebRTC remote tracks/);
const source=new AudioNode(page);source.connect(page.destination);
const state=window.__apiplanAudioOutput;
assert.equal(state.tees.length,1);assert.equal(source.edges.length,2);
source.connect(page.destination);assert.equal(state.tees.length,1);assert.equal(source.edges.length,3);
assert.equal(state.context.nodes.filter(n=>n.edges.length).length,1);
timer();assert.equal(state.status().audioDetected,true);
const peer=new RTCPeerConnection();await peer.setRemoteDescription({});const remoteTrack=new EventTarget();remoteTrack.kind='audio';remoteTrack.stop=()=>{remoteTrack.stopped=true;};const trackEvent=new Event('track');trackEvent.track=remoteTrack;trackEvent.streams=[{getTracks:()=>[remoteTrack]}];peer.dispatchEvent(trackEvent);peer.dispatchEvent(trackEvent);
assert.equal(state.status().observedRemoteTracks,1);assert.equal(state.remotes.length,1);
const secondTrack=new EventTarget();secondTrack.kind='audio';secondTrack.stop=()=>{secondTrack.stopped=true;};const secondEvent=new Event('track');secondEvent.track=secondTrack;secondEvent.streams=[{getTracks:()=>[secondTrack]}];peer.dispatchEvent(secondEvent);assert.equal(state.remotes.length,2);assert.equal(state.status().observedRemoteTracks,2);
peer.close();assert.equal(state.remotes.length,0);assert.equal(remoteTrack.stopped,undefined);assert.equal(secondTrack.stopped,undefined);
state.recorder.emit('header');state.recorder.emit('body');await state.pending;
const batch=await eval(READ);assert.deepEqual(batch.chunks.map(c=>c.sequence),[0,1]);
assert.equal(Buffer.from(batch.chunks[0].base64,'base64').toString(),'header');
assert.equal(state.bytes,0);
source.disconnect(page.destination);assert.equal(state.tees.length,0);assert.equal(source.edges.length,0);
source.connect(page.destination);
const ended=await eval(STOP);assert.equal(ended.chunks.length,1);
assert.equal(source.edges.length,1);assert.equal(source.edges[0].target,page.destination);
assert.equal(AudioNode.prototype.connect,originalConnect);assert.equal(AudioNode.prototype.disconnect,originalDisconnect);
assert.equal(RTCPeerConnection.prototype.setRemoteDescription,originalSetRemote);assert.equal(state.remotes.length,0);
assert.equal(state.peers.length,0);peer.dispatchEvent(trackEvent);assert.equal(state.remotes.length,0);
assert.equal(state.context.state,'closed');assert.equal(timer,null);assert.equal(window.__apiplanAudioOutput,undefined);
MediaRecorder.failStart=true;await assert.rejects(async()=>eval(ARM),/recorder start failed/);MediaRecorder.failStart=false;
assert.equal(AudioNode.prototype.connect,originalConnect);assert.equal(AudioNode.prototype.disconnect,originalDisconnect);assert.equal(RTCPeerConnection.prototype.setRemoteDescription,originalSetRemote);assert.equal(window.__apiplanAudioOutput,undefined);
await eval(ARM);const overflow=window.__apiplanAudioOutput;
for(let i=0;i<5;i++)overflow.recorder.emit('chunk');await overflow.pending;await overflow.pending;
assert.equal(overflow.status().overflow,true);assert.equal(overflow.queue.length,2);assert.equal(overflow.queue[0].sequence,0);
assert.equal(overflow.recorder.state,'inactive');await eval(STOP);
console.log('OK');
})().catch(error=>{console.error(error);process.exitCode=1});
'''
        program = 'const ARM=' + json.dumps(arm) + ',READ=' + json.dumps(read) + ',STOP=' + json.dumps(stop) + ';\n' + program
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Node is required for browser graph simulation')
        result = subprocess.run([node, '-e', program], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('OK', result.stdout)


if __name__ == '__main__':
    unittest.main()
