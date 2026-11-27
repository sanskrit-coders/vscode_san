# Github-san tools (VS Code)

Visual Studio Code extension (`sanskrit-coders.github-san`) providing **Open on GitHub**, **Copy GitHub URL**, and [`diff_san`](https://github.com/sanskrit-coders/diff_san) (`local-diff-san`) integration for files and folders inside Git submodules, worktrees, and multi-root workspaces.

## Install

- **VS Code Marketplace:** [Github-san tools (`sanskrit-coders.github-san`)](https://marketplace.visualstudio.com/items?itemName=sanskrit-coders.github-san) — or run `code --install-extension sanskrit-coders.github-san`
- **Open VSX Registry (Cursor, Windsurf, VSCodium, Antigravity):** [`sanskrit-coders/github-san`](https://open-vsx.org/extension/sanskrit-coders/github-san)
- **GitHub Releases:** [`sanskrit-coders/vscode_san/releases`](https://github.com/sanskrit-coders/vscode_san/releases)
- **JetBrains sister plugin:** [`sanskrit-coders/jetbrains_san`](https://github.com/sanskrit-coders/jetbrains_san)

## Features

- **Open on GitHub** (`Github-san: Open on GitHub`): Opens files, folders, and submodule roots in your browser from Explorer, Editor, Editor Tab, Source Control (SCM), or Command Palette, with `#L...` line/selection anchors in active editors.
- **Copy GitHub URL** (`Github-san: Copy GitHub URL`): Copies the canonical GitHub URL directly to your clipboard.
- **Diff with `diff_san`** (`Github-san: Diff with diff_san (HEAD / Two Files)`):
  - **1 file or folder** inside a Git repo/submodule → diffs against `HEAD` (`local-diff-san <path>`).
  - **2 selected files** → compares both side by side (`local-diff-san <left> <right>`).
  - **3+ selected files** in Git repos → diffs all selected files against `HEAD` (`local-diff-san --head <paths...>`).
- Resolves `.git` pointer files (`gitdir: ...`), worktree `commondir` configs, tracking branch names (e.g. `origin/content` → `content`), detached `HEAD` commits, and UTF-8 / Devanagari path segments.

## Configuration

- `githubSan.diffSanExecutable`: Optional path to `local-diff-san`. When empty, searches `DIFF_SAN_BIN`, `PATH`, workspace `.venv/bin` / `venv/bin`, `~/gitland/python_venv/bin`, `~/.local/bin`, `~/.venv/bin`, `~/venv/bin`, and `~/gitland/sanskrit-coders/diff_san/.venv/bin`.

## Build, Test & Install

```bash
cd github-san
npm install
npm test
npm run package
code --install-extension build/github-san-1.1.0.vsix
```
