import {expect,test} from 'bun:test';
import {recentFirst} from './tui-nav.ts';
test('conversation ordering normalizes seconds, milliseconds and ISO dates',()=>{
 expect(recentFirst([{id:'old',update_time:10},{id:'iso',updated_at:'2026-09-15T12:00:00Z'},{id:'new',update_time:2000000000},{id:'missing'},{id:'missing2'}]).map(item=>item.id)).toEqual(['new','iso','old','missing','missing2']);
});

test('local observation timestamps order locally created conversations without pretending to be server timestamps',()=>{expect(recentFirst([{id:'old',update_time:'2024-01-01T00:00:00Z'},{id:'new-local',localObservation:{seenAt:'2026-09-15T12:00:00Z'}}]).map(row=>row.id)).toEqual(['new-local','old']);});
