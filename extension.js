const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const t = vscode.l10n.t;

// Folder colors must be theme color ids; charts.* and terminal ANSI ids give
// distinct hues that adapt to the active theme.
const COLORS = [
  { label: `$(circle-filled) ${t("Blue")}`, id: "charts.blue" },
  { label: `$(circle-filled) ${t("Cyan")}`, id: "terminal.ansiCyan" },
  { label: `$(circle-filled) ${t("Bright cyan")}`, id: "terminal.ansiBrightCyan" },
  { label: `$(circle-filled) ${t("Green")}`, id: "charts.green" },
  { label: `$(circle-filled) ${t("Bright green")}`, id: "terminal.ansiBrightGreen" },
  { label: `$(circle-filled) ${t("Yellow")}`, id: "charts.yellow" },
  { label: `$(circle-filled) ${t("Orange")}`, id: "charts.orange" },
  { label: `$(circle-filled) ${t("Red")}`, id: "charts.red" },
  { label: `$(circle-filled) ${t("Bright red")}`, id: "terminal.ansiBrightRed" },
  { label: `$(circle-filled) ${t("Magenta")}`, id: "terminal.ansiMagenta" },
  { label: `$(circle-filled) ${t("Pink")}`, id: "terminal.ansiBrightMagenta" },
  { label: `$(circle-filled) ${t("Purple")}`, id: "charts.purple" },
  { label: `$(circle-filled) ${t("Gray")}`, id: "descriptionForeground" },
  { label: `$(circle-outline) ${t("Default")}`, id: "" },
];

// VS Code convention: application/vnd.code.tree.<viewId lowercased>
const SESSION_MIME = "application/vnd.code.tree.claudesessionfolders.tree";

const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const metaCache = new Map();

function claudeDir() {
  const raw = vscode.workspace
    .getConfiguration("claudeSessionFolders")
    .get("claudeDir", "~/.claude");
  return raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
}

function storePath() {
  return path.join(claudeDir(), "chat-folders.json");
}

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    return {
      folders: Array.isArray(data.folders) ? data.folders : [],
      assignments:
        data.assignments && typeof data.assignments === "object" ? data.assignments : {},
    };
  } catch {
    return { folders: [], assignments: {} };
  }
}

function saveStore(store) {
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8");
}

function readSessionMeta(file) {
  return new Promise((resolve) => {
    const meta = { title: null, customTitle: null, cwd: null, firstUser: null };
    let bytes = 0;
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const finish = () => resolve(meta);
    rl.on("line", (line) => {
      bytes += line.length + 1;
      if (line.charCodeAt(0) === 123) {
        if (line.includes('"ai-title"')) {
          try {
            const d = JSON.parse(line);
            if (d.aiTitle) meta.title = d.aiTitle;
          } catch {}
        } else if (line.includes('"custom-title"') || line.includes('"customTitle"')) {
          try {
            const d = JSON.parse(line);
            if (d.customTitle) meta.customTitle = d.customTitle;
            else if (d.title) meta.customTitle = d.title;
          } catch {}
        } else if (line.includes('"type":"summary"')) {
          try {
            const d = JSON.parse(line);
            if (d.summary && !meta.title) meta.title = d.summary;
          } catch {}
        }
        if ((!meta.cwd || !meta.firstUser) && line.includes('"cwd"')) {
          try {
            const d = JSON.parse(line);
            if (d.cwd && !meta.cwd) meta.cwd = d.cwd;
            if (!meta.firstUser && d.type === "user" && d.message) {
              const c = d.message.content;
              let text = null;
              if (typeof c === "string") text = c;
              else if (Array.isArray(c)) {
                const t = c.find((x) => x && x.type === "text" && x.text);
                if (t) text = t.text;
              }
              if (text && !text.startsWith("<")) {
                meta.firstUser = text.replace(/\s+/g, " ").trim().slice(0, 80);
              }
            }
          } catch {}
        }
      }
      if (bytes > MAX_SCAN_BYTES && meta.cwd && (meta.title || meta.firstUser)) {
        rl.close();
        stream.destroy();
      }
    });
    rl.on("close", finish);
    stream.on("error", finish);
  });
}

