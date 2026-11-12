'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const {execFile} = require('child_process');

/** ~/.claude/projects (honours CLAUDE_CONFIG_DIR and an explicit override) */
function projectsRoot(override){
  if (override) return path.join(override.replace(/^~(?=$|[\\/])/, os.homedir()), 'projects');
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** Claude Code stores each working directory under its path with every non-alphanumeric char replaced by '-' */
const encodeCwd = p => p.replace(/[^a-zA-Z0-9]/g, '-');

/** e:\DCEL\foo -> /mnt/e/DCEL/foo (how the same folder looks to Claude Code running inside WSL) */
function toWslPath(winPath){
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(winPath);
  if (!m) return null;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.replace(/\/+$/, '');
}

/** folder names a workspace may be stored under (Windows-native and WSL) */
function candidateNames(workspacePath){
  const names = [encodeCwd(workspacePath)];
  const w = process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(workspacePath) ? toWslPath(workspacePath) : null;
  if (w) names.push(encodeCwd(w));
  return names.map(n => n.toLowerCase());
}

/* ---------- WSL discovery (Windows only) ---------- */
let wslCache = null, wslCacheAt = 0;

function wslDistros(){
  return new Promise(resolve => {
    execFile('wsl.exe', ['-l', '-q'], {encoding:'buffer', timeout:4000, windowsHide:true}, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      // wsl.exe prints UTF-16LE
      const text = stdout.toString(stdout.includes(0) ? 'utf16le' : 'utf8').replace(/\uFEFF|\0/g, '');
      resolve(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    });
  });
}

/** \\wsl.localhost\<distro>\home\<user>\.claude\projects for every distro/user that has one */
async function wslRoots(){
  if (process.platform !== 'win32') return [];
  if (wslCache && Date.now() - wslCacheAt < 60000) return wslCache;
  const roots = [];
  for (const d of await wslDistros()){
    for (const share of ['\\\\wsl.localhost\\', '\\\\wsl$\\']){
      const base = share + d;
      let homes;
      try { homes = (await fsp.readdir(path.join(base, 'home'))).map(u => path.join(base, 'home', u)); } catch { continue; }
      homes.push(path.join(base, 'root'));
      for (const h of homes){
        const p = path.join(h, '.claude', 'projects');
        try { if ((await fsp.stat(p)).isDirectory()) roots.push({root:p, label:`WSL: ${d}`}); } catch { /* none */ }
      }
      break;   // first share that works is enough
    }
  }
  wslCache = roots; wslCacheAt = Date.now();
  return roots;
}

/** every transcript root to search, Windows-native first */
async function allRoots(override){
  if (override) return [{root:projectsRoot(override), label:'custom'}];
  return [{root:projectsRoot(), label:'local'}, ...await wslRoots()];
}

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

async function subdirs(root){
  try { return (await fsp.readdir(root, {withFileTypes:true})).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

/**
 * Find the transcript folder for a workspace path.
 * When the workspace has sessions in several places (Windows and WSL), the most recently active one wins.
 * @returns {Promise<string|null>}
 */
async function findProjectDir(workspacePath, override){
  const found = await findProjectDirs(workspacePath, override);
  return found.length ? found[0].dir : null;
}

/** All matches, newest activity first: [{dir, label, mtime}] */
async function findProjectDirs(workspacePath, override){
  const want = candidateNames(workspacePath);
  const hits = [];
  for (const {root, label} of await allRoots(override)){
    for (const d of await subdirs(root)) if (want.includes(d.toLowerCase())) hits.push({dir:path.join(root, d), label});
  }
  if (!hits.length){
    // fallback: long or unusual paths — match the recorded cwd of each folder's newest session
    const norm = p => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const targets = [norm(path.resolve(workspacePath))];
    const w = toWslPath(workspacePath); if (w) targets.push(norm(w));
    for (const {root, label} of await allRoots(override)) for (const d of await subdirs(root)){
      const sessions = await listSessions(path.join(root, d), {titles:false, limit:1});
      if (!sessions.length) continue;
      try {
        const m = (await readHead(sessions[0].file, 64 * 1024)).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (m && targets.includes(norm(JSON.parse(`"${m[1]}"`)))) hits.push({dir:path.join(root, d), label});
      } catch { /* unreadable — skip */ }
    }
  }
  for (const h of hits){
    const s = await listSessions(h.dir, {titles:false, limit:1});
    h.mtime = s.length ? s[0].mtime : 0;
  }
  return hits.sort((a, b) => b.mtime - a.mtime);
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

/** All project folders across every root (for workspaces without a match). */
async function listProjects(override){
  const out = [];
  for (const {root, label} of await allRoots(override)) for (const d of await subdirs(root)){
    const s = await listSessions(path.join(root, d), {titles:false, limit:1});
    if (s.length) out.push({name:d, label, dir:path.join(root, d), mtime:s[0].mtime});
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

module.exports = {projectsRoot, encodeCwd, toWslPath, candidateNames, wslRoots, findProjectDir, findProjectDirs, listSessions, listProjects};
