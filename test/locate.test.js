'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {encodeCwd, toWslPath, candidateNames, findProjectDir, listSessions} = require('../src/locate');

test('Windows workspace maps to the WSL folder name too', () => {
  assert.equal(toWslPath('e:\\DCEL\\agent-process-tracker'), '/mnt/e/DCEL/agent-process-tracker');
  assert.equal(toWslPath('C:\\'), '/mnt/c');
  assert.equal(toWslPath('/home/me/x'), null);
  assert.deepEqual(candidateNames('E:\\DCEL\\agent-process-tracker'),
    ['e--dcel-agent-process-tracker', '-mnt-e-dcel-agent-process-tracker']);
});

test('finds a WSL-style transcript folder for a Windows workspace', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const dir = path.join(cfg, 'projects', '-mnt-e-DCEL-agent-process-tracker');
  fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir, 's.jsonl'), '{}\n');
  assert.equal(await findProjectDir('e:\\DCEL\\agent-process-tracker', cfg), dir);
  fs.rmSync(cfg, {recursive:true, force:true});
});

test('encodeCwd matches Claude Code folder naming', () => {
  assert.equal(encodeCwd('e:\\DCEL\\agent-process-tracker'), 'e--DCEL-agent-process-tracker');
  assert.equal(encodeCwd('/home/me/my.app'), '-home-me-my-app');
});

test('findProjectDir + listSessions on a temp config dir', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-'));
  const ws = path.join(cfg, 'work', 'proj');
  const dir = path.join(cfg, 'projects', encodeCwd(ws));
  fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir, 'old.jsonl'), JSON.stringify({type:'ai-title', aiTitle:'Old one', sessionId:'old'}) + '\n');
  const later = Date.now() / 1000 + 5;
  fs.writeFileSync(path.join(dir, 'new.jsonl'), JSON.stringify({type:'custom-title', customTitle:'New one', sessionId:'new'}) + '\n');
  fs.utimesSync(path.join(dir, 'new.jsonl'), later, later);

  assert.equal(await findProjectDir(ws, cfg), dir);
  assert.equal(await findProjectDir(ws.toUpperCase(), cfg), dir, 'case-insensitive');
  const s = await listSessions(dir);
  assert.deepEqual(s.map(x => [x.id, x.title]), [['new', 'New one'], ['old', 'Old one']]);
  fs.rmSync(cfg, {recursive:true, force:true});
});
