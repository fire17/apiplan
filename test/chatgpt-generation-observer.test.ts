import {expect,test} from 'bun:test';
import {join} from 'node:path';
test('passive generation receipts require exact observed request and explicit finished assistant content',()=>{
 const source=join(import.meta.dir,'../src/chatgpt/generation_observer.py');
 const probe=`import runpy,sys,asyncio,types,json,tempfile,pathlib
module=runpy.run_path(sys.argv[1]);parse=module['parse_generation_sse'];Observer=module['GenerationObserver']
def body(status='finished_successfully',done=True):
 packet={'conversation_id':'conversation-fixture','message':{'id':'assistant-id','author':{'role':'assistant'},'status':status,'content':{'content_type':'text','parts':['private fixture answer']}}}
 return 'data: '+json.dumps(packet)+'\\n\\n'+('data: [DONE]\\n\\n' if done else '')
assert parse(body())['authoritative']
modern='data: '+json.dumps({'v':{'conversation_id':'conversation-fixture','message':{'id':'modern','author':{'role':'assistant'},'channel':'final','status':'in_progress','content':{'content_type':'text','parts':['']}}},'c':0})+'\\n\\n'+'data: '+json.dumps({'o':'patch','v':[{'p':'/message/content/parts/0','o':'append','v':'modern result'},{'p':'/message/status','o':'replace','v':'finished_successfully'}]})+'\\n\\n'
assert parse(modern)['authoritative'] and parse(modern)['messages'][0]['text']=='modern result'
assert not parse(modern.replace('finished_successfully','in_progress'))['authoritative']
compressed_packets=[{'v':{'conversation_id':'conversation-fixture','message':{'id':'compressed','author':{'role':'assistant'},'channel':'final','status':'in_progress','content':{'content_type':'text','parts':['']}}}}, {'p':'/message/content/parts/0','o':'append','v':'a'*29}, {'v':'b'*14}, {'v':'c'*22}, {'v':'d'*78}, {'p':'','o':'patch','v':[{'p':'/message/status','o':'replace','v':'finished_successfully'}]}]
def stream(packets): return ''.join('data: '+json.dumps(packet)+'\\n\\n' for packet in packets)
compressed=parse(stream(compressed_packets))
assert compressed['authoritative'] and compressed['messages'][0]['text']=='a'*29+'b'*14+'c'*22+'d'*78
assert len(compressed['messages'][0]['text'])==143
assert not parse(stream(compressed_packets)+'event: error\\ndata: {}\\n\\n')['authoritative']
assert parse(stream(compressed_packets)+'event: error\\ndata: {}\\n\\n')['streamError']
for nonobject in [[], None, 'unexpected', 42, False]:
 assert not parse(stream(compressed_packets+[nonobject]))['authoritative']

for unsupported in [{'p':'/message/status','o':'remove'}, {'p':'/message/channel','o':'replace','v':'analysis'}, {'p':'/message','o':'replace','v':{}}, {'p':'','o':'patch','v':[42]}]:
 assert not parse(stream(compressed_packets+[unsupported]))['authoritative']
multipart=json.loads(json.dumps(compressed_packets));multipart[0]['v']['message']['content']['parts']=['first','second']
assert not parse(stream(multipart))['authoritative']

assert not parse(stream([compressed_packets[0], {'v':'unanchored'}, compressed_packets[-1]]))['authoritative']
assert not parse(stream(compressed_packets+[{'v':'after-status-without-append'}]))['authoritative']
assert not parse(stream(compressed_packets[:2]+[{'v':'wrong-channel','c':99}]+compressed_packets[-1:]))['authoritative']
assert not parse(stream(compressed_packets[:2]+[{'p':'/message/content/parts/1','o':'append','v':'unsupported'}]+compressed_packets[-1:]))['authoritative']



assert not parse(body('in_progress'))['authoritative']
assert not parse('data: [DONE]\\n\\n')['authoritative']
assert not parse('data: {}\\n\\n')['authoritative']
assert not parse(body()+'data: {\"error\":{\"code\":\"test\"}}\\n\\n')['authoritative']
class Id:
 def __init__(self,value):self.value=value
 def to_json(self):return self.value
class Tab:
 def __init__(self):self.handlers={};self.reads=[];self.body=body()
 def add_handler(self,event,handler):self.handlers.setdefault(event,[]).append(handler)
 async def send(self,command):self.reads.append(command);return self.body,False
cdp=types.SimpleNamespace(network=types.SimpleNamespace(RequestWillBeSent='request',ResponseReceived='response',LoadingFinished='finished',LoadingFailed='failed',get_response_body=lambda id:('body',id.to_json())))
async def main():
 with tempfile.TemporaryDirectory() as directory:
  tab=Tab();observer=Observer(tab,cdp,directory)
  await observer.finished(types.SimpleNamespace(request_id=Id('unobserved')));assert tab.reads==[]
  request=types.SimpleNamespace(url='https://chatgpt.com/backend-api/f/conversation',method='POST',post_data=json.dumps({'messages':[{'id':'user-id','author':{'role':'user'},'content':{'parts':['private prompt']}}]}))
  await observer.request(types.SimpleNamespace(request_id=Id('generation'),request=request))
  await observer.response(types.SimpleNamespace(request_id=Id('generation'),response=types.SimpleNamespace(status=200,mime_type='text/event-stream')))
  assert not observer.receipt(['user-id'])['authoritative']
  await observer.finished(types.SimpleNamespace(request_id=Id('generation')))
  receipt=observer.receipt(['user-id']);assert receipt['authoritative'] and receipt['text']=='private fixture answer' and receipt['additionalRequests']==0
  assert tab.reads==[('body','generation')]
  assert not observer.receipt(['wrong-user'])['authoritative']
  assert not observer.receipt(['user-id'],'wrong-conversation')['authoritative']
  assert not observer.receipt(['user-id'],after=observer.sequence)['authoritative']
  assert not observer.receipt([])['authoritative']
  metadata=''.join(path.read_text() for path in pathlib.Path(directory).glob('*.json'));assert 'private fixture answer' not in metadata and 'private prompt' not in metadata and 'post_data' not in metadata
  assert all(path.stat().st_mode&0o777==0o600 for path in pathlib.Path(directory).glob('*.json'))
  observer.close();assert all(not handlers for handlers in tab.handlers.values())
asyncio.run(main())`;
 const result=Bun.spawnSync(['python3','-c',probe,source],{stderr:'pipe'});expect(new TextDecoder().decode(result.stderr)).toBe('');expect(result.exitCode).toBe(0);
});
