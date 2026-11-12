'use strict';
// Synthetic transcripts only — never commit real ~/.claude data.
const test = require('node:test');
const assert = require('node:assert');
const {SessionParser, argOf, notificationsIn, isHumanPrompt} = require('../src/parser');

const T0 = Date.parse('2026-01-01T00:00:00Z');
const ts = s => new Date(T0 + s * 1000).toISOString();
const user = (s, content, extra = {}) => ({type:'user', timestamp:ts(s), message:{role:'user', content}, ...extra});
const asst = (s, content, extra = {}) => ({type:'assistant', timestamp:ts(s),
  message:{id:'msg' + s, model:'claude-test', role:'assistant', content, stop_reason:extra.stop || null, usage:{input_tokens:10, output_tokens:5}}});
const evs = (list, ev) => list.filter(e => e.ev === ev);

test('main conversation: start, turn, tool, idle', () => {
  const p = new SessionParser();
  const out = [
    ...p.feed('main', user(0, 'add login tests')),
    ...p.feed('main', asst(1, [{type:'tool_use', id:'t1', name:'Read', input:{file_path:'C:\\repo\\src\\app.ts'}}], {stop:'tool_use'})),
    ...p.feed('main', user(2, [{type:'tool_result', tool_use_id:'t1', content:'...'}])),
    ...p.feed('main', asst(3, [{type:'text', text:'Done: added 3 tests.'}], {stop:'end_turn'})),
    ...p.feed('main', asst(3, [{type:'text', text:'Done: added 3 tests.'}], {stop:'end_turn'})),   // split message line
  ];
  assert.equal(evs(out, 'start')[0].id, 'main');
  assert.equal(evs(out, 'turn')[0].text, 'add login tests');
  assert.deepEqual(evs(out, 'tool')[0], {t:1, ev:'tool', id:'main', name:'Read', arg:'src/app.ts'});
  assert.equal(evs(out, 'idle').length, 1, 'idle emitted once');
  assert.match(evs(out, 'idle')[0].result, /added 3 tests/);
});

test('sync subagent: spawn, wait on children, result ends it and resumes parent', () => {
  const p = new SessionParser();
  const out = [
    ...p.feed('main', user(0, 'go')),
    ...p.feed('main', asst(1, [{type:'tool_use', id:'toolu_A', name:'Agent', input:{description:'find auth code', subagent_type:'Explore', prompt:'Find auth.'}}])),
    ...p.feed('toolu_A', user(1.1, 'Find auth.'), {agentType:'Explore', description:'find auth code'}),
    ...p.feed('toolu_A', asst(2, [{type:'tool_use', id:'t2', name:'Grep', input:{pattern:'login'}}])),
    ...p.feed('main', user(5, [{type:'tool_result', tool_use_id:'toolu_A', content:[{type:'text', text:'Found 5 files'}]}],
      {toolUseResult:{agentId:'a1', status:'completed'}})),
  ];
  const start = evs(out, 'start').find(e => e.id === 'toolu_A');
  assert.equal(start.parent, 'main');
  assert.equal(start.type, 'Explore');
  assert.equal(start.prompt, 'Find auth.');
  assert.ok(evs(out, 'wait').some(e => e.id === 'main' && e.on === 'children'));
  assert.ok(evs(out, 'tool').some(e => e.id === 'toolu_A' && e.name === 'Grep'));
  assert.deepEqual(evs(out, 'end').map(e => [e.id, e.status, e.result]), [['toolu_A', 'done', 'Found 5 files']]);
  assert.ok(evs(out, 'resume').some(e => e.id === 'main'));
  assert.equal(evs(out, 'start').length, 2, 'no duplicate start when the subagent file is read');
});

