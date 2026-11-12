'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

/** ~/.claude/projects (honours CLAUDE_CONFIG_DIR and an explicit override) */
function projectsRoot(override){
  if (override) return path.join(override.replace(/^~(?=$|[\\/])/, os.homedir()), 'projects');
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** Claude Code stores each working directory under its path with every non-alphanumeric char replaced by '-' */
const encodeCwd = p => p.replace(/[^a-zA-Z0-9]/g, '-');

async function readHead(file, bytes){
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const {bytesRead} = await fh.read(buf, 0, bytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally { await fh.close(); }
}
async function readTail(file, bytes){
  const fh = await fsp.open(file, 'r');
  try {
    const {size} = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const {bytesRead} = await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8', 0, bytesRead);
  } finally { await fh.close(); }
}

/** Find the transcript folder for a workspace path. */
async function findProjectDir(workspacePath, rootOverride){
  const root = projectsRoot(rootOverride);
  let dirs;
  try { dirs = await fsp.readdir(root, {withFileTypes:true}); } catch { return null; }
  dirs = dirs.filter(d => d.isDirectory()).map(d => d.name);
  const want = encodeCwd(workspacePath).toLowerCase();
  const hit = dirs.find(d => d.toLowerCase() === want);
  if (hit) return path.join(root, hit);

  // fallback: long or unusual paths — match the recorded cwd of the newest session
  const norm = p => path.resolve(p).toLowerCase();
  for (const d of dirs){
    const sessions = await listSessions(path.join(root, d), {titles:false, limit:1});
    if (!sessions.length) continue;
    try {
      const head = await readHead(sessions[0].file, 64 * 1024);
      const m = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m && norm(JSON.parse(`"${m[1]}"`)) === norm(workspacePath)) return path.join(root, d);
    } catch { /* unreadable — skip */ }
  }
  return null;
}

function titleFrom(text){
  let title = null, custom = null;
  for (const line of text.split('\n')){
    if (!line.includes('-title"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.type === 'custom-title' && j.customTitle) custom = j.customTitle;
      if (j.type === 'ai-title' && j.aiTitle) title = j.aiTitle;
    } catch { /* partial line */ }
  }
  return custom || title;
}

/** Sessions in a project folder, newest first. */
async function listSessions(dir, {titles = true, limit = 30} = {}){
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  const items = [];
  for (const n of names){
    if (!n.endsWith('.jsonl')) continue;
    try {
      const st = await fsp.stat(path.join(dir, n));
      items.push({id:n.slice(0, -6), file:path.join(dir, n), mtime:st.mtimeMs, size:st.size});
    } catch { /* removed meanwhile */ }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  const top = items.slice(0, limit);
  if (titles) for (const s of top){
    try { s.title = titleFrom(await readTail(s.file, 256 * 1024)) || titleFrom(await readHead(s.file, 256 * 1024)); } catch { /* ignore */ }
  }
  return top;
}

/** All project folders (for workspaces without a match). */
async function listProjects(rootOverride){
  const root = projectsRoot(rootOverride);
  let dirs;
  try { dirs = await fsp.readdir(root, {withFileTypes:true}); } catch { return []; }
  const out = [];
  for (const d of dirs) if (d.isDirectory()){
    const s = await listSessions(path.join(root, d.name), {titles:false, limit:1});
    if (s.length) out.push({name:d.name, dir:path.join(root, d.name), mtime:s[0].mtime});
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

module.exports = {projectsRoot, encodeCwd, findProjectDir, listSessions, listProjects};
