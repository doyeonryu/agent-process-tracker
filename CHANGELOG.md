# Changelog

## 0.1.2

- Tracker button in the editor title bar (next to other AI tools' buttons) opens the panel with one click.

## 0.1.1

- WSL support: a Windows VS Code window now also finds sessions of Claude Code running inside WSL
  (`\\wsl.localhost\<distro>\home\<user>\.claude`, folder named after `/mnt/<drive>/…`). The most recently
  active location wins, and "Follow latest" re-checks it every ~30 s. The header shows the source, e.g. `Claude (WSL: Ubuntu)`.
- Sidebar: Process is collapsed to the latest 3 steps by default; "Show N earlier steps" expands it, so the Result stays in view.

## 0.1.0

- First release: live tracker panel for Claude Code sessions in VS Code.
- Agent tree with sibling layout, live states (working / waiting / needs approval / done / failed / idle), stale-activity warning.
- Task, result and message arrows; conversation log with confirmed/inferred tags.
- Sidebar: Task → Goal → Process → Result.
- Session picker with "Follow latest", VS Code theme sync, `vscode://dcel.agent-process-tracker/open` URI.