test('async subagent: launched result resumes parent, task-notification ends child once', () => {
  const p = new SessionParser();
  const note = '<task-notification><task-id>a9</task-id><tool-use-id>toolu_B</tool-use-id><status>completed</status>' +
               '<summary>Agent "x" completed</summary><result>All good</result></task-notification>';
  const out = [
    ...p.feed('main', asst(0, [{type:'tool_use', id:'toolu_B', name:'Agent', input:{description:'x', prompt:'p'}}])),
    ...p.feed('main', user(0.2, [{type:'tool_result', tool_use_id:'toolu_B', content:[{type:'text', text:'launched'}]}],
      {toolUseResult:{agentId:'a9', status:'async_launched', isAsync:true}})),
    ...p.feed('main', {type:'queue-operation', operation:'enqueue', timestamp:ts(9), content:note}),
    ...p.feed('main', user(9.1, note)),
  ];
  assert.equal(p.ownerFor('a9', null), 'toolu_B', 'agentId mapped to node');
  assert.ok(evs(out, 'resume').some(e => e.id === 'main'));
  const ends = evs(out, 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].result, 'All good');
  assert.equal(evs(out, 'turn').length, 0, 'notifications are not human prompts');
});

test('SubagentHandback ends the subagent', () => {
  const p = new SessionParser();
  p.feed('main', asst(0, [{type:'tool_use', id:'toolu_C', name:'Agent', input:{description:'c', prompt:'q'}}]));
  const out = p.feed('toolu_C', asst(3, [{type:'tool_use', id:'h', name:'SubagentHandback', input:{message:'report text'}}]));
  assert.deepEqual(evs(out, 'end').map(e => [e.id, e.result]), [['toolu_C', 'report text']]);
});

test('subagent transcript without meta.json links by prompt', () => {
  const p = new SessionParser();
  p.feed('main', asst(0, [{type:'tool_use', id:'toolu_D', name:'Agent', input:{description:'d', prompt:'Scan src/db'}}]));
  const owner = p.ownerFor('zzz', null);
  const out = [...p.feed(owner, user(0.5, 'Scan src/db')), ...p.feed(owner, asst(1, [{type:'tool_use', id:'t', name:'Read', input:{file_path:'a/b.ts'}}]))];
  assert.equal(evs(out, 'start').length, 0);
  assert.equal(evs(out, 'tool')[0].id, 'toolu_D');
});

test('pending permission-gated tool becomes inferred approval wait, result resumes with note', () => {
  const p = new SessionParser({approvalAfterMs:5000});
  p.feed('main', asst(0, [{type:'tool_use', id:'b1', name:'Bash', input:{command:'npm test'}}]));
  assert.equal(p.tick(T0 + 2000).length, 0);
  const w = p.tick(T0 + 6000);
  assert.deepEqual(w.map(e => [e.ev, e.on, e.inferred, e.reason]), [['wait', 'user', true, 'Bash npm test']]);
  assert.equal(p.tick(T0 + 7000).length, 0, 'asked once');
  const out = p.feed('main', user(8, [{type:'tool_result', tool_use_id:'b1', content:'ok'}], {permissionDecision:{decision:'accept', source:'user_temporary'}}));
  assert.deepEqual(evs(out, 'resume').map(e => e.note), ['approved by user']);
});

test('titles: custom title wins over ai title', () => {
  const p = new SessionParser();
  p.feed('main', user(0, 'hi'));
  const a = p.feed('main', {type:'ai-title', aiTitle:'AI name'});
  const c = p.feed('main', {type:'custom-title', customTitle:'My name'});
  const a2 = p.feed('main', {type:'ai-title', aiTitle:'Other AI name'});
  assert.equal(a[0].desc, 'AI name');
  assert.equal(c[0].desc, 'My name');
  assert.equal(a2.length, 0);
});

test('helpers', () => {
  assert.equal(argOf('Bash', {command:'git   status\n'}), 'git status');
  assert.equal(argOf('Grep', {pattern:'foo'}), '"foo"');
  assert.equal(notificationsIn('nothing').length, 0);
  assert.equal(isHumanPrompt(user(0, '<system-reminder>x</system-reminder>')), false);
  assert.equal(isHumanPrompt(user(0, [{type:'text', text:'real prompt'}])), true);
  assert.equal(isHumanPrompt(user(0, 'x', {isMeta:true})), false);
});
