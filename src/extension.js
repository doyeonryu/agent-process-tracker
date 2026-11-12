'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {findProjectDir, listSessions, listProjects} = require('./locate');
const {SessionTail} = require('./tail');

let panel = null;   // one tracker per VS Code window

function activate(context){
  context.subscriptions.push(
    vscode.commands.registerCommand('agentTracker.open', () => TrackerPanel.show(context)),
    vscode.commands.registerCommand('agentTracker.pickSession', async () => {
      const p = await TrackerPanel.show(context);
      p.pickSession();
    }),
    vscode.window.registerUriHandler({
      handleUri(uri){ if (uri.path === '/open' || uri.path === '/') TrackerPanel.show(context); },
    }),
  );
}

function deactivate(){ if (panel) panel.dispose(); }

const cfg = () => vscode.workspace.getConfiguration('agentTracker');

class TrackerPanel {
  static async show(context){
    if (panel){ panel.web.reveal(vscode.ViewColumn.Beside); return panel; }
    panel = new TrackerPanel(context);
    await panel.init();
    return panel;
  }

  constructor(context){
    this.context = context;
    this.web = vscode.window.createWebviewPanel('agentTracker', 'Agent Tracker', vscode.ViewColumn.Beside, {
      enableScripts:true,
      retainContextWhenHidden:true,
      localResourceRoots:[vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.web.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    this.projectDir = null;
    this.sessionId = null;
    this.follow = true;
    this.tail = null;
    this.sessions = [];
    this.timers = [];
    this.ready = false;
    this.web.onDidDispose(() => this.dispose());
    this.web.webview.onDidReceiveMessage(m => this.onMessage(m));
  }

  async init(){
    this.web.webview.html = this.html();
    this.timers.push(setInterval(() => this.refreshSessions(), 3000));
    this.timers.push(setInterval(() => this.post({type:'heartbeat', lastEventMs:this.tail ? this.tail.lastEventMs : 0}), 2000));
  }

  html(){
    const file = path.join(this.context.extensionPath, 'media', 'index.html');
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';`;
    return fs.readFileSync(file, 'utf8')
      .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
      .replace(/<script>/g, `<script nonce="${nonce}">`);
  }

  post(msg){ if (this.ready) this.web.webview.postMessage(msg); }

  async onMessage(m){
    if (m.type === 'ready'){
      this.ready = true;
      await this.locateProject();
      await this.refreshSessions(true);
    } else if (m.type === 'selectSession'){
      this.follow = false;
      this.post({type:'follow', on:false});
      await this.switchTo(m.id);
    } else if (m.type === 'setFollow'){
      this.follow = !!m.on;
      if (this.follow) await this.refreshSessions(true);
    } else if (m.type === 'pickProject'){
      await this.pickProject();
    }
  }

  async locateProject(){
    const override = cfg().get('claudeConfigDir') || undefined;
    const folders = vscode.workspace.workspaceFolders || [];
    for (const f of folders){
      const dir = await findProjectDir(f.uri.fsPath, override);
      if (dir){ this.projectDir = dir; this.workspaceName = f.name; return; }
    }
    this.projectDir = null;
    this.workspaceName = folders[0] ? folders[0].name : null;
  }

  async refreshSessions(force = false){
    if (!this.ready) return;
    if (!this.projectDir){
      await this.locateProject();
      if (!this.projectDir){
        this.post({type:'empty', workspace:this.workspaceName,
          message:this.workspaceName
            ? `No Claude Code sessions found for “${this.workspaceName}” yet. Start Claude Code in this folder — the tracker will pick it up automatically.`
            : 'Open a folder (or pick a project) to track its Claude Code sessions.'});
        return;
      }
    }
    const list = await listSessions(this.projectDir);
    const changed = JSON.stringify(list.map(s => [s.id, s.title])) !== JSON.stringify(this.sessions.map(s => [s.id, s.title]));
    this.sessions = list;
    if (changed || force) this.post({type:'sessions', current:this.sessionId, follow:this.follow,
      sessions:list.map(s => ({id:s.id, title:s.title || s.id.slice(0, 8), mtime:s.mtime}))});
    if (!list.length) return;
    const newest = list[0];
    if (!this.sessionId || (this.follow && newest.id !== this.sessionId)) await this.switchTo(newest.id);
  }

  async switchTo(id){
    if (!this.projectDir || !id) return;
    if (this.tail) this.tail.stop();
    this.sessionId = id;
    const s = this.sessions.find(x => x.id === id);
    this.post({type:'sessions', current:id, follow:this.follow,
      sessions:this.sessions.map(x => ({id:x.id, title:x.title || x.id.slice(0, 8), mtime:x.mtime}))});
    let first = true;
    const tail = new SessionTail(this.projectDir, id, (events, {replay}) => {
      if (tail !== this.tail) return;              // a newer switch happened
      if (first){
        first = false;
        this.post({type:'reset', session:{id, title:s && s.title}, epochMs:tail.epochMs ?? Date.now(),
          staleSeconds:cfg().get('staleSeconds', 60), live:true});
      }
      if (events.length) this.post({type:'events', events, replay});
    }, {approvalAfterMs:cfg().get('approvalHintSeconds', 8) * 1000});
    this.tail = tail;
    await tail.start();
  }

  async pickSession(){
    if (!this.projectDir) return this.pickProject();
    const list = await listSessions(this.projectDir);
    const pick = await vscode.window.showQuickPick(list.map(s => ({
      label:s.title || s.id, description:new Date(s.mtime).toLocaleString(), id:s.id,
    })), {placeHolder:'Claude Code session to track'});
    if (pick){ this.follow = false; this.post({type:'follow', on:false}); await this.switchTo(pick.id); }
  }

  async pickProject(){
    const projects = await listProjects(cfg().get('claudeConfigDir') || undefined);
    const pick = await vscode.window.showQuickPick(projects.map(p => ({
      label:p.name, description:new Date(p.mtime).toLocaleString(), dir:p.dir,
    })), {placeHolder:'Claude Code project to track'});
    if (!pick) return;
    this.projectDir = pick.dir; this.sessionId = null; this.follow = true;
    await this.refreshSessions(true);
  }

  dispose(){
    if (this.tail) this.tail.stop();
    for (const t of this.timers) clearInterval(t);
    if (panel === this) panel = null;
  }
}

module.exports = {activate, deactivate};
