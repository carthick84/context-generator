# Context Generator

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/KarthickB.context-generator?label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=KarthickB.context-generator)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/KarthickB.context-generator)](https://marketplace.visualstudio.com/items?itemName=KarthickB.context-generator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-carthick84%2Fcontext-generator-blue?logo=github)](https://github.com/carthick84/context-generator)

Generate AI-ready code context from your project files — copy your codebase into a single markdown document ready to paste into Claude, ChatGPT, or any LLM.

## Installation

Install directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=KarthickB.context-generator), or search **"Context Generator"** in the Extensions sidebar (`Cmd+Shift+X`).

---

## Features

- **Folder context** — right-click any folder in the Explorer and generate context for it
- **Open files context** — capture all currently open editor tabs in one shot
- **Smart ignore/keep rules** — glob-based ignore patterns with `!` un-ignore overrides
- **Include filters** — scope output to specific paths (e.g. `src/**`)
- **Always-append includes** — automatically append key files (e.g. your schema or config) to every generation
- **Multiple profiles** — save different configurations for different tasks (e.g. "Frontend", "API", "Full Stack")
- **Editable global defaults** — tweak or reset the built-in safety ignore list
- **Intro text** — prepend a custom prompt or instructions to every output

---

## Commands

| Command | Description |
|---|---|
| `Context Generator: Configure Settings` | Open the settings UI |
| `Context Generator: Open Files` | Generate context from all open editor tabs |
| `Context Generator: Selected Folder` | Generate context from a right-clicked folder |

Access via `Cmd+Shift+P` (macOS) / `Ctrl+Shift+P` (Windows/Linux), or right-click a folder in the Explorer.

---

## Ignore & Keep Patterns

Patterns use standard glob syntax (powered by [micromatch](https://github.com/micromatch/micromatch)), one per line.

### Ignoring files

```
**/tests/**
**/*.spec.ts
seed_data.js
```

### Force-keeping files inside ignored directories

Prefix a pattern with `!` to un-ignore it even if its parent directory is ignored:

```
**/transcoding/**
!Transcoder.js
```

This will skip everything in `transcoding/` **except** `Transcoder.js`.

### How keep patterns work

| Pattern | Behaviour |
|---|---|
| `!Transcoder.js` | Keeps any file named `Transcoder.js` anywhere in the tree (bare filename, matched by basename) |
| `!src/core/**` | Keeps everything under `src/core/` even if `src/` is ignored |
| `!**/AgentView.js` | Keeps any `AgentView.js` anywhere in the tree |

> **Safety barrier** — default-ignored directories (`node_modules`, `.git`, etc.) are **never** traversed by global bare-filename keeps. Only an explicit child path keep (e.g. `!node_modules/mypkg/patch.js`) can unlock them.

---

## Default Ignored Paths

The following are ignored by default across all profiles. You can edit or reset this list in **Settings → Global Defaults**.

- Source control: `.git/`, `.gitignore`
- Dependencies: `node_modules/`, lock files
- Build output: `dist/`, `build/`, `coverage/`
- Python: `__pycache__/`, `.venv/`, `*.pyc`
- Media & fonts: images, video, PDF, web fonts
- Mobile: `android/`, `ios/`
- Logs & env: `*.log`, `.env`, `.DS_Store`
- Output loop prevention: `*-context.md`, `code-context.md`

---

## Profiles

Create named profiles to switch between different generation configs instantly.

- **Default** — always present, cannot be deleted
- Add profiles via the `+` button in the settings UI
- Each profile stores its own Include Patterns, Ignore Patterns, Intro Text, and Always-Append setting
- Global Default Ignores are shared across all profiles

---

## Settings UI

Open via `Context Generator: Configure Settings`.

### Configuration tab

| Field | Description |
|---|---|
| **Include Patterns** | Only include files matching these globs. Leave empty to include everything not ignored. |
| **Always append includes** | When generating from Open Files or a folder selection, always append the Include Patterns output at the end. Useful for always attaching a schema, config, or shared types file. |
| **User Ignore Patterns** | Extra patterns to ignore (or `!` keep) on top of the global defaults. |
| **Intro Text** | Prepended verbatim to every output — use this for LLM instructions or project context. |

### Global Defaults tab

Edit the baseline ignore list applied to every profile. Use **Reset to Factory Defaults** to restore the original list.

---

## Output Format

Generated context opens as a new Markdown editor tab. It contains:

1. Your **Intro Text** (if set)
2. A **directory tree** of included files
3. Each **file's content** in a fenced code block, labelled with its relative path

```markdown
### src/server/index.ts

```ts
import express from 'express';
...
```
```

You can then copy the entire document and paste it into your LLM of choice.

---

## Tips

- Use **Include Patterns** to scope a large monorepo down to just the relevant package before generating
- Use **Always-append includes** to attach shared types or a database schema to every generation without having to include them manually each time
- Use **Intro Text** to embed a standing prompt like `"You are reviewing a Node.js API. Focus on error handling and type safety."` so it's always included
- Generate from **open files** when you want precise control — open exactly the files relevant to your question, then run the command

---

## Requirements

- VS Code 1.80.0 or higher

---

## Contributing

Issues and PRs welcome on [GitHub](https://github.com/carthick84/context-generator).

---

## License

MIT — see [LICENSE](LICENSE)