# vscode_san

Visual Studio Code extensions tailored for Sanskrit scholarship and multi-submodule corpus workflows (sister repository to [`jetbrains_san`](https://github.com/sanskrit-coders/jetbrains_san)).

## Extensions

### [`github-san/`](github-san/README.md) (**Github-san tools**)

- **VS Code Marketplace:** [Github-san tools (`sanskrit-coders.github-san`)](https://marketplace.visualstudio.com/items?itemName=sanskrit-coders.github-san)
- **Open VSX Registry:** [`sanskrit-coders/github-san`](https://open-vsx.org/extension/sanskrit-coders/github-san)
- **GitHub Releases:** [`github-san-v*` `.vsix` packages](https://github.com/sanskrit-coders/vscode_san/releases)

Adds **Open on GitHub**, **Copy GitHub URL**, and **`diff_san` Diff Actions** for files and folders inside Git submodules, Git worktrees, and multi-root repositories—including cases where multiple submodules point to different branches of the same GitHub repository (such as `content` and `static` branches in `vishvAsa` Hugo corpora).

- **Submodules & worktrees:** resolves `.git` pointer files (`gitdir: ...`) and worktree `commondir` configs directly.
- **Files, directories, & line selections:** opens `/blob/<branch-or-sha>/...` (with `#L...` fragments from editors) and `/tree/<branch-or-sha>/...` for folders and submodule roots.
- **Diff with `diff_san`:** right-click a file/folder (diff against `HEAD`), two selected files (side-by-side comparison), or 3+ files (`--head`) using [`local-diff-san`](https://github.com/sanskrit-coders/diff_san/blob/master/local_diff/README.md) from [`diff_san`](https://github.com/sanskrit-coders/diff_san/blob/master/README.md) (`pip install local-diff-san`).

See [`github-san/README.md`](github-san/README.md) for build and installation instructions.
