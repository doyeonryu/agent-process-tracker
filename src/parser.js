'use strict';
/**
 * Turns Claude Code transcript lines (JSONL objects) into the tracker's event stream.
 *
 * Event shapes (t = seconds since the session's first timestamp):
 *   {ev:'start',  id, parent?, type, desc, prompt, model?}
 *   {ev:'tool',   id, name, arg}
 *   {ev:'wait',   id, on:'children'|'user'|<id>, reason?, inferred?}
 *   {ev:'resume', id, note?}
 *   {ev:'end',    id, status:'done'|'error', summary, result}
 *   {ev:'send',   from, to, text}
 *   {ev:'turn',   id:'main', text}             new user prompt for the main conversation
 *   {ev:'idle',   id:'main', summary, result}  main conversation finished its turn
 *   {ev:'title',  id:'main', desc}
 *   {ev:'meta',   id, model?, tok?}
 *   {ev:'act',    id}                          activity heartbeat (updates "last active")
 *
 * The parser is pure: feed it lines, get events back. No I/O here.
 */

const MAIN = 'main';
const APPROVAL_TOOLS = new Set(['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);

const one = (s, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const clip = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = p => String(p ?? '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');

function argOf(name, i = {}){
  switch (name){
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return base(i.file_path);
    case 'NotebookEdit': return base(i.notebook_path);
    case 'Bash': case 'PowerShell': return one(i.command);
    case 'Grep': return `"${one(i.pattern, 60)}"`;
    case 'Glob': return one(i.pattern);
    case 'WebFetch': return one(i.url);
    case 'WebSearch': case 'ToolSearch': return one(i.query);
    case 'Skill': return one(i.skill);
    default: {
      const v = Object.values(i).find(v => typeof v === 'string');
      return v ? one(v) : '';
    }
  }
}

function textOf(content){
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  return '';
}

const tag = (s, name) => {
  const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : '';
};
function notificationsIn(s){
  if (typeof s !== 'string' || !s.includes('<task-notification>')) return [];
  return [...s.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map(m => ({
    toolUseId: tag(m[1], 'tool-use-id'),
    status: tag(m[1], 'status'),
    summary: tag(m[1], 'summary'),
    result: tag(m[1], 'result'),
  })).filter(n => n.toolUseId);
}

// user-typed prompt vs. harness-injected text
function isHumanPrompt(j){
  if (j.isMeta || j.isCompactSummary || j.isVisibleInTranscriptOnly) return false;
  const c = j.message && j.message.content;
  if (Array.isArray(c) && c.some(b => b && b.type === 'tool_result')) return false;
  const t = textOf(c).trim();
  if (!t) return false;
  return !/^<(task-notification|command-|local-command|system-reminder|bash-|user-memory)/.test(t);
}

class SessionParser {
  constructor(opts = {}){
    this.approvalAfterMs = opts.approvalAfterMs ?? 8000;
    this.epoch = null;
    this.nodes = new Map();       // id -> {parent, model, lastText, lastActT}
    this.pending = new Map();     // tool_use id -> {owner, kind, name, arg, ms, asked}
    this.agentIds = new Map();    // agentId -> node id (tool_use id)
    this.ended = new Set();
    this.seenMsg = new Set();
    this.title = null; this.customTitle = false;
    this.lastT = 0;
    this.prompts = new Map();     // Agent tool_use id -> prompt (links transcripts that have no meta.json)
    this.alias = new Map();       // provisional owner id -> real node id
    this.mainIdle = false;
  }

  /** seconds since the session epoch */
  time(ts){
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) return this.lastT;
    if (this.epoch === null) this.epoch = ms;
    this.lastT = Math.max(0, (ms - this.epoch) / 1000);
    return this.lastT;
  }

  /** node id for a subagent transcript, from its meta.json / agentId */
  ownerFor(agentId, meta){
    if (meta && meta.toolUseId) return meta.toolUseId;
    return this.agentIds.get(agentId) || 'agent:' + agentId;
  }

  /**
   * @param owner  node id this transcript belongs to ('main' for the session file)
   * @param j      one parsed JSONL object
   * @param meta   for subagent files: {agentType, description} (optional)
   * @returns events[]
   */
  feed(owner, j, meta){
    const out = [];
    if (!j || typeof j !== 'object') return out;

    if (j.type === 'custom-title' && j.customTitle){ this.customTitle = true; this.setTitle(j.customTitle, out); return out; }
    if (j.type === 'ai-title' && j.aiTitle && !this.customTitle){ this.setTitle(j.aiTitle, out); return out; }
    if (!j.timestamp) return out;
    const t = this.time(j.timestamp);

    // async completions also arrive through the queue (often before the user line)
    if (j.type === 'queue-operation'){ this.notifications(j.content, t, out); return out; }
    if (j.type === 'attachment'){ if (j.attachment) this.notifications(j.attachment.prompt, t, out); this.activity(owner, t, out); return out; }
    if (j.type !== 'user' && j.type !== 'assistant') return out;

    owner = this.alias.get(owner) || owner;
    if (owner.startsWith('agent:') && !this.nodes.has(owner) && j.type === 'user'){
      // older transcripts have no meta.json: match the subagent's first prompt to its Agent call
      const text = textOf(j.message && j.message.content).trim();
      for (const [id, p] of this.prompts) if (p && p === text){ this.alias.set(owner, id); owner = id; break; }
    }
    this.ensureNode(owner, t, meta, j, out);
    const m = j.message || {};

    if (j.type === 'assistant'){
      if (m.model && m.model !== '<synthetic>' && this.nodes.get(owner).model !== m.model){
        this.nodes.get(owner).model = m.model;
        out.push({t, ev:'meta', id:owner, model:m.model});
      }
      if (m.id && m.usage && !this.seenMsg.has(m.id)){
        this.seenMsg.add(m.id);
        const tok = (m.usage.input_tokens || 0) + (m.usage.output_tokens || 0);
        if (tok) out.push({t, ev:'meta', id:owner, tok});
      }
      for (const b of Array.isArray(m.content) ? m.content : []){
        if (b.type === 'text' && b.text && b.text.trim()) this.nodes.get(owner).lastText = b.text;
        if (b.type === 'tool_use') this.toolUse(owner, b, t, j, out);
      }
      if (owner === MAIN && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use')) this.mainIdle = false;
      if (m.stop_reason === 'end_turn' && owner === MAIN && !this.mainIdle){
        this.mainIdle = true;
        const txt = this.nodes.get(MAIN).lastText || '';
        out.push({t, ev:'idle', id:MAIN, summary:clip(one(txt, 200), 48) || 'Turn complete', result:clip(txt, 1500)});
      }
    } else {
      const c = m.content;
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result') this.toolResult(b, j, t, out);
      this.notifications(textOf(c), t, out);
      if (owner === MAIN && isHumanPrompt(j)){
        this.mainIdle = false;
        out.push({t, ev:'turn', id:MAIN, text:clip(textOf(c), 2000)});
      }
    }
    this.activity(owner, t, out);
    return out;
  }

  setTitle(title, out){
    if (title === this.title) return;
    this.title = title;
    if (this.nodes.has(MAIN)) out.push({t:this.lastT, ev:'title', id:MAIN, desc:title});
  }

  ensureNode(owner, t, meta, j, out){
    if (this.nodes.has(owner)) return;
    if (owner === MAIN){
      this.nodes.set(MAIN, {});
      out.push({t, ev:'start', id:MAIN, type:'Main', desc:this.title || 'Main session', prompt:''});
      return;
    }
    // subagent transcript seen before (or without) its parent's Agent call
    this.nodes.set(owner, {parent:MAIN});
    out.push({t, ev:'start', id:owner, parent:MAIN, type:(meta && meta.agentType) || 'agent',
      desc:(meta && meta.description) || 'subagent', prompt:j.type === 'user' ? clip(textOf(j.message && j.message.content), 4000) : ''});
  }

  activity(owner, t, out){
    const n = this.nodes.get(owner);
    if (!n) return;
    if (n.lastActT === undefined || t - n.lastActT >= 2){ n.lastActT = t; out.push({t, ev:'act', id:owner}); }
  }

  toolUse(owner, b, t, j, out){
    const i = b.input || {};
    if (AGENT_TOOLS.has(b.name)){
      if (!this.nodes.has(b.id)){
        this.nodes.set(b.id, {parent:owner});
        this.prompts.set(b.id, String(i.prompt ?? '').trim());
        out.push({t, ev:'tool', id:owner, name:b.name, arg:one(i.description, 60)});
        out.push({t, ev:'start', id:b.id, parent:owner, type:i.subagent_type || 'general-purpose',
          desc:one(i.description, 120) || 'subagent', prompt:clip(i.prompt, 4000), model:i.model});
      }
      this.pending.set(b.id, {owner, kind:'agent', ms:Date.parse(j.timestamp)});
      if (!this.waitingOnKids(owner)) out.push({t, ev:'wait', id:owner, on:'children'});
      this.nodes.get(owner).waitKids = true;
      return;
    }
    if (b.name === 'SubagentHandback'){
      if (!this.ended.has(owner)){
        this.ended.add(owner);
        const msg = String(i.message ?? '');
        out.push({t, ev:'end', id:owner, status:'done', summary:clip(one(msg, 200), 48) || 'Handed back', result:clip(msg, 1500)});
      }
      return;
    }
    if (b.name === 'SendMessage'){
      const to = this.resolve(i.to ?? i.recipient ?? i.agent_id ?? i.agentId ?? i.target);
      const text = String(i.message ?? i.content ?? i.text ?? '');
      if (to){ out.push({t, ev:'send', from:owner, to, text:clip(text, 1500)}); return; }
    }
    this.pending.set(b.id, {owner, kind:'tool', name:b.name, arg:argOf(b.name, i), ms:Date.parse(j.timestamp)});
    out.push({t, ev:'tool', id:owner, name:b.name, arg:argOf(b.name, i)});
  }

  waitingOnKids(owner){ return !!(this.nodes.get(owner) || {}).waitKids; }

  toolResult(b, j, t, out){
    const p = this.pending.get(b.tool_use_id);
    if (!p) return;
    this.pending.delete(b.tool_use_id);
    if (p.kind === 'agent'){
      const r = j.toolUseResult && typeof j.toolUseResult === 'object' ? j.toolUseResult : {};
      if (r.agentId) this.agentIds.set(r.agentId, b.tool_use_id);
      if (r.status !== 'async_launched' && !this.ended.has(b.tool_use_id)){
        this.ended.add(b.tool_use_id);
        const txt = textOf(b.content) || (typeof b.content === 'string' ? b.content : '');
        out.push({t, ev:'end', id:b.tool_use_id, status:b.is_error ? 'error' : 'done',
          summary:clip(one(txt, 200), 48) || (b.is_error ? 'Failed' : 'Done'), result:clip(txt, 1500)});
      }
      // parent stops waiting once no synchronous Agent call is outstanding
      const stillWaiting = [...this.pending.values()].some(q => q.kind === 'agent' && q.owner === p.owner);
      if (!stillWaiting && this.waitingOnKids(p.owner)){
        this.nodes.get(p.owner).waitKids = false;
        out.push({t, ev:'resume', id:p.owner});
      }
      return;
    }
    if (p.asked){
      const d = j.permissionDecision || {};
      const note = d.decision === 'reject' || j.toolDenialKind ? 'rejected by user'
                 : d.source === 'user_temporary' ? 'approved by user' : '';
      out.push({t, ev:'resume', id:p.owner, note});
    }
  }

  notifications(s, t, out){
    for (const n of notificationsIn(s)){
      if (this.ended.has(n.toolUseId)) continue;
      this.ended.add(n.toolUseId);
      out.push({t, ev:'end', id:n.toolUseId, status:/^(completed|done|success)/i.test(n.status) ? 'done' : 'error',
        summary:clip(one(n.summary || n.result, 200), 48) || n.status, result:clip(n.result || n.summary, 1500)});
    }
  }

  resolve(ref){
    if (!ref) return null;
    ref = String(ref);
    if (this.nodes.has(ref)) return ref;
    if (this.agentIds.has(ref)) return this.agentIds.get(ref);
    return null;
  }

  /**
   * Time-based inference: a permission-gated tool with no result for a while is
   * either still running or waiting for the user's approval.
   */
  tick(nowMs){
    const out = [];
    if (this.epoch === null) return out;
    for (const p of this.pending.values()){
      if (p.kind !== 'tool' || p.asked || !APPROVAL_TOOLS.has(p.name)) continue;
      const age = nowMs - p.ms;
      if (age < this.approvalAfterMs || age > 30 * 60 * 1000) continue;
      p.asked = true;
      out.push({t:(nowMs - this.epoch) / 1000, ev:'wait', id:p.owner, on:'user', reason:`${p.name} ${p.arg}`.trim(), inferred:true});
    }
    return out;
  }
}

module.exports = {SessionParser, argOf, notificationsIn, isHumanPrompt, MAIN};
