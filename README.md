# Agent Process Tracker

**English** | [?쒓뎅??(README.ko.md)

A live view of **Claude Code agents and subagents** inside VS Code. It shows who delegated what, what each agent is doing now, what it is waiting on, and what it reported back.

- **Tree of agents**: the main conversation sits on top, subagents branch below it, and siblings sit side by side.
- **Live states**: Working, Waiting (on subtasks or another agent), Needs approval, Done, Failed, and Idle. An agent that has done nothing for a while gets a warning.
- **Communication**: tasks going down to subagents, results coming back up, and agent-to-agent messages are drawn as animated arrows. The conversation log at the bottom lists all of them.
- **Sidebar for each agent**: the Task it received, its Goal, its Process (a timeline of tool calls, spawned subagents, messages and waits), and its Result (and who received it).
- **Facts vs. inferences**: anything the tracker *infers* rather than reads directly is labelled `inferred`.

> Status: early (0.1). Claude Code only for now; Codex CLI support is planned.

## Install

1. Download `agent-process-tracker-<version>.vsix` from [Releases](https://github.com/doyeonryu/agent-process-tracker/releases).
2. Install it:
   ```sh
   code --install-extension agent-process-tracker-0.1.2.vsix
   ```
   Or in VS Code: Extensions view ??`?? ??**Install from VSIX??*

## Use

Open a folder you use Claude Code in, then run any of these:

- the tracker button in the editor title bar (top right of any editor)
- `Ctrl+Alt+A` (`Cmd+Alt+A` on macOS)
- Command Palette ??**Agent Tracker: Open**
- From anywhere, including a Claude Code slash command: `code --open-url "vscode://dcel.agent-process-tracker/open"`

The panel opens beside your editor and follows the newest Claude Code session for that workspace. Each VS Code window tracks its own workspace. To look at an older session, use the session dropdown in the header, or run **Agent Tracker: Pick Session??*. Turn **Follow latest** off to stay on one session.

| Interaction | |
|---|---|
| `Ctrl` + scroll | zoom around the cursor |
| `Shift` + scroll / drag | pan |
| `F` | fit everything |
| click a block | Task ??Goal ??Process ??Result sidebar |
| click a log row | expand the full text and its source |
| `Esc` | clear selection |

### WSL

- **Windows VS Code window, Claude Code running in a WSL terminal**: this works out of the box. The extension also searches every WSL distro's `~/.claude/projects` (through `\\wsl.localhost\??) and matches `e:\work\app` to the `/mnt/e/work/app` folder that Claude Code uses there.
- **VS Code connected to WSL** (`WSL: <distro>` in the bottom-left corner): in the Extensions view, click **Install in WSL** on Agent Tracker once.

### Optional: a `/tracker` slash command in Claude Code

Save this as `~/.claude/commands/tracker.md`:

```markdown
Open the Agent Tracker panel by running this shell command, then reply "Opened.":
code --open-url "vscode://dcel.agent-process-tracker/open"
```

## How it works

Claude Code writes a transcript for every session:

```
~/.claude/projects/<workspace path, non-alphanumerics ??'-'>/
  <session>.jsonl                          main conversation
  <session>/subagents/agent-<id>.jsonl     one per subagent
  <session>/subagents/agent-<id>.meta.json links it to the parent's Agent call
```

The extension polls these files, reads only the bytes that are new, and turns the lines into events:

| Shown as | Source | |
|---|---|---|
| Task (spawn) | parent's `Agent` tool call: description, type, prompt | confirmed |
| Tool activity | the subagent transcript's `tool_use` entries | confirmed |
| Result | `SubagentHandback`, `<task-notification>`, or the `Agent` tool result | confirmed |
| Message | `SendMessage` tool calls | confirmed |
| Waiting on subtasks | an `Agent` call that has no result yet | confirmed |
| Running or awaiting approval | a Bash/Edit/Write/??call with no result after *n* seconds | **inferred** |
| No activity warning | time since the agent's last transcript entry | confirmed |

**Privacy:** everything stays on your machine. The extension only reads local files, and it makes no network requests and collects no telemetry.

## Settings

| Setting | Default | |
|---|---|---|
| `agentTracker.staleSeconds` | `60` | warn when a working agent has been silent this long |
| `agentTracker.approvalHintSeconds` | `8` | when a gated tool counts as "running or awaiting approval" |
| `agentTracker.claudeConfigDir` | `""` | custom Claude config folder (default `$CLAUDE_CONFIG_DIR` or `~/.claude`) |

## Develop

There are no dependencies and no build step. The extension is plain Node.js.

```sh
npm test               # parser + locator tests (synthetic data only)
npm run package        # builds the .vsix with @vscode/vsce
```

- `src/parser.js`: transcript lines ??events (pure, unit-tested)
- `src/tail.js`: incremental reader for the main and subagent transcripts
- `src/locate.js`: workspace ??transcript folder, session list
- `src/extension.js`: command, webview panel, session switching
- `media/index.html`: the UI. Open it directly in a browser to watch a **demo** with simulated agents.

Press `F5` in VS Code with this folder open to run an Extension Development Host.

**Never commit real transcripts.** They contain your conversations. Tests use synthetic lines only.

## Roadmap

- Codex CLI sessions (`~/.codex/sessions`)
- Confirmed approval state via Claude Code hooks
- Marketplace / Open VSX publishing

## License

[MIT](LICENSE)
