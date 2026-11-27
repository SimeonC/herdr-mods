// New Task: search running sessions, GitHub PRs, worktrees and local projects,
// then start an agent in the chosen checkout (creating a worktree when needed).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import {
  spaces, agents, panes, run, theme, props, closeOverlay, exec, hc, home, appHome,
  readTextFile, writeTextFile, knownAgents, shared, setShared, checking, nextCommand,
} from "herdr";
import * as fs from "fs/promises";

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const DEV_ROOT = () => `${home()}/Development`;

const own = (el) =>
  el.on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_down("right", (_e, cx) => cx.stop_propagation());

function clean(s) {
  return (s ?? "")
    .replace(/^(?:\[ [!.] \] |[✋⏳]️?(?=\s)|(?!(?:\p{Emoji}️|[#*]⃣))[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}])+/u, "")
    .trim();
}

function slug(branch) {
  const normalized = (branch ?? "").normalize("NFC").toLowerCase();
  const name = normalized.replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  return name || "branch";
}

// Filler that says nothing about the change, so a branch made from the task
// text starts with its subject instead of "i-want-to".
const BRANCH_STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "in", "on", "of", "and", "or", "with",
  "from", "by", "at", "into", "that", "this", "it", "is", "are", "be",
  "so", "we", "i", "you", "should", "please", "can", "could", "would",
  "need", "needs", "want", "then", "when", "while", "as", "up", "out",
]);

/// A task's name is its command, short enough for a chip.
function taskNameFromCommand(command) {
  const one = (command ?? "").replace(/\s+/g, " ").trim();
  return one.length > 30 ? `${one.slice(0, 29).trimEnd()}…` : one;
}

/// One shell argument, quoted for the fish command line tasks run through.
function shellQuote(text) {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

/// A branch name from the task text: its first few meaningful words, so the
/// person types the task once and never has to name the branch.
function branchFromTask(task) {
  const words = (task ?? "").normalize("NFC").toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const kept = [];
  for (const word of words) {
    if (BRANCH_STOPWORDS.has(word)) continue;
    kept.push(word);
    if (kept.length >= 5 || kept.join("-").length >= 36) break;
  }
  return slug(kept.join("-")).slice(0, 48).replace(/-+$/, "");
}

function expandHome(p) {
  const h = home().replace(/\/$/, "");
  return p === "~" ? h : p.startsWith("~/") ? h + p.slice(1) : p;
}

function githubRepo(url) {
  if (!url) return null;
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function parsePr(text) {
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(text);
  if (m) return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
  m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(text);
  if (m) return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
  return null;
}

// Herdr's tab.new wraps the program in a login shell that stays open, leaving
// a prompt after an agent exits. Start a labelled core terminal instead: Herdr
// shows it as a tab and closes it when the program exits.
const randomId = (prefix) =>
  prefix + Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

// exec replaces the login shell, so the login profile loads but the terminal
// ends with the agent rather than a shell.
const agentCommand = (argv) => ["fish", "-lic", "exec $argv[2..]", "fish", ...argv];

function fuzzy(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const s = (text ?? "").toLowerCase();
  const at = s.indexOf(q);
  if (at >= 0) return 1000 - at;
  let total = 0, from = 0, last = -1;
  for (const ch of q) {
    const i = s.indexOf(ch, from);
    if (i < 0) return -1;
    total += i === last + 1 ? 8 : 2;
    if (i === 0 || /[\s/._:#-]/.test(s[i - 1])) total += 6;
    last = i;
    from = i + 1;
  }
  return total - s.length * 0.01;
}

async function sh(cmd, args, opts = {}) {
  try {
    const r = await exec(cmd, args, { timeout: 30000, ...opts });
    return {
      ok: r.code === 0,
      code: r.code,
      out: (r.stdout ?? "").trim(),
      err: (r.stderr ?? r.stdout ?? "").trim(),
    };
  } catch (e) {
    return { ok: false, code: -1, out: "", err: String(e?.message ?? e) };
  }
}

// Extra project roots from projects.json: a root may be a checkout itself
// (~/.config/fish) or a folder of checkouts (~/.talon/user).
async function extraRoots() {
  try {
    const raw = await readTextFile(`${appHome()}/projects.json`);
    const roots = raw ? JSON.parse(raw)?.roots : null;
    return (Array.isArray(roots) ? roots : [])
      .filter((root) => typeof root === "string" && root.trim())
      .map((root) => expandHome(root.trim()).replace(/\/+$/, ""));
  } catch {
    return [];
  }
}

// Base-branch overrides from bases.json, keyed by GitHub repo ("owner/name"),
// project folder name or checkout path. A repo whose mainline is not the
// GitHub default branch (e.g. booking-form's v3) sets its base here.
async function loadBases() {
  try {
    const raw = await readTextFile(`${appHome()}/bases.json`);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function applyBaseOverrides(projects, bases) {
  if (!bases || typeof bases !== "object") return projects;
  await Promise.all(projects.map(async (project) => {
    const raw = bases[project.repo] ?? bases[project.name] ?? bases[project.path];
    if (typeof raw !== "string" || !raw.trim()) return;
    project.base = await resolveBase(project, raw.trim());
  }));
  return projects;
}

// "origin/v3" passes through; "v3" becomes the remote-tracking branch when it
// exists, else the local branch of that name.
async function resolveBase(project, value) {
  if (value.includes("/")) return value;
  const remote = project.remote || "origin";
  const tracked = await sh("git", ["-C", project.path, "rev-parse", "--quiet", "--verify", `refs/remotes/${remote}/${value}`]);
  if (tracked.ok) return `${remote}/${value}`;
  const local = await sh("git", ["-C", project.path, "rev-parse", "--quiet", "--verify", `refs/heads/${value}`]);
  return local.ok ? value : `${remote}/${value}`;
}

// Remote branches for the picker, most recently committed first.
async function branchesFor(project) {
  const remote = project.remote || "origin";
  const r = await sh("git", [
    "-C", project.path, "for-each-ref", "--sort=-committerdate",
    "--format=%(refname:short)", `refs/remotes/${remote}`,
  ]);
  const prefix = `${remote}/`;
  const names = r.ok
    ? r.out.split("\n").map((l) => l.trim())
      .filter((n) => n.startsWith(prefix) && n !== `${prefix}HEAD`)
      .map((n) => n.slice(prefix.length))
    : [];
  if (names.length) return names.map((n) => prefix + n);
  // A local-only checkout: offer its local branches instead.
  const local = await sh("git", [
    "-C", project.path, "for-each-ref", "--sort=-committerdate",
    "--format=%(refname:short)", "refs/heads",
  ]);
  return local.ok ? local.out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

// Top-level git checkouts in ~/Development and the configured extra roots,
// with their GitHub repo when known.
async function scanProjects() {
  const dirs = [];
  const seenDirs = new Set();
  const add = (dir) => {
    if (!seenDirs.has(dir)) { seenDirs.add(dir); dirs.push(dir); }
  };
  for (const root of [DEV_ROOT(), ...await extraRoots()]) {
    const top = await sh("git", ["-C", root, "rev-parse", "--show-toplevel"]);
    if (top.ok) { add(top.out || root); continue; }
    let names;
    try {
      names = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      add(`${root}/${name}`);
    }
  }
  const out = [];
  await Promise.all(dirs.map(async (dir) => {
    const top = await sh("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    if (!top.ok) return;
    const remotes = await sh("git", ["-C", dir, "remote", "-v"]);
    let repo = null, remote = null;
    for (const line of remotes.out.split("\n")) {
      const [name, url] = line.split(/\s+/);
      if (!name || !url) continue;
      remote ??= name;
      if (name === "origin") { repo = githubRepo(url); if (repo) { remote = name; break; } }
    }
    if (!repo) {
      for (const line of remotes.out.split("\n")) {
        const [name, url] = line.split(/\s+/);
        repo = githubRepo(url);
        if (repo) { remote = name; break; }
      }
    }
    // A linked worktree checked out directly in ~/Development (not under the
    // worktrees directory) is not a project of its own: it belongs to the
    // checkout that owns its .git directory.
    const topPath = top.out || dir;
    const common = await sh("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const mainPath = common.ok && common.out.endsWith("/.git") ? common.out.slice(0, -5) : null;
    const linked = Boolean(mainPath) && mainPath !== topPath;
    const branch = await sh("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
    let base = null;
    const head = await sh("git", ["-C", dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (head.ok) base = head.out;
    if (!base) {
      const remoteBranches = await sh("git", ["-C", dir, "branch", "-r", "--list", "origin/main", "origin/develop"]);
      const names = remoteBranches.out.split("\n").map((l) => l.trim()).filter(Boolean);
      base = names.find((n) => n.endsWith("origin/main")) ?? names.find((n) => n.endsWith("origin/develop")) ?? null;
    }
    if (!base) {
      const localBranches = await sh("git", ["-C", dir, "branch", "--list", "main", "develop"]);
      const names = localBranches.out.split("\n").map((l) => l.trim().replace(/^\* /, "")).filter(Boolean);
      base = names[0] ?? "main";
    }
    out.push({ path: topPath, name: dir.split("/").at(-1), repo, remote, branch: branch.ok ? branch.out : null, base, linked, mainPath });
  }));
  // Keep a linked worktree only when its main checkout is outside the scan root.
  const paths = new Set(out.map((p) => p.path));
  return out
    .filter((p) => !(p.linked && paths.has(p.mainPath)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function scanWorktrees(projects) {
  const out = [];
  const seen = new Set();
  await Promise.all(projects.map(async (p) => {
    const r = await sh("git", ["-C", p.path, "worktree", "list", "--porcelain"]);
    if (!r.ok) return;
    for (const block of r.out.split(/\n\n+/)) {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
      if (!path || lines.includes("bare") || lines.some((l) => l.startsWith("prunable"))) continue;
      const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
      const key = `${p.repo ?? p.name}\u0000${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path, branch, repo: p.repo, repoName: p.name, main: path === p.path, mainPath: p.path });
    }
  }));
  return out;
}

async function ghSearch(args) {
  const r = await sh("gh", [
    "search", "prs", ...args,
    "--json", "number,title,repository,url,updatedAt,isDraft", "--limit", "100",
  ], { timeout: 30000 });
  if (!r.ok) return [];
  try {
    return JSON.parse(r.out).map((pr) => ({
      number: pr.number,
      title: pr.title,
      repo: pr.repository?.nameWithOwner ?? "",
      repoName: pr.repository?.name ?? "",
      url: pr.url,
      updatedAt: pr.updatedAt,
      draft: Boolean(pr.isDraft),
      branch: null,
      mine: true,
    }));
  } catch {
    return [];
  }
}

// Open PRs for every local repo, a few repos at a time. This is the slow source.
async function localPrs(projects) {
  const repos = [...new Set(projects.map((p) => p.repo).filter(Boolean))];
  const out = [];
  let next = 0;
  async function worker() {
    while (next < repos.length) {
      const repo = repos[next++];
      const r = await sh("gh", [
        "pr", "list", "--repo", repo, "--state", "open",
        "--json", "number,title,headRefName,url,updatedAt,isDraft", "--limit", "50",
      ], { timeout: 30000 });
      if (!r.ok) continue;
      try {
        for (const pr of JSON.parse(r.out)) {
          out.push({
            number: pr.number,
            title: pr.title,
            repo,
            repoName: repo.split("/")[1],
            url: pr.url,
            updatedAt: pr.updatedAt,
            draft: Boolean(pr.isDraft),
            branch: pr.headRefName,
            mine: false,
          });
        }
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, repos.length) }, worker));
  return out;
}

function mergePrs(...lists) {
  const map = new Map();
  for (const pr of lists.flat()) {
    const key = `${pr.repo}#${pr.number}`;
    const prev = map.get(key);
    if (!prev) map.set(key, pr);
    else map.set(key, { ...prev, ...pr, branch: pr.branch ?? prev.branch, title: pr.title || prev.title });
  }
  return [...map.values()];
}

function sessionRows() {
  const all = agents();
  const paneCwd = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p.cwd]));
  const out = [];
  for (const s of spaces()) {
    for (const tab of s.tabs) {
      const mine = all.filter((a) => a.tab === tab.id);
      const lead = mine[0];
      const title = tab.named
        ? tab.name
        : (lead ? clean(lead.title) || lead.program?.name : null) || `Tab ${tab.index}`;
      const who = mine.map((a) => a.program?.name ?? "agent").join(", ");
      out.push({
        kind: "session",
        key: `session:${tab.id}`,
        title,
        subtitle: `${s.name}${s.machine ? ` · ${s.machine}` : ""}${who ? ` · ${who}` : ""}`,
        status: tab.status,
        space: s.id,
        tab: tab.id,
        pane: lead?.pane ?? null,
        cwd: lead ? (paneCwd.get(lead.address) ?? null) : null,
        search: `${s.name} ${tab.name} ${mine.map((a) => `${a.title} ${a.program?.name}`).join(" ")}`,
      });
    }
  }
  return out;
}

function prRow(pr, groupTitle) {
  return {
    kind: "pr",
    key: `pr:${pr.repo}#${pr.number}`,
    title: pr.title,
    subtitle: `${pr.repo} #${pr.number}${pr.branch ? ` · ${pr.branch}` : ""}${pr.worktree ? " · worktree" : " · no checkout"}`,
    repo: pr.repo,
    repoName: pr.repoName,
    number: pr.number,
    branch: pr.branch,
    worktree: pr.worktree ?? null,
    draft: pr.draft,
    updatedAt: pr.updatedAt,
    nested: true,
    search: `${groupTitle} ${pr.title} ${pr.repo} ${pr.branch ?? ""} #${pr.number}`,
  };
}

function worktreeRow(w, groupTitle) {
  return {
    kind: "worktree",
    key: `wt:${w.path}`,
    title: w.branch ?? w.path.split("/").at(-1),
    subtitle: `${w.repoName ?? w.repo ?? ""} · ${w.path}`,
    path: w.path,
    branch: w.branch,
    repo: w.repo,
    repoName: w.repoName,
    nested: true,
    search: `${groupTitle} ${w.branch ?? ""} ${w.path} ${w.repo ?? ""}`,
  };
}

function newWorktreeRow(p, groupTitle) {
  return {
    kind: "new-worktree",
    key: `nw:${p.path}`,
    title: `New worktree from ${p.base ?? "main"}`,
    subtitle: `${p.name} · ${p.path}`,
    path: p.path,
    name: p.name,
    repo: p.repo,
    base: p.base ?? "main",
    nested: true,
    search: `${groupTitle} new worktree branch ${p.name} ${p.path} ${p.base ?? ""}`,
  };
}

function projectRow(p, groupTitle, main = false) {
  return {
    kind: "project",
    key: `pj:${p.path}`,
    title: main ? `Start in ${p.name}` : p.name,
    subtitle: `${p.path}${p.repo ? ` · ${p.repo}` : ""}`,
    path: p.path,
    name: p.name,
    repo: p.repo,
    nested: main,
    search: `${groupTitle} ${p.name} ${p.path} ${p.repo ?? ""}`,
  };
}

export default class NewTask extends View {
  init(_props, cx) {
    this.background = !props()?.overlay;
    this.filter = "";
    this.at = 0;
    this.chosen = null;
    this.manual = false;
    this.error = "";
    this.busy = false;
    this.loading = true;
    this.refreshing = false;
    this.projects = [];
    this.worktrees = [];
    this.prs = [];
    this.agents = [];
    this.agentKey = shared("new-task.agent") ?? "claude";
    this.scope = shared("new-task.scope") ?? "mine";
    this.mode = shared("new-task.mode") ?? "pr";
    this.mineKeys = new Set();
    this.tasks = {};
    this.action = "agent";
    this.composerFocus = false;
    this.runStop = null;
    this.scroll = ScrollHandle.new();
    this.baseOpen = false;
    this.baseBranches = [];
    this.baseAt = 0;
    this.baseLoading = false;
    this.baseScroll = ScrollHandle.new();

    // The layout keeps a zero-height copy alive to scan in the background and
    // write the cache the dialog opens from.
    if (this.background) {
      if (checking()) return;
      this.refresh(cx, true);
      cx.timer.every(5 * 60 * 1000, (cx) => this.refresh(cx, true));
      return;
    }

    this.input = InputState.new({ placeholder: "Search PRs, worktrees, projects or running sessions…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.activate(this.pickable()[this.at], cx));
    this.input.on("focus", () => { this.composerFocus = false; this.runStop = null; });

    const onPromptSubmit = (_e, cx) => this.primaryAction(cx);
    this.taskInput = InputState.new({ placeholder: "What should the agent do?" });
    this.taskInput.on("submit", onPromptSubmit);
    // A new worktree's branch is derived from this text, so re-render to keep
    // the preview current while it is typed, and make Enter submit again when
    // the person clicks back into the field after Tab moved to the base chip.
    this.taskInput.on("change", (_e, cx) => {
      if (this.chosen?.kind === "new-worktree") cx.notify();
    });
    this.taskInput.on("focus", () => {
      if (this.chosen?.kind === "new-worktree") this.runStop = "message";
    });
    this.trackComposerInput(this.taskInput);

    // A task marked `acceptsTask` gets this text as one more argument, so its
    // prompt says what the text is instead of asking for an agent task.
    this.extraInput = InputState.new({ placeholder: "Extra instructions (optional)" });
    this.extraInput.on("submit", onPromptSubmit);
    this.trackComposerInput(this.extraInput);

    // Terminal's text is optional: a command to run, or nothing for a shell.
    this.terminalInput = InputState.new({ placeholder: "Command to run (optional)" });
    this.terminalInput.on("submit", onPromptSubmit);
    this.trackComposerInput(this.terminalInput);

    this.taskCommandInput = InputState.new({ placeholder: "Command, e.g. pnpm dev" });
    this.taskCommandInput.on("submit", (_e, cx) => this.saveTask(cx));
    this.trackComposerInput(this.taskCommandInput);

    // Created once so the filter survives opens; the list reads its value on
    // every render.
    this.baseInput = InputState.new({ placeholder: "Filter branches…" });
    this.baseInput.on("change", (_e, cx) => {
      this.baseAt = 0;
      cx.notify();
    });
    this.baseInput.on("submit", (_e, cx) => {
      const options = this.baseOptions();
      const base = options[this.baseAt] ?? options[0];
      if (base) this.pickBase(base, cx);
    });
    this.baseInput.on("focus", () => { this.composerFocus = true; });

    this.manualInput = InputState.new({ placeholder: "PR URL, owner/repo#123, or folder path" });
    this.manualInput.on("submit", (_e, cx) => this.addManual(cx));
    this.manualInput.on("focus", () => { this.composerFocus = false; this.runStop = null; });

    this.handle = cx.focus_handle();
    // Tab goes through the app's keymap, not on_key_down: a focused text input
    // swallows it before the view sees the key, and a keymap binding is
    // dispatched before the focused element gets the keystroke. Inside the
    // composer it walks the Run row; anywhere else it cycles the modes.
    try {
      cx.bind_keys([
        { keystroke: "tab", action: "new_task_cycle_action", context: "NewTask" },
        { keystroke: "shift-tab", action: "new_task_cycle_action_back", context: "NewTask" },
        // A binding of our own wins over the app's overlay Escape, so this
        // closes the + Task form (or the composer) instead of the dialog.
        { keystroke: "escape", action: "new_task_cancel", context: "NewTask" },
      ]);
    } catch {}
    this.defineFocus = cx.focus_handle();
    this.createFocus = cx.focus_handle();
    this.saveFocus = cx.focus_handle();
    this.terminalFocus = cx.focus_handle();
    // Take the keyboard as the dialog opens, then give it to the search field.
    // Focusing the input before the overlay is mounted can fail, and until
    // something in this view has the keyboard the NewTask key context is not on
    // the focus path, so Tab would fall through to the terminal underneath.
    this.handle.focus();
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());

    const cache = shared("new-task.cache");
    if (cache?.projects && cache?.worktrees && cache?.prs) {
      this.projects = cache.projects;
      this.worktrees = cache.worktrees;
      this.prs = cache.prs;
      this.tasks = cache.tasks ?? {};
      this.cachedAt = cache.at;
      this.link();
      this.loading = false;
    }
    cx.spawn(async (cx) => {
      await this.loadTasks();
      cx.notify();
    });
    // Escape and any user rebinding still arrive as commands; Tab is handled by
    // the NewTask keymap bindings above.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (this.closed) break;
        if (command === "cycleAction" || command === "cycleMode") this.cycleTab(1, cx);
        else if (command === "cycleActionBack" || command === "cycleModeBack") this.cycleTab(-1, cx);
        else if (command === "cancel") this.cancel();
        cx.notify();
      }
    });
    if (checking()) return;
    cx.spawn(async (cx) => { await this.refresh(cx, true); });
  }

  close() {
    this.closed = true;
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  /// Escape closes the base picker, then the composer (including an open
  /// + Task form), the manual row and finally the dialog.
  cancel() {
    if (this.baseOpen) {
      this.baseInput.blur();
      this.baseOpen = false;
      this.taskInput.focus();
      return;
    }
    if (this.chosen) {
      this.chosen = null;
      this.action = "agent";
      this.composerFocus = false;
      this.runStop = null;
      this.input.focus();
      return;
    }
    if (this.manual) {
      this.manual = false;
      this.input.focus();
      return;
    }
    this.close();
  }

  cycleMode(direction) {
    const modes = ["session", "pr", "worktree", "new"];
    const at = modes.indexOf(this.mode);
    this.mode = modes[(at + direction + modes.length) % modes.length];
    setShared("new-task.mode", this.mode);
    this.at = 0;
  }

  trackComposerInput(state) {
    state.on("focus", () => {
      this.composerFocus = true;
    });
  }

  /// The Run row: the agent chip, the group's task chips, Terminal and + Task.
  /// A new worktree has only two stops: its base branch and its task text.
  runIds() {
    if (!this.chosen) return [];
    if (this.chosen.kind === "new-worktree") return ["base", "message"];
    return [...this.actionOptions(), "__terminal", "define"];
  }

  cycleRun(direction, cx) {
    const ids = this.runIds();
    if (!ids.length) return;
    let at = ids.indexOf(this.runStop);
    if (at < 0) at = direction > 0 ? -1 : 0;
    const next = ids[(at + direction + ids.length) % ids.length];
    this.composerFocus = true;
    this.runStop = next;
    if (next !== "define" && next !== "base" && next !== "message") this.action = next;
    if (next === "define") { if (cx) this.openDefine(cx); }
    else if (cx) this.focusPrompt(next, cx);
  }

  cycleBase(direction) {
    const options = this.baseOptions();
    if (!options.length) return;
    this.baseAt = (Math.min(this.baseAt, options.length - 1) + direction + options.length) % options.length;
  }

  /// Tab walks the Run row while the composer has the keyboard, cycles the
  /// base branches while the picker is open, and cycles PRs/Worktrees/New
  /// everywhere else. Focus stays in the text field so the next Tab still
  /// reaches keys.json.
  cycleTab(direction, cx) {
    if (this.baseOpen) this.cycleBase(direction);
    else if (this.chosen && this.composerFocus) this.cycleRun(direction, cx);
    else this.cycleMode(direction);
  }

  async refresh(cx, writeCache = false) {
    if (this.refreshing) return;
    this.refreshing = true;
    // Keep the highlighted row under the pointer as the lists fill in.
    const selectedKey = this.pickable()[this.at]?.key;
    const keepSelection = () => {
      if (!selectedKey) return;
      const index = this.pickable().findIndex((r) => r.key === selectedKey);
      if (index >= 0) this.at = index;
    };
    try {
      const [agentList, projects] = await Promise.all([
        knownAgents({}).catch(() => []),
        scanProjects(),
      ]);
      this.agents = agentList;
      this.projects = await applyBaseOverrides(projects, await loadBases());
      this.worktrees = await scanWorktrees(projects);
      this.loading = false;
      keepSelection();
      cx.notify();

      const [mine, assigned] = await Promise.all([
        ghSearch(["--author", "@me", "--state", "open"]),
        ghSearch(["--assignee", "@me", "--state", "open"]),
      ]);
      this.mineKeys = new Set([...mine, ...assigned].map((pr) => `${pr.repo}#${pr.number}`));
      this.prs = mergePrs(mine, assigned);
      this.link();
      keepSelection();
      cx.notify();

      const local = await localPrs(this.projects);
      this.prs = mergePrs(this.prs, local);
      for (const pr of this.prs) pr.mine = this.mineKeys.has(`${pr.repo}#${pr.number}`);
      this.link();
      keepSelection();
      this.cachedAt = Date.now();
      if (writeCache) {
        setShared("new-task.cache", {
          projects: this.projects,
          worktrees: this.worktrees,
          prs: this.prs,
          tasks: this.tasks,
          at: this.cachedAt,
        });
      }
      cx.notify();
    } catch (e) {
      this.error = String(e?.message ?? e);
      this.loading = false;
      cx.notify();
    } finally {
      this.refreshing = false;
    }
  }

  link() {
    const byBranch = new Map();
    for (const w of this.worktrees) {
      if (w.branch) byBranch.set(`${w.repo ?? ""}\u0000${w.branch}`, w);
    }
    for (const pr of this.prs) {
      pr.worktree = pr.branch ? (byBranch.get(`${pr.repo}\u0000${pr.branch}`) ?? null) : null;
    }
  }

  // Tasks live in `tasks.json`, keyed by group so each repo has its own set.
  // "*" holds global tasks, shown only when their requirement matches.
  async loadTasks() {
    try {
      const raw = await readTextFile(`${appHome()}/tasks.json`);
      const parsed = raw ? JSON.parse(raw) : {};
      this.tasks = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this.tasks = {};
    }
  }

  tasksFor(group) {
    const list = group ? this.tasks[group] : null;
    return Array.isArray(list) ? list.filter((t) => t?.name && t?.command) : [];
  }

  globalTasks(hasPR) {
    return (Array.isArray(this.tasks["*"]) ? this.tasks["*"] : [])
      .filter((t) => t?.name && t?.command && (!t.requiresPR || hasPR));
  }

  chosenGroup() {
    const c = this.chosen;
    if (!c) return null;
    if (c.kind === "project" || c.kind === "new-worktree") return c.name;
    if (c.kind === "worktree") return c.repoName ?? c.title;
    if (c.kind === "pr") {
      return this.projects.find((p) => p.repo === c.repo)?.name ?? c.repoName ?? null;
    }
    return null;
  }

  /// A PR row, or a worktree row whose branch belongs to a tracked PR.
  attachedPR() {
    const c = this.chosen;
    if (!c) return false;
    if (c.kind === "pr") return true;
    return c.kind === "worktree" && Boolean(c.pr);
  }

  spaceFor(path) {
    const target = path.replace(/\/+$/, "");
    return spaces().find((s) => {
      const tabs = new Set(s.tabs.map((t) => t.id));
      return panes().some((p) => tabs.has(p.tab) && p.cwd
        && (p.cwd === target || p.cwd.startsWith(target + "/")));
    });
  }

  /// Start `argv` as a labelled core terminal in the space holding `path`, so
  /// Herdr shows it as a tab and closes it when the program exits.
  async launch(cx, path, name, argv, task) {
    const space = this.spaceFor(path);
    const spaceId = space?.id ?? randomId("sp");
    const tabId = randomId("tb");
    const args = [
      "run", "--bg", "--no-parent", "--keep", "--cwd", path,
      "--label", `herdr.space=${spaceId}`, "--label", `herdr.tab=${tabId}`,
      "--", ...argv,
    ];
    if (task) args.push(task);
    const r = await hc(args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || "Could not start the terminal.");
    // Adoption is asynchronous; name the tab once Herdr has it.
    let shown = false;
    for (let i = 0; i < 10 && !shown; i++) {
      if (i) await cx.sleep(100);
      shown = Boolean(spaces().find((s) => s.id === spaceId)?.tabs.some((t) => t.id === tabId));
    }
    if (shown) {
      if (!space) run("space.rename", { id: spaceId, name });
      run("tab.rename", { id: tabId, name });
    }
  }

  /// Run a defined task in `path`. A task marked `acceptsTask` gets the typed
  /// text as one more argument.
  async startCommand(cx, path, name, command, text = "") {
    const line = text ? `${command} ${shellQuote(text)}` : command;
    await this.launch(cx, path, name, ["fish", "-lc", line]);
    this.close();
  }

  async runTask(cx, task, text = "") {
    const c = this.chosen;
    if (!c) return;
    let path = c.path;
    if (c.kind === "pr") {
      let repo = this.projects.find((p) => p.repo === c.repo);
      if (!repo) repo = await this.cloneRepo(c.repo);
      const wt = await this.ensureWorktree(c, repo);
      path = wt.path;
    }
    if (!path) throw new Error("Choose a checkout to run this task in.");
    await this.startCommand(cx, path, task.name, task.command, task.acceptsTask ? text : "");
  }

  /// A shell in `path`, in the space already holding it, running `command`
  /// first when there is one.
  startShell(path, command = "") {
    const space = this.spaceFor(path);
    const args = { folder: path };
    if (command) args.argv = ["fish", "-lc", command];
    if (space) run("tab.new", { ...args, space: space.id });
    else run("space.new", args);
    this.close();
  }

  /// The checkout for the chosen row, creating it first when it has none.
  async checkoutFor(target, task) {
    if (target.kind === "pr") {
      let repo = this.projects.find((p) => p.repo === target.repo);
      if (!repo) repo = await this.cloneRepo(target.repo);
      return (await this.ensureWorktree(target, repo)).path;
    }
    if (target.kind === "new-worktree") {
      if (!task) throw new Error("Describe the task: its words name the branch.");
      const repo = this.projects.find((p) => p.path === target.path || (target.repo && p.repo === target.repo));
      if (!repo) throw new Error("Project not found.");
      return (await this.createWorktree(repo, branchFromTask(task), target.base)).path;
    }
    return target.path;
  }

  /// Open a terminal in the chosen row's checkout without starting an agent,
  /// running `command` first when one was typed.
  openTerminal(cx, command = "") {
    if (!this.chosen || this.busy) return;
    const target = this.chosen;
    const task = this.promptValue().trim();
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const path = await this.checkoutFor(target, task);
        if (!path) throw new Error("Choose a checkout to open a terminal in.");
        this.startShell(path, command);
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  saveTask(cx) {
    const group = this.chosenGroup();
    const command = this.taskCommandInput.value().trim();
    const name = taskNameFromCommand(command);
    if (!group) {
      this.error = "Choose a project first.";
      cx.notify();
      return;
    }
    if (!command) {
      this.error = "Enter a command.";
      cx.notify();
      return;
    }
    if (this.busy) return;
    this.error = "";
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const path = `${appHome()}/tasks.json`;
        const raw = await readTextFile(path);
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch {}
        if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
        const list = (Array.isArray(data[group]) ? data[group] : []).filter((t) => t?.name !== name);
        list.push({ name, command });
        data[group] = list;
        await writeTextFile(path, JSON.stringify(data, null, 2) + "\n", raw ?? null);
        this.tasks = data;
        // Run it now; a failure leaves the form open with the task saved.
        await this.runTask(cx, { name, command });
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  pickable() {
    return this.rows().filter((r) => r.kind !== "head");
  }

  rows() {
    const q = this.filter.trim();
    const out = [];

    // Running tabs have their own tab, so the other lists hold still.
    if (this.mode === "session") {
      const sessions = sessionRows()
        .map((r) => ({ ...r, score: fuzzy(q, r.search) }))
        .filter((r) => r.score >= 0);
      sessions.sort((a, b) =>
        b.score - a.score ||
        (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) ||
        a.title.localeCompare(b.title));
      if (sessions.length) out.push(...sessions);
      else out.push({ kind: "head", title: "No running sessions" });
      return out;
    }

    // Group by git repository: the main checkout path is the identity.
    // GitHub's owner/repo is display only and maps a PR back to its checkout.
    const groups = new Map();
    const groupFor = (key, title, subtitle) => {
      if (!groups.has(key)) {
        groups.set(key, { key, title, subtitle, project: null, prs: [], worktrees: [] });
      }
      return groups.get(key);
    };
    // One checkout per GitHub repo: the main checkout wins over a linked worktree.
    const projectByRepo = new Map();
    for (const p of this.projects) {
      if (!p.repo) continue;
      const prev = projectByRepo.get(p.repo);
      if (!prev || (prev.linked && !p.linked)) projectByRepo.set(p.repo, p);
    }

    for (const p of this.projects) {
      const g = groupFor(p.path, p.name, p.repo ? `${p.repo} · ${p.path}` : p.path);
      g.project = p;
    }
    for (const pr of this.prs) {
      const project = projectByRepo.get(pr.repo);
      const key = project?.path ?? `gh:${pr.repo}`;
      const title = project?.name ?? pr.repoName ?? pr.repo.split("/")[1];
      const subtitle = pr.repo + (project ? ` · ${project.path}` : " · not checked out");
      const g = groupFor(key, title, subtitle);
      if (project && !g.project) g.project = project;
      g.prs.push(pr);
    }
    for (const w of this.worktrees) {
      if (w.main) continue;
      const key = w.mainPath ?? w.repo ?? w.path;
      const project = this.projects.find((p) => p.path === w.mainPath);
      const title = project?.name ?? w.repoName ?? w.repo?.split("/")[1] ?? w.path.split("/").at(-1);
      const subtitle = w.repo ? `${w.repo} · ${w.mainPath ?? w.path}` : (w.mainPath ?? w.path);
      const g = groupFor(key, title, subtitle);
      if (project && !g.project) g.project = project;
      g.worktrees.push(w);
    }

    const grouped = [];
    for (const g of groups.values()) {
      let rows = [];
      let counts = "";
      if (this.mode === "pr") {
        const scoped = this.scope === "mine" ? g.prs.filter((pr) => pr.mine) : g.prs;
        const prs = scoped
          .map((pr) => ({ ...prRow(pr, g.title), score: fuzzy(q, `${g.title} ${pr.title} ${pr.repo} ${pr.branch ?? ""} #${pr.number}`) }))
          .filter((r) => r.score >= 0);
        // Newest PR number first, so a refresh that changes updatedAt cannot
        // reorder the list under the pointer.
        prs.sort((a, b) =>
          b.score - a.score ||
          (b.number ?? 0) - (a.number ?? 0) ||
          a.title.localeCompare(b.title));
        rows = prs;
        counts = `${prs.length} PR${prs.length === 1 ? "" : "s"}`;
      } else if (this.mode === "worktree") {
        const wts = g.worktrees
          .map((w) => {
            const pr = g.prs.find((p) => p.worktree?.path === w.path) ?? null;
            return {
              ...worktreeRow(w, g.title),
              pr: pr ? { number: pr.number, title: pr.title } : null,
              score: fuzzy(q, `${g.title} ${w.branch ?? ""} ${w.path} ${w.repo ?? ""} ${pr ? `#${pr.number} ${pr.title}` : ""}`),
            };
          })
          .filter((r) => r.score >= 0);
        wts.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
        rows = wts;
        counts = `${wts.length} worktree${wts.length === 1 ? "" : "s"}`;
      } else {
        if (!g.project) continue;
        const nw = { ...newWorktreeRow(g.project, g.title), score: fuzzy(q, `new worktree branch ${g.title} ${g.project.path} ${g.project.base ?? ""}`) };
        const start = { ...projectRow(g.project, g.title, true), score: fuzzy(q, `${g.title} ${g.project.path} ${g.project.repo ?? ""}`) };
        const tasks = this.tasksFor(g.title).map((t) => ({
          kind: "task",
          key: `task:${g.title}:${t.name}`,
          title: t.name,
          subtitle: t.command,
          path: g.project.path,
          group: g.title,
          command: t.command,
          nested: true,
          score: fuzzy(q, `${g.title} ${t.name} ${t.command}`),
        })).filter((r) => r.score >= 0);
        rows = [nw, start, ...tasks].filter((r) => r.score >= 0);
        counts = tasks.length ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}` : "";
      }
      if (!rows.length) continue;
      grouped.push({ g, rows, counts, score: Math.max(...rows.map((r) => r.score), 0) });
    }
    // Alphabetical when nothing is typed, so a background refresh cannot
    // shuffle the groups.
    grouped.sort((a, b) =>
      b.score - a.score ||
      a.g.title.localeCompare(b.g.title));
    for (const { g, rows, counts } of grouped) {
      out.push({ kind: "head", title: g.title, subtitle: g.subtitle, counts, group: true });
      out.push(...rows);
    }

    out.push({ kind: "manual" });
    return out;
  }

  activate(row, cx) {
    if (!row) return;
    if (row.kind === "session") {
      this.close();
      if (row.pane) run("pane.focus", { pane: row.pane });
      else {
        run("space.select", { id: row.space });
        run("tab.select", { id: row.tab });
      }
      return;
    }
    if (row.kind === "manual") {
      this.manual = true;
      this.manualInput.focus();
      cx.notify();
      return;
    }
    if (row.kind === "task") {
      cx.spawn(async (cx) => {
        try {
          this.chosen = row;
          await this.runTask(cx, row);
        } catch (e) {
          this.error = String(e?.message ?? e);
          cx.notify();
        }
      });
      return;
    }
    this.chosen = row;
    this.action = "agent";
    this.composerFocus = true;
    this.baseOpen = false;
    // The first Tab moves off the stop that is already selected: the task text
    // for a new worktree, the action otherwise.
    this.runStop = row.kind === "new-worktree" ? "message" : "agent";
    this.taskInput.focus();
    cx.notify();
  }

  /// Base-branch picker for a new worktree: the repo's default from
  /// bases.json, changeable for this run only. Tab cycles the branches,
  /// Enter picks the highlighted one and Esc closes the picker.
  toggleBase(cx) {
    this.setBaseOpen(!this.baseOpen, cx);
  }

  setBaseOpen(open, cx) {
    if (this.chosen?.kind !== "new-worktree" || open === this.baseOpen) return;
    this.baseOpen = open;
    if (open) {
      this.runStop = "base";
      this.composerFocus = true;
      this.taskInput.blur();
      this.baseInput.set_value("");
      this.baseBranches = [];
      this.baseAt = 0;
      this.loadBaseBranches(cx);
      // Focus after the panel's input exists, or the keystrokes stay in the
      // task field.
      cx.timer.after(30, () => { if (this.baseOpen) this.baseInput.focus(); });
    } else {
      this.baseInput.blur();
      this.taskInput.focus();
    }
    cx.notify();
  }

  loadBaseBranches(cx) {
    const repo = this.projects.find((p) =>
      p.path === this.chosen?.path || (this.chosen?.repo && p.repo === this.chosen.repo))
      ?? { path: this.chosen?.path, repo: this.chosen?.repo, remote: "origin" };
    if (!repo.path) return;
    this.baseLoading = true;
    cx.spawn(async (cx) => {
      const branches = await branchesFor(repo);
      if (this.closed) return;
      this.baseBranches = branches;
      this.baseLoading = false;
      this.baseAt = Math.max(0, branches.indexOf(this.chosen?.base));
      cx.notify();
    });
  }

  /// Filtered to the window the picker renders: newest first, so the active
  /// branch sits near the top and the filter reaches the rest.
  baseOptions() {
    let filter = "";
    try {
      filter = this.baseInput.value();
    } catch {}
    const q = filter.trim().toLowerCase();
    const matches = q ? this.baseBranches.filter((b) => b.toLowerCase().includes(q)) : this.baseBranches;
    return matches.slice(0, 80);
  }

  pickBase(base, cx) {
    if (this.chosen?.kind !== "new-worktree") return;
    this.chosen.base = base;
    // Leave the base stop so Enter now runs the task rather than reopening it.
    this.runStop = null;
    this.setBaseOpen(false, cx);
  }

  selectedAgent() {
    const installed = this.agents.filter((a) => a.installed);
    return installed.find((a) => a.key === "claude") ?? null;
  }

  /// Agent first, then the group's tasks and the global tasks that apply.
  actionOptions() {
    if (!this.chosen) return ["agent"];
    const tasks = [...this.tasksFor(this.chosenGroup()), ...this.globalTasks(this.attachedPR())];
    return ["agent", ...tasks.map((task) => task.name)];
  }

  taskFor(id) {
    return [...this.tasksFor(this.chosenGroup()), ...this.globalTasks(this.attachedPR())]
      .find((task) => task.name === id) ?? null;
  }

  /// The text field the active action uses: the agent prompt, an accepting
  /// task's extra instructions, or the terminal's optional command.
  promptForAction(id) {
    if (id === "__terminal") return this.terminalInput;
    return this.taskFor(id)?.acceptsTask ? this.extraInput : this.taskInput;
  }

  promptValue() {
    const state = this.promptForAction(this.action);
    if (!state) return "";
    try { return state.value(); } catch { return ""; }
  }

  /// Enter, or the button: a stop that opens something comes first.
  primaryAction(cx) {
    if (this.composerFocus && this.runStop === "define") this.toggleDefine(cx);
    else if (this.composerFocus && this.runStop === "base") this.setBaseOpen(true, cx);
    else this.submit(cx);
  }

  /// Move the keyboard to the field the action uses (or the button when it
  /// has none) once the next render has mounted it. Stops that only open
  /// something keep the keyboard where it is.
  focusPrompt(id, cx) {
    if (id === "define" || id === "base" || id === "message") return;
    const state = this.promptForAction(id);
    cx.timer.after(30, () => {
      if (this.closed || this.runStop !== id) return;
      if (state) state.focus();
      else this.createFocus.focus();
    });
  }

  /// The + Task form replaces the prompt row while its stop is active.
  openDefine(cx) {
    this.runStop = "define";
    this.composerFocus = true;
    this.taskCommandInput.set_value("");
    cx.timer.after(30, () => {
      if (this.runStop === "define") this.taskCommandInput.focus();
    });
  }

  toggleDefine(cx) {
    if (this.runStop === "define") {
      this.runStop = this.action;
      const state = this.promptForAction(this.action);
      if (state) state.focus();
      else this.createFocus.focus();
    } else {
      this.openDefine(cx);
    }
    cx.notify();
  }

  submit(cx) {
    if (!this.chosen || this.busy) return;
    if (this.action === "__terminal") {
      this.openTerminal(cx, this.terminalInput.value().trim());
      return;
    }
    if (this.action === "agent") {
      this.create(cx);
      return;
    }
    if (this.chosen.kind === "new-worktree") return;
    const task = [...this.tasksFor(this.chosenGroup()), ...this.globalTasks(this.attachedPR())]
      .find((candidate) => candidate.name === this.action);
    if (!task) return;
    const text = this.promptValue().trim();
    cx.spawn(async (cx) => {
      try {
        await this.runTask(cx, task, text);
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  async worktreeRoot() {
    let directory = "~/.herdr/worktrees";
    try {
      const raw = await readTextFile(`${appHome()}/settings.json`);
      const value = raw ? JSON.parse(raw)?.worktrees?.directory : null;
      if (typeof value === "string" && value.trim()) directory = value.trim();
    } catch {}
    return expandHome(directory).replace(/\/+$/, "");
  }

  async ensureWorktree(pr, repo) {
    let branch = pr.branch;
    if (!branch) {
      const v = await sh("gh", ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefName"], { timeout: 30000 });
      if (v.ok) {
        try { branch = JSON.parse(v.out).headRefName; } catch {}
      }
    }
    if (!branch) throw new Error(`Could not read the head branch of ${pr.repo}#${pr.number}.`);

    const dir = `${await this.worktreeRoot()}/${repo.name}/${slug(branch)}`;
    const list = await sh("git", ["-C", repo.path, "worktree", "list", "--porcelain"]);
    if (list.ok) {
      for (const block of list.out.split(/\n\n+/)) {
        const lines = block.split("\n");
        const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
        const at = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
        if (path && (path === dir || at === branch)) return { path, branch: at ?? branch };
      }
    }

    const ref = `refs/remotes/pr/${pr.number}`;
    const remote = repo.remote || "origin";
    const fetched = await sh("git", ["-C", repo.path, "fetch", remote, `pull/${pr.number}/head:${ref}`], { timeout: 120000 });
    if (!fetched.ok) throw new Error(fetched.err || `Could not fetch ${pr.repo}#${pr.number}.`);

    await sh("mkdir", ["-p", dir.slice(0, dir.lastIndexOf("/"))]);
    const exists = await sh("git", ["-C", repo.path, "rev-parse", "--verify", `refs/heads/${branch}`]);
    const args = exists.ok
      ? ["-C", repo.path, "worktree", "add", dir, branch]
      : ["-C", repo.path, "worktree", "add", "-b", branch, dir, ref];
    const added = await sh("git", args, { timeout: 120000 });
    if (!added.ok) throw new Error(added.err || `Could not create a worktree at ${dir}.`);
    return { path: dir, branch };
  }

  async createWorktree(repo, branch, base) {
    const dir = `${await this.worktreeRoot()}/${repo.name}/${slug(branch)}`;
    const list = await sh("git", ["-C", repo.path, "worktree", "list", "--porcelain"]);
    if (list.ok) {
      for (const block of list.out.split(/\n\n+/)) {
        const lines = block.split("\n");
        const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
        const at = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
        if (path && (path === dir || at === branch)) return { path, branch: at ?? branch };
      }
    }
    await sh("mkdir", ["-p", dir.slice(0, dir.lastIndexOf("/"))]);
    const exists = await sh("git", ["-C", repo.path, "rev-parse", "--verify", `refs/heads/${branch}`]);
    const args = exists.ok
      ? ["-C", repo.path, "worktree", "add", dir, branch]
      : ["-C", repo.path, "worktree", "add", "-b", branch, dir, base || "main"];
    const added = await sh("git", args, { timeout: 120000 });
    if (!added.ok) throw new Error(added.err || `Could not create a worktree at ${dir}.`);
    return { path: dir, branch };
  }

  async cloneRepo(repo) {
    const name = repo.split("/")[1];
    const dir = `${DEV_ROOT()}/${name}`;
    const exists = await sh("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    if (!exists.ok) {
      const cloned = await sh("gh", ["repo", "clone", repo, dir], { timeout: 180000 });
      if (!cloned.ok) throw new Error(cloned.err || `Could not clone ${repo}.`);
    }
    const project = { path: dir, name, repo, remote: "origin" };
    this.projects.push(project);
    return project;
  }

  async startIn(cx, path, name, agent, task) {
    await this.launch(cx, path, name, agentCommand(agent.run), task);
    this.close();
  }

  create(cx) {
    if (!this.chosen || this.busy) return;
    const target = this.chosen;
    const agent = this.selectedAgent();
    if (!agent) {
      this.error = "No agent is installed.";
      cx.notify();
      return;
    }
    const task = this.promptValue().trim();
    this.busy = true;
    this.error = "";
    cx.notify();
    // `cx` is only valid for this call, so the work after the first await runs
    // in a spawned task with a context that survives them.
    cx.spawn(async (cx) => {
      try {
        if (target.kind === "pr") {
          let repo = this.projects.find((p) => p.repo === target.repo);
          if (!repo) repo = await this.cloneRepo(target.repo);
          const wt = await this.ensureWorktree(target, repo);
          await this.startIn(cx, wt.path, wt.branch ?? target.branch ?? `${target.repoName}-${target.number}`, agent, task);
        } else if (target.kind === "new-worktree") {
          if (!task) throw new Error("Describe the task: its words name the branch.");
          const branch = branchFromTask(task);
          const repo = this.projects.find((p) => p.path === target.path || (target.repo && p.repo === target.repo));
          if (!repo) throw new Error("Project not found.");
          const wt = await this.createWorktree(repo, branch, target.base);
          await this.startIn(cx, wt.path, wt.branch, agent, task);
        } else if (target.kind === "worktree") {
          await this.startIn(cx, target.path, target.branch ?? target.repoName, agent, task);
        } else if (target.kind === "project") {
          await this.startIn(cx, target.path, target.name, agent, task);
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  addManual(cx) {
    const text = this.manualInput.value().trim();
    if (!text) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
      const pr = parsePr(text);
      if (pr) {
        const r = await sh("gh", [
          "pr", "view", String(pr.number), "--repo", pr.repo,
          "--json", "number,title,headRefName,url,updatedAt,isDraft",
        ], { timeout: 30000 });
        if (!r.ok) throw new Error(r.err || "Could not read that PR.");
        const v = JSON.parse(r.out);
        const row = {
          kind: "pr",
          key: `pr:${pr.repo}#${v.number}`,
          title: v.title,
          subtitle: `${pr.repo} #${v.number}${v.headRefName ? ` · ${v.headRefName}` : ""}`,
          repo: pr.repo,
          repoName: pr.repo.split("/")[1],
          number: v.number,
          branch: v.headRefName,
          worktree: this.worktrees.find((w) => w.repo === pr.repo && w.branch === v.headRefName) ?? null,
          draft: Boolean(v.isDraft),
          updatedAt: v.updatedAt,
          mine: true,
          search: `${v.title} ${pr.repo} ${v.headRefName ?? ""} #${v.number}`,
        };
        this.prs = mergePrs(this.prs, [row]);
        this.link();
        this.manual = false;
        this.chosen = row;
        this.action = "agent";
        this.taskInput.focus();
      } else {
        const path = expandHome(text);
        const top = await sh("git", ["-C", path, "rev-parse", "--show-toplevel"]);
        if (!top.ok) throw new Error("That is not a PR URL or a git repository.");
        const project = { path: top.out || path, name: path.split("/").at(-1), repo: null, remote: "origin" };
        this.projects.push(project);
        this.manual = false;
        this.chosen = {
          kind: "project", title: project.name, subtitle: project.path,
          path: project.path, name: project.name, repo: null,
          search: `${project.name} ${project.path}`,
        };
        this.action = "agent";
        this.taskInput.focus();
      }
    } catch (e) {
      this.error = String(e?.message ?? e);
    } finally {
      this.busy = false;
      cx.notify();
    }
    });
  }

  render() {
    if (this.background) return div();
    const t = theme();
    const rows = this.rows();
    const pickable = rows.filter((r) => r.kind !== "head");
    this.at = Math.max(0, Math.min(this.at, pickable.length - 1));
    const sel = pickable[this.at];
    const selIndex = rows.indexOf(sel);
    if (selIndex >= 0) this.scroll.scroll_to_item(selIndex);
    const baseRows = this.baseOpen ? this.baseOptions() : [];
    if (this.baseOpen) {
      this.baseAt = Math.max(0, Math.min(this.baseAt, baseRows.length - 1));
      if (baseRows.length) this.baseScroll.scroll_to_item(this.baseAt);
    }

    const age = this.cachedAt ? Math.max(0, Math.round((Date.now() - this.cachedAt) / 60000)) : null;
    const status = this.refreshing
      ? "Refreshing…"
      : age === null
        ? ""
        : age < 1 ? "Updated just now" : `Updated ${age}m ago`;

    const badge = (text, color) =>
      div().flex_none().px(5).h(16).rounded(4).bg((color ?? t.dim) + "26").text_size(9.5)
        .font_semibold().text_color(color ?? t.dim).flex().items_center().child(text);

    const modeBtn = (id, label) =>
      div().id(`nt-mode-${id}`).h(24).flex_none().px(8).rounded(5).text_size(10.5)
        .bg(this.mode === id ? t.selected : t.raised)
        .text_color(this.mode === id ? t.foreground : t.dim)
        .flex().items_center().cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .on_click((_e, cx) => {
          this.mode = id;
          setShared("new-task.mode", id);
          this.at = 0;
          cx.notify();
        })
        .child(label);

    const scopeBtn = (id, label) =>
      div().id(`nt-scope-${id}`).h(24).flex_none().px(8).rounded(5).text_size(10.5)
        .bg(this.scope === id ? t.selected : t.raised)
        .text_color(this.scope === id ? t.foreground : t.dim)
        .flex().items_center().cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .on_click((_e, cx) => {
          this.scope = id;
          setShared("new-task.scope", id);
          this.at = 0;
          cx.notify();
        })
        .child(label);

    const statusIcon = (status) => {
      if (status === "working") return svg("mods/new-task/spinner.svg").size(14).flex_none().text_color(t.working).spin(900);
      if (status === "blocked") return div().size(9).flex_none().rounded(5).bg(t.blocked);
      if (status === "done") return div().size(9).flex_none().rounded(5).bg(t.done);
      return div().size(9).flex_none().rounded(5).border(1.5).border_color(t.idle ?? t.dim);
    };

    const rowIcon = (r) => {
      if (r.kind === "session") return statusIcon(r.status);
      if (r.kind === "pr") return svg("mods/new-task/branch.svg").size(15).flex_none().text_color(t.muted);
      if (r.kind === "worktree") return svg("mods/new-task/folder.svg").size(15).flex_none().text_color(t.muted);
      if (r.kind === "new-worktree") return svg("mods/new-task/git-branch.svg").size(15).flex_none().text_color(t.muted);
      if (r.kind === "task") return svg("mods/new-task/terminal.svg").size(15).flex_none().text_color(t.muted);
      if (r.kind === "project") return svg("mods/new-task/folder.svg").size(15).flex_none().text_color(t.muted);
      return svg("mods/new-task/plus.svg").size(14).flex_none().text_color(t.dim);
    };

    const row = (r) => {
      if (r.kind === "head") {
        if (!r.group) {
          return h_flex().h(28).px(4).items_end().text_size(11).font_semibold()
            .text_color(t.dim).child(r.title);
        }
        return h_flex()
          .h(38)
          .mx(4)
          .mt(4)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(6)
          .border_t(1)
          .border_color(t.border)
          .child(svg("mods/new-task/folder.svg").size(14).flex_none().text_color(t.muted))
          .child(
            v_flex().flex_1().min_w(0).gap(1)
              .child(div().truncate().text_size(12).font_semibold().text_color(t.foreground).child(r.title))
              .child(div().truncate().text_size(10.3).text_color(t.dim).child(r.subtitle)),
          )
          .when(Boolean(r.counts), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(r.counts)));
      }
      if (r.kind === "manual") {
        const on = r === sel;
        return own(h_flex())
          .id("nt-manual")
          .h(40)
          .mx(4)
          .px(10)
          .gap(8)
          .rounded(7)
          .items_center()
          .cursor_pointer()
          .when(on, (el) => el.bg(t.hover))
          .hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => this.activate(r, cx))
          .child(rowIcon(r))
          .child(div().text_size(12).text_color(t.muted)
            .child(this.manual ? "Type a PR URL or folder path above" : "Add a PR by URL or a folder…"));
      }
      const on = r === sel;
      return own(h_flex())
        .id(`nt-${r.key}`)
        .h(44)
        .mx(4)
        .pl(r.nested ? 18 : 10)
        .pr(10)
        .gap(10)
        .rounded(8)
        .items_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .hover((el) => el.bg(t.hover))
        .on_click((_e, cx) => this.activate(r, cx))
        .child(rowIcon(r))
        .child(
          v_flex().flex_1().min_w(0).gap(1)
            .child(div().truncate().text_size(12.8).text_color(t.foreground).child(r.title))
            .child(div().truncate().text_size(10.8).text_color(t.dim).child(r.subtitle)),
        )
        .when(r.kind === "pr" && r.draft, (el) => el.child(badge("Draft")))
        .when(r.kind === "pr" && r.worktree, (el) => el.child(badge("Worktree", t.done)))
        .when(r.kind === "pr" && !r.worktree, (el) => el.child(badge("No checkout")))
        .when(r.kind === "worktree" && r.pr, (el) => el.child(badge(`#${r.pr.number}`, t.accent)))
        .when(r.kind === "task", (el) => el.child(badge("Task", t.accent)))
        .when(r.kind === "session" && r.status, (el) => el.child(badge(r.status, t[r.status] ?? t.dim)))
        .child(svg("mods/new-task/chevron-right.svg").size(12).flex_none().text_color(t.dim));
    };

    const agentIcon = (a) => a.icon
      ? (a.tint ? svg(a.icon).size(13).flex_none().text_color(t.foreground) : image(a.icon).w(13).h(13).flex_none())
      : null;

    // Enter or Space presses a focused button, as a button should.
    const press = (el, run, focus) => el
      .track_focus(focus)
      .on_key_down((e, cx) => {
        if (e.key !== "enter" && e.key !== "space" && e.key !== " ") return;
        run(cx);
        cx.stop_propagation();
        cx.notify();
      });

    const group = this.chosenGroup();
    const tasks = this.chosen
      ? [...this.tasksFor(group), ...this.globalTasks(this.attachedPR())]
      : [];
    const canRunTask = Boolean(this.chosen) && this.chosen.kind !== "new-worktree";
    if (this.action !== "agent" && this.action !== "__terminal"
      && !tasks.some((task) => task.name === this.action)) {
      this.action = "agent";
    }
    const selectedTask = this.action === "agent"
      ? null
      : (tasks.find((task) => task.name === this.action) ?? null);
    const agent = this.selectedAgent();
    const isNewWorktree = this.chosen?.kind === "new-worktree";
    const chosenTitle = isNewWorktree
      ? `New worktree in ${this.chosen.name}`
      : this.chosen?.title;
    const prompt = this.promptForAction(this.action);
    const taskText = this.promptValue();
    const branchPreview = isNewWorktree && taskText.trim() ? branchFromTask(taskText) : "";
    // The button follows the stop Tab is on, so Terminal and + Task rename it
    // even though neither is a task with a command of its own.
    const stop = this.composerFocus ? this.runStop : null;
    const defining = stop === "define";
    const submitLabel = this.busy
      ? "Working…"
      : stop === "base" ? "Choose base"
      : stop === "__terminal" ? "Open terminal"
      : selectedTask ? `Run ${selectedTask.name}`
      : isNewWorktree ? "Create worktree" : "Start task";

    // The black chip is the active one: the action Tab is on, or the chosen
    // action when the Run row is not being cycled.
    const active = (id) => (this.composerFocus && this.runStop !== null
      ? this.runStop === id
      : this.action === id);
    const pickAction = (id, cx) => {
      this.action = id;
      this.composerFocus = true;
      this.runStop = id;
      this.focusPrompt(id, cx);
      cx.notify();
    };
    const actionChip = (id, label, iconEl) =>
      own(h_flex())
        .id(`nt-action-${id}`)
        .h(26)
        .px(8)
        .gap(5)
        .rounded(6)
        .bg(active(id) ? t.solid : t.raised)
        .items_center()
        .when(!canRunTask && id !== "agent" && id !== "__terminal", (el) => el.opacity(0.5))
        .cursor_pointer()
        .hover((el) => el.bg(active(id) ? t.solid : t.hover))
        .tooltip(id === "agent"
          ? (agent ? `Start ${agent.name}` : "Claude Code is not installed")
          : id === "__terminal"
            ? "Open a terminal in this checkout"
            : (canRunTask ? `Run ${tasks.find((task) => task.name === id)?.command ?? id}` : "Choose a checkout to run this task"))
        .on_click((_e, cx) => pickAction(id, cx))
        .when(Boolean(iconEl), (el) => el.child(iconEl))
        .child(div().text_size(11.5)
          .text_color(active(id) ? t.solid_foreground : t.muted).child(label));

    const composer = this.chosen
      ? v_flex()
        .flex_none()
        .gap(8)
        .p(12)
        .rounded(10)
        .bg(t.surface)
        .border_1()
        .border_color(t.border)
        .child(
          h_flex().gap(8).items_center()
            .child(
              v_flex().flex_1().min_w(0)
                .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(chosenTitle))
                .child(div().truncate().text_size(10.8).text_color(t.dim).child(this.chosen.subtitle)),
            )
            .child(
              div().id("nt-change").px(6).py(2).rounded(4).text_size(11).text_color(t.blocked).cursor_pointer()
                .hover((el) => el.bg(t.hover).text_color(t.blocked))
                .on_click((_e, cx) => {
                  this.chosen = null;
                  if (this.baseOpen) this.baseInput.blur();
                  this.baseOpen = false;
                  this.action = "agent";
                  this.composerFocus = false;
                  this.runStop = null;
                  this.input.focus();
                  cx.notify();
                })
                .child("Cancel"),
            ),
        )
        .child(this.chosen?.kind === "new-worktree"
          ? v_flex().gap(6)
            .child(
              own(h_flex())
                .id("nt-base")
                .h(34)
                .w_full()
                .flex_none()
                .px(9)
                .gap(7)
                .rounded(8)
                .border_1()
                .border_color(active("base") ? t.accent : t.input)
                .bg(t.background)
                .items_center()
                .cursor_pointer()
                .hover((el) => el.bg(t.hover))
                .tooltip("Choose the base branch (Tab to it, Enter to open)")
                .on_click((_e, cx) => this.toggleBase(cx))
                .child(svg("mods/new-task/git-branch.svg").size(14).flex_none().text_color(t.dim))
                .child(div().flex_none().text_size(11.5).text_color(t.dim).child("From"))
                .child(div().flex_1().min_w(0).truncate().text_size(12.5)
                  .text_color(t.foreground).child(this.chosen.base ?? "main"))
                .child(svg("mods/new-task/chevron-right.svg").size(11).flex_none().text_color(t.dim)),
            )
            .when(this.baseOpen, (el) => el.child(
              v_flex().gap(4).p(6).rounded(8).border_1().border_color(t.input).bg(t.background)
                .child(
                  h_flex().h(28).flex_none().px(7).gap(6).rounded(6).bg(t.surface).items_center()
                    .child(svg("mods/new-task/search.svg").size(12).flex_none().text_color(t.dim))
                    .child(Input.new(this.baseInput).flex_1().h_full().text_size(11.5).text_color(t.foreground)),
                )
                .child(
                  v_flex().id("nt-bases")
                    .h(Math.min(168, Math.max(28, baseRows.length * 24)))
                    .min_h(0).overflow_y_scrollbar()
                    .track_scroll(this.baseScroll)
                    .when(baseRows.length === 0, (el) => el.child(
                      div().px(6).py(4).text_size(11).text_color(t.dim)
                        .child(this.baseLoading ? "Loading branches…" : "No matching branches"),
                    ))
                    .children(baseRows.map((base, index) => {
                      const on = index === this.baseAt;
                      const current = base === this.chosen.base;
                      return own(h_flex())
                        .id(`nt-base-${base}`)
                        .h(24)
                        .px(6)
                        .gap(6)
                        .rounded(5)
                        .items_center()
                        .cursor_pointer()
                        .when(on, (row) => row.bg(t.selected))
                        .hover((row) => row.bg(t.hover))
                        .on_click((_e, cx) => this.pickBase(base, cx))
                        .child(svg("mods/new-task/git-branch.svg").size(11).flex_none().text_color(on ? t.foreground : t.dim))
                        .child(div().flex_1().truncate().text_size(11.5).text_color(on ? t.foreground : t.muted).child(base))
                        .when(current, (row) => row.child(svg("mods/new-task/check.svg").size(11).flex_none().text_color(t.done)));
                    })),
                ),
            ))
          : div())
        .when(!isNewWorktree, (el) => el.child(
          h_flex().gap(6).items_center().flex_wrap()
            .child(div().text_size(10.8).text_color(t.dim).child("Run"))
            .child(actionChip("agent", agent?.name ?? "Claude Code", agent ? agentIcon(agent) : null))
            .children(tasks.map((task) => actionChip(
              task.name,
              task.name,
              svg("mods/new-task/terminal.svg").size(12).flex_none()
                .text_color(active(task.name) ? t.solid_foreground : t.muted))))
            .child(actionChip(
              "__terminal",
              "Terminal",
              svg("mods/new-task/terminal.svg").size(12).flex_none()
                .text_color(active("__terminal") ? t.solid_foreground : t.muted)))
            .child(
              press(
                div().id("nt-define-task").h(26).px(8).rounded(6).text_size(11.5)
                  .bg(active("define") ? t.solid : t.raised)
                  .text_color(active("define") ? t.solid_foreground : t.dim)
                  .flex().items_center().cursor_pointer()
                  .hover((el) => el.bg(active("define") ? t.solid : t.hover).text_color(t.foreground))
                  .tooltip(group ? `Add and run a task for ${group}` : "Add and run a task")
                  .tab_index(10)
                  .on_click((_e, cx) => this.toggleDefine(cx))
                  .child("+ Task"),
                (cx) => this.toggleDefine(cx),
                this.defineFocus,
              ),
            ),
        ))
        .child(defining
          ? h_flex().gap(8).items_center()
            .child(h_flex().flex_1().h(34).px(9).gap(7).rounded(8).border_1().border_color(t.input).bg(t.background).items_center()
              .child(svg("mods/new-task/terminal.svg").size(14).flex_none().text_color(t.dim))
              .child(Input.new(this.taskCommandInput).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
            .child(
              press(
                own(h_flex())
                  .id("nt-save-task")
                  .h(34)
                  .px(14)
                  .gap(6)
                  .rounded(8)
                  .bg(this.busy ? t.raised : t.solid)
                  .items_center()
                  .cursor_pointer()
                  .hover((el) => el.bg(t.accent))
                  .tab_index(20)
                  .on_click((_e, cx) => this.saveTask(cx))
                  .child(div().text_size(12).text_color(t.solid_foreground).child("⏎"))
                  .child(div().text_size(12).font_medium().text_color(t.solid_foreground).child("Add & run")),
                (cx) => this.saveTask(cx),
                this.saveFocus,
              ),
            )
          : h_flex().gap(8).items_center()
            .child(
              h_flex().flex_1().h(34).px(9).gap(7).rounded(8).border_1()
                .border_color(active("message") ? t.accent : t.input)
                .bg(t.background).items_center()
                .child(svg("mods/new-task/terminal.svg").size(14).flex_none().text_color(t.dim))
                .child(Input.new(prompt).flex_1().h_full().text_size(12.5).text_color(t.foreground)),
            )
            .child(
              press(
                own(h_flex())
                  .id("nt-create")
                  .h(34)
                  .px(14)
                  .gap(6)
                  .rounded(8)
                  .bg(this.busy ? t.raised : t.solid)
                  .items_center()
                  .cursor_pointer()
                  .hover((el) => el.bg(t.accent))
                  .tab_index(20)
                  .on_click((_e, cx) => this.primaryAction(cx))
                  .child(div().text_size(12).text_color(t.solid_foreground).child("⏎"))
                  .child(div().text_size(12).font_medium().text_color(t.solid_foreground).child(submitLabel)),
                (cx) => this.primaryAction(cx),
                this.createFocus,
              ),
            )
            .when(isNewWorktree, (el) => el.child(
              press(
                own(h_flex())
                  .id("nt-open-terminal")
                  .h(34)
                  .px(10)
                  .gap(6)
                  .rounded(8)
                  .bg(t.raised)
                  .items_center()
                  .cursor_pointer()
                  .hover((btn) => btn.bg(t.hover))
                  .on_click((_e, cx) => this.openTerminal(cx))
                  .child(svg("mods/new-task/terminal.svg").size(13).flex_none().text_color(t.muted))
                  .child(div().text_size(11.5).text_color(t.muted).child("Open terminal")),
                (cx) => this.openTerminal(cx),
                this.terminalFocus,
              ),
            )),
        )
        .when(isNewWorktree, (el) => el.child(
          div().px(2).text_size(10.8).text_color(t.dim)
            .child(branchPreview ? `Branch: ${branchPreview}` : "The task text names the branch"),
        ))
      : null;

    return v_flex()
      .id("new-task")
      .key_context("NewTask")
      .track_focus(this.handle)
      .w_full()
      .h_full()
      .p(12)
      .gap(8)
      .bg(t.popover)
      .text_size(13)
      .on_action("new_task_cycle_action", (_e, cx) => {
        this.cycleTab(1, cx);
        cx.notify();
      })
      .on_action("new_task_cycle_action_back", (_e, cx) => {
        this.cycleTab(-1, cx);
        cx.notify();
      })
      .on_action("new_task_cancel", (_e, cx) => {
        this.cancel();
        cx.notify();
      })
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "down" || k === "up") {
          if (this.baseOpen) {
            this.cycleBase(k === "down" ? 1 : -1);
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if (!pickable.length) return;
          this.at = k === "down"
            ? (this.at + 1) % pickable.length
            : (this.at + pickable.length - 1) % pickable.length;
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(
        h_flex().h(24).flex_none().gap(6).items_center()
          .child(div().flex_none().text_size(15).font_semibold().text_color(t.foreground).child("New Task"))
          .child(modeBtn("session", "Running"))
          .child(modeBtn("pr", "PRs"))
          .child(modeBtn("worktree", "Worktrees"))
          .child(modeBtn("new", "New"))
          .child(div().flex_1())
          .child(div().text_size(10.5).text_color(t.dim).child(status))
          .child(
            div().id("nt-refresh").flex_none().px(6).py(2).rounded(5).text_size(12).text_color(t.dim).cursor_pointer()
              .hover((el) => el.bg(t.hover).text_color(t.foreground))
              .tooltip("Refresh PRs, worktrees and projects")
              .on_click((_e, cx) => this.refresh(cx, true))
              .child(this.refreshing
                ? svg("mods/new-task/spinner.svg").size(12).flex_none().text_color(t.muted).spin(900)
                : "↻"),
          )
          .child(div().id("nt-add").flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
            .hover((el) => el.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.manual = true; this.manualInput.focus(); cx.notify(); })
            .child("+ Add"))
          .child(div().id("nt-esc").flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
            .hover((el) => el.bg(t.hover).text_color(t.foreground))
            .on_click(() => this.close()).child("Esc")),
      )
      .child(
        h_flex().h(38).flex_none().px(10).gap(8).items_center().rounded(9)
          .border_1().border_color(t.accent).bg(t.background)
          .child(svg("mods/new-task/search.svg").size(15).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
          .when(this.mode === "pr", (el) => el
            .child(div().text_size(9.5).text_color(t.dim).child("PRs"))
            .child(scopeBtn("all", "All"))
            .child(scopeBtn("mine", "Mine"))),
      )
      .when(this.manual, (el) => el.child(
        h_flex().h(34).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
          .child(svg("mods/new-task/plus.svg").size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.manualInput).flex_1().h_full().text_size(12.5).text_color(t.foreground)),
      ))
      .when(Boolean(this.error), (el) => el.child(
        div().px(10).py(6).rounded(7).bg(t.blocked + "1a").text_size(11.5).text_color(t.blocked).child(this.error),
      ))
      .when(this.loading, (el) => el.child(
        div().px(10).text_size(11.5).text_color(t.dim).child("Loading PRs, worktrees and projects…"),
      ))
      .child(
        v_flex()
          .id("nt-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .track_scroll(this.scroll)
          .children(rows.map(row)),
      )
      .when(Boolean(composer), (el) => el.child(composer));
  }
}