function listSessionIds() {
  const projectsDir = path.join(claudeDir(), "projects");
  const ids = new Set();
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return ids;
  }
  for (const e of dirs) {
    try {
      for (const f of fs.readdirSync(path.join(projectsDir, e.name))) {
        if (f.endsWith(".jsonl")) ids.add(f.slice(0, -6));
      }
    } catch {}
  }
  return ids;
}

async function scanSessions() {
  const projectsDir = path.join(claudeDir(), "projects");
  const onlyCurrent = vscode.workspace
    .getConfiguration("claudeSessionFolders")
    .get("onlyCurrentProject", false);
  const workspacePath =
    vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : null;

  let projectDirs;
  try {
    projectDirs = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(projectsDir, e.name));
  } catch {
    return [];
  }

  const sessions = [];
  for (const dir of projectDirs) {
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.size < 200) continue;

      const cached = metaCache.get(file);
      let meta;
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        meta = cached.meta;
      } else {
        meta = await readSessionMeta(file);
        metaCache.set(file, { mtimeMs: stat.mtimeMs, meta });
      }

      const cwd = meta.cwd || "";
      if (onlyCurrent && workspacePath && cwd && cwd !== workspacePath) continue;

      sessions.push({
        id: f.replace(".jsonl", ""),
        title:
          meta.customTitle || meta.title || meta.firstUser || f.replace(".jsonl", "").slice(0, 8),
        firstUser: meta.firstUser || "",
        cwd,
        file,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

function relativeTime(ms) {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

const DAY_BUCKETS = [
  ["0", t("Today")],
  ["1", t("Yesterday")],
  ["2", t("This week")],
  ["3", t("This month")],
  ["4", t("Older")],
];

function dayBucket(ms) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const weekday = (now.getDay() + 6) % 7; // Monday = 0
  const startWeek = startToday - weekday * day;
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (ms >= startToday) return { key: "0", label: "Today" };
  if (ms >= startToday - day) return { key: "1", label: "Yesterday" };
  if (ms >= startWeek) return { key: "2", label: "This week" };
  if (ms >= startMonth) return { key: "3", label: "This month" };
  return { key: "4", label: "Older" };
}

class SessionTreeProvider {
  constructor(context) {
    this.context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.sessions = [];
  }

  get groupMode() {
    return this.context.globalState.get("groupMode", "folders");
  }

  modeLabel() {
    if (this.groupMode === "days") return t("Dates");
    if (this.groupMode === "foldersDates") return t("Folders + dates");
    return t("Folders");
  }

  async toggleGroupMode() {
    const order = ["folders", "foldersDates", "days"];
    const next = order[(order.indexOf(this.groupMode) + 1) % order.length];
    await this.context.globalState.update("groupMode", next);
    if (this.tree) this.tree.description = this.modeLabel();
    this.refresh(false);
  }

  refresh(rescan = true) {
    if (rescan) this._pending = null;
    this._onDidChangeTreeData.fire();
  }

  async loadSessions() {
    if (!this._pending) this._pending = scanSessions();
    this.sessions = await this._pending;
    return this.sessions;
  }

  getTreeItem(element) {
    return element;
  }

  // --- Drag & drop: sessions onto folders / Unfiled ---
  get dropMimeTypes() {
    return [SESSION_MIME];
  }

  get dragMimeTypes() {
    return [SESSION_MIME];
  }

  handleDrag(sourceItems, dataTransfer) {
    const payload = {
      sessions: sourceItems.filter((i) => i.session).map((i) => i.session.id),
      folders: sourceItems.filter((i) => i.kind === "folder").map((i) => i.folderId),
    };
    if (payload.sessions.length || payload.folders.length) {
      dataTransfer.set(SESSION_MIME, new vscode.DataTransferItem(payload));
    }
  }

  async handleDrop(target, dataTransfer) {
    const item = dataTransfer.get(SESSION_MIME);
    if (!item || !target) return;
    let payload = item.value;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (Array.isArray(payload)) payload = { sessions: payload, folders: [] };
    const ids = payload.sessions || [];
    const folderMoves = payload.folders || [];

    // Reorder folders: dragged folders are inserted before the target folder
    // (or moved to the end when dropped on Unfiled).
    if (folderMoves.length && !ids.length) {
      if (target.kind !== "folder" && target.kind !== "unfiled") return;
      const store = loadStore();
      const moving = store.folders.filter(
        (f) => folderMoves.includes(f.id) && f.id !== target.folderId
      );
      if (!moving.length) return;
      store.folders = store.folders.filter((f) => !moving.includes(f));
      const idx =
        target.kind === "folder"
          ? store.folders.findIndex((f) => f.id === target.folderId)
          : -1;
      store.folders.splice(idx < 0 ? store.folders.length : idx, 0, ...moving);
      saveStore(store);
      this.refresh(false);
      return;
    }
    if (!ids.length) return;

    const store = loadStore();
    let folderId = null;
    if (target.kind === "folder") folderId = target.folderId;
    else if (target.kind === "folderDay") folderId = target.folderId;
    else if (target.kind === "unfiled") folderId = null;
    else if (target.kind === "session") folderId = store.assignments[target.session.id] || null;
    else return; // day buckets are not drop targets

    for (const id of ids) {
      if (folderId) store.assignments[id] = folderId;
      else delete store.assignments[id];
    }
    saveStore(store);
    this.refresh(false);
  }

  async getChildren(element) {
    const store = loadStore();

    if (!element) {
      await this.loadSessions();
      return this.groupMode === "days" ? this._dayRoots() : this._folderRoots(store);
    }
    if (element.kind === "folder" || element.kind === "unfiled") {
      const fid = element.kind === "folder" ? element.folderId : null;
      const sessions = this._sessionsOfFolder(store, fid);
      if (this.groupMode === "foldersDates") return this._folderDayRoots(sessions, fid);
      return sessions.map((s) => this._sessionItem(s, { inFolder: !!fid }));
    }
    if (element.kind === "folderDay") {
      return this._sessionsOfFolder(store, element.folderId)
        .filter((s) => dayBucket(s.mtimeMs).key === element.bucketKey)
        .map((s) => this._sessionItem(s, { inFolder: !!element.folderId }));
    }
    if (element.kind === "day") {
      return this.sessions
        .filter((s) => dayBucket(s.mtimeMs).key === element.bucketKey)
        .map((s) => {
          const folder = store.folders.find((f) => f.id === store.assignments[s.id]);
          return this._sessionItem(s, { inFolder: !!folder, folderName: folder && folder.name });
        });
    }
    return [];
  }

  _sessionsOfFolder(store, fid) {
    if (fid) return this.sessions.filter((s) => store.assignments[s.id] === fid);
    return this.sessions.filter((s) => !store.assignments[s.id]);
  }

  _folderDayRoots(sessions, fid) {
    const counts = {};
    for (const s of sessions) {
      const key = dayBucket(s.mtimeMs).key;
      counts[key] = (counts[key] || 0) + 1;
    }
    return DAY_BUCKETS.filter(([key]) => counts[key]).map(([key, label]) => {
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
      item.kind = "folderDay";
      item.folderId = fid;
      item.bucketKey = key;
      item.description = String(counts[key]);
      item.iconPath = new vscode.ThemeIcon("history");
      return item;
    });
  }

  _folderRoots(store) {
    if (!store.folders.length) return []; // empty tree -> viewsWelcome kicks in
    const counts = {};
    for (const s of this.sessions) {
      const fid = store.assignments[s.id];
      if (fid) counts[fid] = (counts[fid] || 0) + 1;
    }
    // store.folders array order IS the display order (drag folders to reorder)
    const items = store.folders
      .slice()
      .map((f) => {
        const item = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.kind = "folder";
        item.folderId = f.id;
        item.contextValue = "folder";
        item.description = String(counts[f.id] || 0);
        item.iconPath = f.color
          ? new vscode.ThemeIcon("folder", new vscode.ThemeColor(f.color))
          : new vscode.ThemeIcon("folder");
        return item;
      });
    const unfiledCount = this.sessions.filter((s) => !store.assignments[s.id]).length;
    const unfiled = new vscode.TreeItem(
      t("Unfiled"),
      unfiledCount ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    unfiled.kind = "unfiled";
    unfiled.description = String(unfiledCount);
    unfiled.iconPath = new vscode.ThemeIcon("inbox");
    items.push(unfiled);
    return items;
  }

  _dayRoots() {
    const counts = {};
    for (const s of this.sessions) {
      const key = dayBucket(s.mtimeMs).key;
      counts[key] = (counts[key] || 0) + 1;
    }
    return DAY_BUCKETS.map(([key, label]) => {
      const count = counts[key] || 0;
      const item = new vscode.TreeItem(
        label,
        !count
          ? vscode.TreeItemCollapsibleState.None
          : key === "0"
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
      );
      item.kind = "day";
      item.bucketKey = key;
      item.description = String(count);
      item.iconPath = new vscode.ThemeIcon("calendar");
      return item;
    });
  }

  _sessionItem(s, { inFolder, folderName }) {
    const item = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.None);
    item.kind = "session";
    item.session = s;
    item.contextValue = inFolder ? "sessionInFolder" : "session";
    item.description = folderName
      ? `${folderName} · ${relativeTime(s.mtimeMs)}`
      : relativeTime(s.mtimeMs);
    const preview = s.firstUser && s.firstUser !== s.title ? `\n“${s.firstUser}”` : "";
    item.tooltip = `${s.title}${preview}\n\n${s.cwd || "?"}\n${new Date(s.mtimeMs).toLocaleString()}\nid: ${s.id}`;
    item.iconPath = new vscode.ThemeIcon("comment-discussion");
    item.command = {
      command: "claudeSessionFolders.resumeSession",
      title: "Resume session",
      arguments: [item],
    };
    return item;
  }
}

async function pickOrCreateFolder(store) {
  const picks = store.folders.map((f) => ({ label: `$(folder) ${f.name}`, folder: f }));
  picks.push({ label: `$(add) ${t("New folder…")}` });
  const choice = await vscode.window.showQuickPick(picks, { placeHolder: t("Move to folder…") });
  if (!choice) return null;
  return choice.folder || createFolderInteractive(store);
}

async function createFolderInteractive(store) {
  const name = await vscode.window.showInputBox({ prompt: t("Folder name") });
  if (!name) return null;
  const color = await vscode.window.showQuickPick(COLORS, { placeHolder: t("Folder color") });
  const folder = {
    id: `f-${Math.random().toString(36).slice(2, 10)}`,
    name: name.trim(),
    color: color ? color.id : "",
  };
  store.folders.push(folder);
  saveStore(store);
  return folder;
}

function activate(context) {
  const provider = new SessionTreeProvider(context);
  const tree = vscode.window.createTreeView("claudeSessionFolders.tree", {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: provider,
  });
  provider.tree = tree;
  tree.description = provider.modeLabel();
  context.subscriptions.push(tree);

  const cmd = (name, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, fn));

  cmd("claudeSessionFolders.refresh", () => provider.refresh());
  cmd("claudeSessionFolders.toggleGrouping", () => provider.toggleGroupMode());

  cmd("claudeSessionFolders.newFolder", async () => {
    const store = loadStore();
    if (await createFolderInteractive(store)) provider.refresh(false);
  });

  cmd("claudeSessionFolders.assignToFolder", async (item) => {
    if (!item || !item.session) return;
    const store = loadStore();
    const folder = await pickOrCreateFolder(store);
    if (!folder) return;
    store.assignments[item.session.id] = folder.id;
    saveStore(store);
    provider.refresh(false);
  });

  cmd("claudeSessionFolders.removeFromFolder", (item) => {
    if (!item || !item.session) return;
    const store = loadStore();
    delete store.assignments[item.session.id];
    saveStore(store);
    provider.refresh(false);
  });

  cmd("claudeSessionFolders.newSession", () =>
    vscode.commands.executeCommand("claude-vscode.newConversation")
  );

  let pendingCapture = null;
  context.subscriptions.push({
    dispose: () => pendingCapture && clearInterval(pendingCapture),
  });

  cmd("claudeSessionFolders.newSessionInFolder", async (item) => {
    if (!item || item.kind !== "folder") return;
    const folderId = item.folderId;
    const folder = loadStore().folders.find((f) => f.id === folderId);
    if (!folder) return;
    const known = listSessionIds();
    await vscode.commands.executeCommand("claude-vscode.newConversation");
    if (pendingCapture) clearInterval(pendingCapture);
    const startedAt = Date.now();
    // The new transcript appears once the conversation actually starts; watch
    // for an unknown session id and file it into the chosen folder.
    pendingCapture = setInterval(() => {
      if (Date.now() - startedAt > 2 * 60 * 1000) {
        clearInterval(pendingCapture);
        pendingCapture = null;
        return;
      }
      for (const id of listSessionIds()) {
        if (known.has(id)) continue;
        clearInterval(pendingCapture);
        pendingCapture = null;
        const store = loadStore();
        store.assignments[id] = folderId;
        saveStore(store);
        provider.refresh();
        vscode.window.setStatusBarMessage(t('Chat filed into "{0}"', folder.name), 5000);
        return;
      }
    }, 2000);
    vscode.window.setStatusBarMessage(t('The next new chat will be filed into "{0}"', folder.name), 8000);
  });

  cmd("claudeSessionFolders.resumeSession", async (item) => {
    if (!item || !item.session) return;
    const s = item.session;
    try {
      // Open inside the official Claude Code panel (same UI as its session list)
      await vscode.commands.executeCommand("claude-vscode.primaryEditor.open", s.id);
    } catch {
      // Fallback if the official extension is not installed
      const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : os.homedir();
      const terminal = vscode.window.createTerminal({
        name: `Claude · ${s.title.slice(0, 30)}`,
        cwd,
      });
      terminal.show();
      terminal.sendText(`claude --resume ${s.id}`);
    }
  });

  cmd("claudeSessionFolders.renameFolder", async (item) => {
    if (!item || item.kind !== "folder") return;
    const store = loadStore();
    const folder = store.folders.find((f) => f.id === item.folderId);
    if (!folder) return;
    const name = await vscode.window.showInputBox({ prompt: t("New name"), value: folder.name });
    if (!name) return;
    folder.name = name.trim();
    saveStore(store);
    provider.refresh(false);
  });

  cmd("claudeSessionFolders.setFolderColor", async (item) => {
    if (!item || item.kind !== "folder") return;
    const store = loadStore();
    const folder = store.folders.find((f) => f.id === item.folderId);
    if (!folder) return;
    const color = await vscode.window.showQuickPick(COLORS, { placeHolder: t("Folder color") });
    if (!color) return;
    folder.color = color.id;
    saveStore(store);
    provider.refresh(false);
  });

  cmd("claudeSessionFolders.deleteFolder", async (item) => {
    if (!item || item.kind !== "folder") return;
    const store = loadStore();
    const folder = store.folders.find((f) => f.id === item.folderId);
    if (!folder) return;
    const deleteLabel = t("Delete");
    const ok = await vscode.window.showWarningMessage(
      t('Delete folder "{0}"? (sessions are NOT deleted, only the folder)', folder.name),
      { modal: true },
      deleteLabel
    );
    if (ok !== deleteLabel) return;
    store.folders = store.folders.filter((f) => f.id !== folder.id);
    for (const [sid, fid] of Object.entries(store.assignments)) {
      if (fid === folder.id) delete store.assignments[sid];
    }
    saveStore(store);
    provider.refresh(false);
  });

  const interval = setInterval(() => provider.refresh(), 120000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

function deactivate() {}

module.exports = { activate, deactivate };
