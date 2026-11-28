# Changelog

## 1.2.0

- Added **Push Submodules & Repository** (`githubSan.pushWithSubmodules`) in the SCM title bar, Explorer context menu, Commit dropdown (**Commit & Push Submodules + Repo**), and Command Palette.
- Added **Enable Git Submodule Auto-Push** (`githubSan.enableSubmoduleAutoPush`) to configure `git config --global push.recurseSubmodules on-demand` and optionally install an idempotent bottom-up `.git/hooks/pre-push` hook.
- Added silent bottom-up submodule auto-push (`githubSan.autoPushSubmodules`, default `true`) after superproject pushes on machines where `push.recurseSubmodules` is not configured.

## 1.1.1

- Linked `diff_san` and `local-diff-san` installation READMEs in the extension description and documentation.

## 1.1.0

- Initial VS Code release matching `jetbrains_san/github-san` v1.1.0.
- Added **Open on GitHub** and **Copy GitHub URL** for Git submodules, worktrees, folders, and editor line selections.
- Added **Diff with `diff_san` (HEAD / Two Files)** integrating `local-diff-san` from Explorer, Editor, Editor Title, Source Control, and Command Palette.
