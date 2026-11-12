'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const {SessionParser, MAIN} = require('./parser');

/**
 * Follows one session: the main transcript plus every subagent transcript under
 * <session>/subagents/. Polls (robust on Windows/network drives), reads only new
 * bytes, merges lines from all files by timestamp, and emits parser events.
 */
class SessionTail {
  /**
   * @param {string} projectDir
   * @param {string} sessionId
   * @param {(events: object[], info: {replay: boolean}) => void} onEvents
   */
  constructor(projectDir, sessionId, onEvents, opts = {}){
    this.dir = projectDir;
    this.id = sessionId;
    this.onEvents = onEvents;
    this.interval = opts.interval ?? 700;
    this.parser = new SessionParser({approvalAfterMs:opts.approvalAfterMs});
    this.files = new Map();   // path -> {offset, rest, owner, agentId, meta, lastTs}
    this.timer = null;
    this.busy = false;
    this.lastEventMs = 0;
    this.started = false;
  }

  get mainFile(){ return path.join(this.dir, this.id + '.jsonl'); }
  get subDir(){ return path.join(this.dir, this.id, 'subagents'); }
  get epochMs(){ return this.parser.epoch; }

  async start(){
    await this.poll(true);
    this.started = true;
    this.timer = setInterval(() => this.poll(false), this.interval);
  }
  stop(){ clearInterval(this.timer); this.timer = null; }

  async discover(){
    if (!this.files.has(this.mainFile)) this.files.set(this.mainFile, {offset:0, rest:'', owner:MAIN});
    let names = [];
    try { names = await fsp.readdir(this.subDir); } catch { return; }
    for (const n of names){
      const m = n.match(/^agent-(.+)\.jsonl$/);
      if (!m) continue;
      const file = path.join(this.subDir, n);
      if (this.files.has(file)) continue;
      this.files.set(file, {offset:0, rest:'', agentId:m[1], meta:null, owner:null});
    }
  }

  async loadMeta(f, file){
    if (f.meta) return;
    try {
      f.meta = JSON.parse(await fsp.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    } catch { f.meta = null; }
  }

  async readNew(file, f){
    let st;
    try { st = await fsp.stat(file); } catch { return []; }
    if (st.size < f.offset){ f.offset = 0; f.rest = ''; }       // truncated/rewritten
    if (st.size === f.offset) return [];
    const fh = await fsp.open(file, 'r');
    let chunk;
    try {
      const buf = Buffer.alloc(st.size - f.offset);
      const {bytesRead} = await fh.read(buf, 0, buf.length, f.offset);
      f.offset += bytesRead;
      chunk = buf.toString('utf8', 0, bytesRead);
    } finally { await fh.close(); }
    const text = f.rest + chunk;
    const lines = text.split('\n');
    f.rest = lines.pop();                                       // keep a partial last line
    const out = [];
    for (const line of lines){
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.timestamp) f.lastTs = Date.parse(j.timestamp);
      out.push({j, ts:f.lastTs ?? 0});
    }
    return out;
  }

  async poll(replay){
    if (this.busy) return;
    this.busy = true;
    try {
      await this.discover();
      const batch = [];
      let order = 0;
      for (const [file, f] of this.files){
        const isMain = file === this.mainFile;
        if (!isMain){
          await this.loadMeta(f, file);
          // meta.json links the transcript to its parent's Agent call; give it a moment to appear
          if (!f.meta && !this.parser.agentIds.has(f.agentId)){
            f.waitSince ??= Date.now();
            if (!replay && Date.now() - f.waitSince < 3000) continue;
          }
        }
        for (const r of await this.readNew(file, f)) batch.push({...r, f, isMain, order:order++});
      }
      // chronological merge; main transcript first on ties so parents exist before children
      batch.sort((a, b) => (a.ts - b.ts) || (b.isMain - a.isMain) || (a.order - b.order));
      const events = [];
      for (const r of batch){
        let owner = MAIN;
        if (!r.isMain){
          owner = r.f.owner || this.parser.ownerFor(r.f.agentId, r.f.meta);
          if (r.f.meta || this.parser.agentIds.has(r.f.agentId)) r.f.owner = owner;   // cache only a confirmed link
        }
        events.push(...this.parser.feed(owner, r.j, r.f.meta));
      }
      events.push(...this.parser.tick(Date.now()));
      if (events.length){
        this.lastEventMs = Date.now();
        this.onEvents(events, {replay});
      } else if (replay){
        this.onEvents([], {replay});
      }
    } catch (err){
      console.error('[agent-tracker] poll failed', err);
    } finally {
      this.busy = false;
    }
  }
}

module.exports = {SessionTail};
