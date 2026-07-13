# Claude Session Folders

Organize your **Claude Code** sessions into colored folders, right inside the Claude Code sidebar. The official extension shows a flat chronological list — this one adds folders, date grouping, drag & drop and one-click open.

## Features

### 📁 Folders panel inside the Claude Code sidebar
The **Folders** view renders below the official session list (same sidebar, no extra activity bar icon). It requires the [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) to be installed.

### 🗂️ Three grouping modes
Cycle with the ⇄ button (the current mode is shown next to the view title):

| Mode | What you see |
|---|---|
| **Folders** | Your folders + *Unfiled*, sessions sorted by date inside |
| **Folders + dates** | Same folders, but sessions grouped by *Today / Yesterday / This week / This month / Older* inside each folder |
| **Dates** | No folders — all sessions under the five date buckets |

Date buckets are calendar-based: *This week* starts on Monday, *This month* on the 1st.

### 🖱️ Drag & drop
- Drag one or more sessions (Ctrl+click for multi-select) onto a **folder** → assigned.
- Drop onto **Unfiled** → unassigned.
- Drop onto another session → moved to that session's folder.
- Right-click → *Move to Folder…* works too, and can create the folder on the fly.
- **Drag folders themselves to reorder them** — they are shown in your custom order, not alphabetically.

### 🎨 13 folder colors
Blue, cyan, bright cyan, green, bright green, yellow, orange, red, bright red, magenta, pink, purple and gray — implemented as theme colors (`charts.*` / terminal ANSI), so they adapt to your color theme.

### ▶️ Open sessions in the Claude panel
Clicking a session opens it **inside the official Claude Code UI** (via its `claude-vscode.primaryEditor.open` command). If the official extension is missing, it falls back to a terminal running `claude --resume <id>`. The ➕ button starts a new Claude conversation.

### 💬 New chat directly inside a folder
Right-click a folder → *New Chat in This Folder*: a new Claude conversation opens and, as soon as its transcript appears on disk (watched for up to 2 minutes), it is automatically filed into that folder. Status bar messages confirm both steps.

### 🔍 Rich tooltips
Hovering a session shows its first user message as a preview, plus its working directory, date and session id.

### 🌍 Localized
English by default, Spanish (`es`) included — follows your VS Code display language. Contributions for more languages welcome (`package.nls.<lang>.json` + `l10n/bundle.l10n.<lang>.json`).

## How it works

Claude Code stores each session as a `.jsonl` transcript in `~/.claude/projects/<project>/<uuid>.jsonl`. This extension:

1. Scans those files (read-only) and extracts the title (`ai-title` record), working directory (`cwd`) and date. Reads are capped at 4 MB per file and cached by mtime, so refreshes are cheap.
2. Renders the tree and stores your organization — folders, colors, assignments — in a separate file: `~/.claude/chat-folders.json`. **Transcripts are never modified**, and your folders survive reinstalls and Claude Code updates.

```jsonc
// ~/.claude/chat-folders.json
{
  "folders": [
    { "id": "f-1a2b3c4d", "name": "Padel Nuestro", "color": "charts.orange" }
  ],
  "assignments": { "<session-uuid>": "f-1a2b3c4d" }
}
```

> ⚠️ Claude Code deletes old transcripts after `cleanupPeriodDays` (30 days by default). Raise it in `~/.claude/settings.json` to keep more history — this extension can only show what still exists on disk.

## Usage

| Action | How |
|---|---|
| New Claude conversation | ➕ button in the Folders header |
| New chat filed into a folder | Right-click the folder → *New Chat in This Folder* |
| Create a folder | 📁+ button, or *New folder…* inside *Move to Folder…* |
| Move chats to a folder | Drag & drop, or right-click → *Move to Folder…* |
| Take a chat out of its folder | Drag onto *Unfiled*, or right-click → *Remove from Folder* |
| Rename / recolor / delete folder | Right-click on the folder (deleting never deletes chats) |
| Reorder folders | Drag a folder above/below another |
| Switch grouping mode | ⇄ button (Folders → Folders + dates → Dates) |
| Open a session | Click it — opens in the Claude Code panel |
| Refresh | 🔄 button (also auto-refreshes every 2 minutes) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeSessionFolders.claudeDir` | `~/.claude` | Claude Code data directory (where `projects/` lives) |
| `claudeSessionFolders.onlyCurrentProject` | `false` | Show only sessions whose `cwd` matches the current workspace |

## Development

```bash
git clone https://github.com/AdrianaSaiz/vscode-claude-session-folders.git
cd vscode-claude-session-folders
code .
# F5 → opens an Extension Development Host with the extension loaded
```

Plain JavaScript against the VS Code API — no dependencies, no build step.

### Package & install

```bash
npx @vscode/vsce package
code --install-extension claude-session-folders-0.1.0.vsix
```

## Roadmap

- [ ] Search within the view
- [ ] Archive sessions (keep transcripts beyond Claude Code's `cleanupPeriodDays`)

## License

MIT
