// Branch cleanup: merged, closed-PR and stale branches and worktrees across
// local checkouts. A hidden copy cleans the safe ones; the dialog reviews the
// rest. Open with mod.open { name: "branch-cleanup" }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import {
  run, props, closeOverlay, theme, terminals, exec, home, appHome,
  readTextFile, writeTextFile, setShared, notify, checking,
} from "herdr";


const AUTO_INTERVAL = 15 * 60 * 1000;
const PR_TTL = 5 * 60 * 1000;
const DEFAULT_STALE_DAYS = 30;
const DEFAULT_BACKUP_DAYS = 14;
const AGE_STEPS = [7, 14, 30, 60, 90, 180];
const BACKUP_STEPS = [7, 14, 30];

const configPath = () => `${appHome()}/branch-cleanup.json`;

function expand(path) {
  const h = home();
  if (path === "~") return h;
  if (path.startsWith("~/")) return h.replace(/\/+$/, "") + path.slice(1);
  return path;
}

async function git(cwd, args, opts = {}) {
  try {
    const r = await exec("git", args, { cwd, ...opts });
    return {
      ok: r.code === 0,
      code: r.code,
      out: (r.stdout ?? "").trim(),
      err: (r.stderr ?? r.stdout ?? "").trim(),
    };
  } catch (e) {
    return { ok: false, code: -1, out: "", err: e?.message ?? String(e) };
  }
}

async function readConfig() {
  let raw = null;
  try {
    raw = await readTextFile(configPath());
  } catch {}
  let cfg = {};
  try {
    cfg = JSON.parse(raw ?? "{}");
  } catch {}
  return {
    staleDays: Number.isFinite(cfg.staleDays) && cfg.staleDays > 0 ? Math.round(cfg.staleDays) : DEFAULT_STALE_DAYS,
    backupDays: Number.isFinite(cfg.backupDays) && cfg.backupDays > 0 ? Math.round(cfg.backupDays) : DEFAULT_BACKUP_DAYS,
    auto: cfg.auto !== false,
    keep: Array.isArray(cfg.keep) ? cfg.keep.filter((x) => typeof x === "string") : [],
    raw,
  };
}

async function readKeep() {
  const paths = [expand("~/.config/worktree-gc/keep"), `${appHome()}/branch-cleanup-keep`];
  const out = [];
  for (const path of paths) {
    try {
      const text = await readTextFile(path);
      if (!text) continue;
      for (const line of text.split("\n")) {
        const value = line.trim();
        if (value && !value.startsWith("#")) out.push(value);
      }
    } catch {}
  }
  return out;
}

const globCache = new Map();
function globMatch(pattern, text) {
  if (!pattern || !text) return false;
  let re = globCache.get(pattern);
  if (!re) {
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "*") source += ".*";
      else if (c === "?") source += ".";
      else if (c === "[") {
        const end = pattern.indexOf("]", i + 1);
        if (end > i) {
          source += pattern.slice(i, end + 1);
          i = end;
        } else source += "\\[";
      } else source += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    re = new RegExp(`^${source}$`);
    globCache.set(pattern, re);
  }
  return re.test(text);
}

function keepMatch(patterns, repo, branch, path) {
  const targets = [branch ?? "", path ?? "", branch ? `${repo}/${branch}` : ""];
  return patterns.some((pattern) => targets.some((target) => globMatch(pattern, target)));
}

function isLive(path, live) {
  const p = path.replace(/\/+$/, "");
  for (const cwd of live) if (cwd === p || cwd.startsWith(`${p}/`)) return true;
  return false;
}

async function liveCwds() {
  const out = new Set();
  for (const term of terminals()) {
    if (typeof term.cwd === "string" && term.cwd) out.add(term.cwd.replace(/\/+$/, ""));
  }
  try {
    const r = await exec("lsof", ["-a", "-d", "cwd", "-Fn", "-w"], { timeout: 20000 });
    for (const line of (r.stdout ?? "").split("\n")) {
      if (line.startsWith("n")) out.add(line.slice(1).replace(/\/+$/, ""));
    }
  } catch {}
  return out;
}

async function repoRoots() {
  const h = home();
  const roots = [`${h}/Development`, `${h}/Development/.worktrees`, `${h}/.t3/worktrees`];
  try {
    const raw = await readTextFile(`${appHome()}/projects.json`);
    const data = JSON.parse(raw ?? "{}");
    if (Array.isArray(data.roots)) roots.push(...data.roots.filter((x) => typeof x === "string"));
  } catch {}
  return [...new Set(roots.map(expand))];
}

// Every repo once, from its main checkout: { common, main, repo }.
async function discoverRepos() {
  const roots = await repoRoots();
  let found = [];
  try {
    const r = await exec(
      "find",
      [...roots, "-maxdepth", "5", "-path", "*/node_modules/*", "-prune", "-o", "-name", ".git", "-print"],
      { timeout: 120000 },
    );
    found = (r.stdout ?? "").split("\n").filter(Boolean);
  } catch {}
  const dirs = [...new Set(
    found
      .map((p) => p.replace(/\/\.git\/?$/, ""))
      .filter((p) => !p.includes("/node_modules/") && !p.includes("/.git/")),
  )];
  const repos = new Map();
  for (let i = 0; i < dirs.length; i += 8) {
    await Promise.all(dirs.slice(i, i + 8).map(async (dir) => {
      const common = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (!common.ok || !common.out) return;
      const bare = await git(dir, ["rev-parse", "--is-bare-repository"]);
      if (bare.out === "true") return;
      if (repos.has(common.out)) return;
      const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
      repos.set(common.out, { common: common.out, main, repo: main.split("/").filter(Boolean).pop() });
    }));
  }
  return [...repos.values()];
}

async function slugOf(common) {
  const r = await git(home(), ["--git-dir", common, "remote", "get-url", "origin"]);
  if (!r.ok || !/github/i.test(r.out)) return null;
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(r.out);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function defaultRef(common) {
  const r = await git(home(), ["--git-dir", common, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (r.ok && r.out) return r.out.replace("refs/remotes/", "");
  for (const branch of ["develop", "main", "master"]) {
    const s = await git(home(), ["--git-dir", common, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
    if (s.ok) return `origin/${branch}`;
  }
  return "";
}

function prsKey(slug) {
  return `branch-cleanup.prs.${slug}`;
}

async function prsFor(slug, fresh) {
  if (!slug) return new Map();
  const key = prsKey(slug);
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {}
  if (!fresh && cached && Date.now() - cached.at < PR_TTL) return new Map(Object.entries(cached.prs));
  let raw = null;
  try {
    const r = await exec(
      "gh",
      ["pr", "list", "--repo", slug, "--state", "all", "--limit", "1000", "--json",
        "headRefName,headRefOid,number,state,title,url,isDraft"],
      { timeout: 90000 },
    );
    if (r.code === 0) raw = JSON.parse(r.stdout);
  } catch {}
  if (!raw) return cached ? new Map(Object.entries(cached.prs)) : new Map();
  const rank = { MERGED: 3, OPEN: 2, CLOSED: 1 };
  const best = {};
  for (const pr of raw) {
    if (!pr.headRefName) continue;
    if (!best[pr.headRefName] || (rank[pr.state] ?? 0) > (rank[best[pr.headRefName].state] ?? 0)) {
      best[pr.headRefName] = pr;
    }
  }
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), prs: best }));
  } catch {}
  return new Map(Object.entries(best));
}

function parseWorktrees(out) {
  const entries = [];
  let cur = null;
  for (const line of (out ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice(9), branch: null, detached: false, locked: false };
    } else if (!cur) continue;
    else if (line.startsWith("branch refs/heads/")) cur.branch = line.slice("branch refs/heads/".length);
    else if (line === "detached") cur.detached = true;
    else if (line.startsWith("locked")) cur.locked = true;
  }
  if (cur) entries.push(cur);
  return entries;
}

async function unpushed(cwd, refs) {
  const r = await git(cwd, ["rev-list", "--count", ...refs, "--not", "--remotes"]);
  return r.ok && /^\d+$/.test(r.out) ? Number(r.out) : null;
}

// Commits on `ref` that exist neither in the merged PR's head nor on any
// remote: work added after the merge that exists only here. A squash or rebase
// merge leaves the PR's commits unreachable from the base branch, so the PR
// head is the reference, not the remote-tracking refs (which may also be stale
// or deleted). null: the head cannot be checked (treat as merged).
async function afterPr(common, ref, pr) {
  if (!pr || pr.state !== "MERGED" || !ref) return null;
  const have = async (oid) => Boolean(oid)
    && (await git(home(), ["--git-dir", common, "cat-file", "-e", `${oid}^{commit}`])).ok;
  let head = pr.headRefOid ?? null;
  if (!(await have(head))) {
    // The PR's head may never have been fetched here. Ask for it once; the
    // object then stays local for later scans.
    const fetched = await git(home(),
      ["--git-dir", common, "fetch", "--quiet", "--no-tags", "origin", `pull/${pr.number}/head`],
      { timeout: 30000 });
    if (!fetched.ok) return null;
    const rev = await git(home(), ["--git-dir", common, "rev-parse", "FETCH_HEAD"]);
    head = rev.ok ? rev.out : null;
  }
  if (!head) return null;
  const r = await git(home(), ["--git-dir", common, "rev-list", "--count", ref,
    "--not", head, "--remotes"]);
  return r.ok && /^\d+$/.test(r.out) ? Number(r.out) : null;
}

async function merged(common, defRef, branch, pr) {
  if (pr?.state === "MERGED") return true;
  if (!defRef) return false;
  const r = await git(home(), ["--git-dir", common, "merge-base", "--is-ancestor",
    `refs/heads/${branch}`, `refs/remotes/${defRef}`]);
  return r.code === 0;
}

function baseRow(repo, kind, branch, path, at) {
  return {
    kind, repo: repo.repo, main: repo.mainPath, common: repo.common,
    branch, path, at,
    reasons: [], verdict: "keep", checked: false, risk: false, backup: false,
    pr: null, merged: false, dirty: false, unpushed: 0, afterPr: null,
    live: false, ageDays: null,
  };
}

function blockedByKeepRules(row, ctx) {
  if (!row.branch) {
    row.reasons.push("detached HEAD");
    return true;
  }
  row.ageDays = row.at ? Math.floor((Date.now() / 1000 - row.at) / 86400) : null;
  if (/^(main|master|develop|development|staging|production|prod)$/i.test(row.branch)) {
    row.reasons.push("long-lived branch");
    return true;
  }
  if (keepMatch(ctx.patterns, row.repo, row.branch, row.path)) {
    row.reasons.push("keep-list");
    return true;
  }
  if (/backup/i.test(row.branch)) {
    row.isBackup = true;
    if (row.ageDays !== null && row.ageDays >= ctx.backupDays) return false;
    row.reasons.push(row.ageDays === null
      ? "backup branch"
      : `backup branch (${row.ageDays}d, kept ${ctx.backupDays}d)`);
    return true;
  }
  return false;
}

// The one place a row becomes auto, review or keep.
function decide(row, ctx, pr) {
  row.pr = pr ?? null;
  row.ageDays = row.at ? Math.floor((Date.now() / 1000 - row.at) / 86400) : null;
  if (row.merged) {
    if (pr?.state === "MERGED") {
      // The PR is proof the work landed; only local commits the PR never saw
      // (added after the merge) are at risk.
      if (row.afterPr > 0) {
        row.reasons.push(`${row.afterPr} commit(s) after PR #${pr.number} merged`);
        return row;
      }
      row.verdict = "auto";
      row.checked = true;
      row.reasons.push(`PR #${pr.number} merged`);
      return row;
    }
    if (row.unpushed === null) {
      row.reasons.push("cannot verify push");
      return row;
    }
    if (row.unpushed > 0) {
      row.reasons.push(`${row.unpushed} unpushed commit(s)`);
      return row;
    }
    row.verdict = "auto";
    row.checked = true;
    row.reasons.push(`merged into ${ctx.defBranch || "origin default"}`);
    return row;
  }
  if (row.isBackup) {
    row.verdict = "review";
    row.backup = false;
    row.allowUnpushed = true;
    row.checked = true;
    row.risk = false;
    row.reasons.push(`backup branch ${row.ageDays}d (retention ${ctx.backupDays}d)`);
    return row;
  }
  if (pr?.state === "CLOSED") {
    row.verdict = "review";
    row.backup = true;
    row.risk = row.unpushed === null || row.unpushed > 0;
    row.checked = !row.risk;
    row.reasons.push(`PR #${pr.number} closed without merge`);
    if (row.unpushed > 0) row.reasons.push(`${row.unpushed} unpushed commit(s); tip saved as a backup tag`);
    else if (row.unpushed === null) row.reasons.push("cannot verify push; tip saved as a backup tag");
    return row;
  }
  if (!pr && row.ageDays !== null && row.ageDays >= ctx.staleDays) {
    row.verdict = "review";
    row.backup = true;
    row.risk = row.unpushed === null || row.unpushed > 0;
    row.checked = !row.risk;
    row.reasons.push(`stale ${row.ageDays}d, no PR`);
    if (row.unpushed > 0) row.reasons.push(`${row.unpushed} unpushed commit(s); tip saved as a backup tag`);
    else if (row.unpushed === null) row.reasons.push("cannot verify push; tip saved as a backup tag");
    return row;
  }
  row.reasons.push("not merged");
  if (row.ageDays !== null) row.reasons.push(`${row.ageDays}d old`);
  return row;
}

async function worktreeRow(repo, wt, ctx) {
  if (wt.branch && wt.branch === ctx.defBranch) return null;
  const row = baseRow(repo, "worktree", wt.branch, wt.path, wt.branch ? ctx.at.get(wt.branch) : null);
  if (blockedByKeepRules(row, ctx)) return row;
  if (wt.locked) {
    row.reasons.push("locked");
    return row;
  }
  const here = await git(wt.path, ["rev-parse", "--show-toplevel"]);
  if (!here.ok) {
    row.reasons.push("directory gone; run git worktree prune");
    return row;
  }
  row.live = isLive(wt.path, ctx.live);
  if (row.live) {
    row.reasons.push("in use by a live process");
    return row;
  }
  const status = await git(wt.path, ["status", "--porcelain"]);
  row.dirty = !status.ok || Boolean(status.out);
  if (row.dirty) {
    row.reasons.push("uncommitted/untracked changes");
    return row;
  }
  const pr = ctx.prs.get(wt.branch);
  if (pr?.state === "OPEN") {
    row.reasons.push(`open PR #${pr.number}`);
    return row;
  }
  row.merged = await merged(repo.common, ctx.defRef, wt.branch, pr);
  if (pr?.state === "MERGED") row.afterPr = await afterPr(repo.common, `refs/heads/${wt.branch}`, pr);
  else row.unpushed = await unpushed(wt.path, ["HEAD"]);
  return decide(row, ctx, pr);
}

async function branchRow(repo, branch, at, ctx) {
  if (branch === ctx.defBranch) return null;
  const row = baseRow(repo, "branch", branch, null, at);
  if (blockedByKeepRules(row, ctx)) return row;
  const pr = ctx.prs.get(branch);
  if (pr?.state === "OPEN") {
    row.reasons.push(`open PR #${pr.number}`);
    return row;
  }
  row.merged = await merged(repo.common, ctx.defRef, branch, pr);
  if (pr?.state === "MERGED") row.afterPr = await afterPr(repo.common, `refs/heads/${branch}`, pr);
  else row.unpushed = await unpushed(repo.mainPath, [`refs/heads/${branch}`]);
  return decide(row, ctx, pr);
}

async function rowsForRepo(repo, ctx) {
  const list = await git(home(), ["--git-dir", repo.common, "worktree", "list", "--porcelain"]);
  if (!list.ok) return [];
  const worktrees = parseWorktrees(list.out);
  if (!worktrees.length) return [];
  // Full refnames: `:short` prefixes `heads/` when a branch shares its name
  // with a tag, which would miss the worktree's bare branch name and break
  // `git branch -D`.
  const refs = await git(home(), ["--git-dir", repo.common, "for-each-ref",
    "--format=%(refname)%09%(committerdate:unix)", "refs/heads"]);
  const at = new Map();
  for (const line of refs.out.split("\n")) {
    const [ref, when] = line.split("\t");
    const branch = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    if (branch) at.set(branch, Number(when) || null);
  }
  const defRef = await defaultRef(repo.common);
  const prs = await prsFor(await slugOf(repo.common), ctx.fresh);
  const local = {
    ...ctx,
    at,
    defRef,
    defBranch: defRef ? defRef.split("/").slice(1).join("/") : "",
    prs,
  };
  const mainPath = worktrees[0]?.path ?? repo.main;
  const repoWithMain = { ...repo, mainPath };
  const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));
  const rows = [];
  for (const wt of worktrees.slice(1)) {
    const row = await worktreeRow(repoWithMain, wt, local);
    if (row) rows.push(row);
  }
  for (const [branch, when] of at) {
    if (checkedOut.has(branch)) continue;
    const row = await branchRow(repoWithMain, branch, when, local);
    if (row) rows.push(row);
  }
  return rows;
}

async function scanAll({ fetch = false, fresh = false, staleDays = DEFAULT_STALE_DAYS,
  backupDays = DEFAULT_BACKUP_DAYS, keep = [] } = {}) {
  const repos = await discoverRepos();
  if (fetch) {
    for (let i = 0; i < repos.length; i += 6) {
      await Promise.all(repos.slice(i, i + 6).map((repo) =>
        exec("git", ["--git-dir", repo.common, "fetch", "--quiet", "origin"], { timeout: 120000 }).catch(() => {})));
    }
  }
  const ctx = {
    fresh,
    staleDays,
    backupDays,
    live: await liveCwds(),
    patterns: [...keep, ...(await readKeep())],
  };
  const rows = [];
  for (let i = 0; i < repos.length; i += 6) {
    const batch = await Promise.all(repos.slice(i, i + 6).map(async (repo) => {
      try {
        return await rowsForRepo(repo, ctx);
      } catch {
        return [];
      }
    }));
    for (const list of batch) rows.push(...list);
  }
  rows.sort((a, b) => a.repo.localeCompare(b.repo) || String(a.branch).localeCompare(String(b.branch)));
  return { rows, repos: repos.length };
}

function publish(rows, staleDays, autoEnabled, at = Date.now()) {
  const auto = rows.filter((r) => r.verdict === "auto").length;
  const review = rows.filter((r) => r.verdict === "review");
  const ready = rows.filter((r) => r.verdict === "auto" || (r.verdict === "review" && r.checked)).length;
  setShared("branch-cleanup", {
    auto,
    review: review.length,
    ready,
    risky: auto + review.length - ready,
    total: auto + review.length,
    at,
    staleDays,
    auto: autoEnabled,
  });
}

const reportPath = () => `${appHome()}/branch-cleanup-last.json`;

async function writeReport(rows, repos, staleDays, autoEnabled, at = Date.now(),
  backupDays = DEFAULT_BACKUP_DAYS) {
  let expected = null;
  try {
    expected = await readTextFile(reportPath());
  } catch {}
  const data = {
    atMs: at,
    at: new Date(at).toISOString(),
    repos,
    staleDays,
    backupDays,
    auto: autoEnabled,
    rows,
  };
  try {
    await writeTextFile(reportPath(), `${JSON.stringify(data, null, 1)}\n`, expected);
  } catch {}
}

async function readReport() {
  try {
    return JSON.parse((await readTextFile(reportPath())) ?? "null");
  } catch {
    return null;
  }
}

const requestPath = () => `${appHome()}/branch-cleanup-request.json`;

async function readRequest() {
  try {
    return JSON.parse((await readTextFile(requestPath())) ?? "null");
  } catch {
    return null;
  }
}

async function writeRequest(data) {
  let expected = null;
  try {
    expected = await readTextFile(requestPath());
  } catch {}
  try {
    await writeTextFile(requestPath(), JSON.stringify(data), expected);
    return true;
  } catch {
    return false;
  }
}

async function markRequestHandled(at) {
  const current = await readRequest();
  if (!current || current.at !== at) return;
  await writeRequest({ ...current, handled: true });
}

function agoLabel(at) {
  if (!at) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

async function applyRows(rows) {
  const removed = [];
  const failed = [];
  const live = await liveCwds();
  for (const row of rows) {
    try {
      if (row.pr?.state === "MERGED" && row.branch) {
        const after = await afterPr(row.common, `refs/heads/${row.branch}`, row.pr);
        if (after > 0) throw new Error(`${after} commit(s) since the merged PR`);
      } else if (!row.backup && !row.allowUnpushed) {
        const ahead = await unpushed(
          row.kind === "worktree" ? row.path : row.main,
          row.kind === "worktree" ? ["HEAD"] : [`refs/heads/${row.branch}`],
        );
        if (ahead === null) throw new Error("could not verify pushed state");
        if (ahead > 0) throw new Error(`${ahead} unpushed commit(s) since the scan`);
      }
      if (row.backup && row.branch) {
        const date = new Date().toISOString().slice(0, 10);
        const tag = `branch-cleanup/${date}/${row.branch}`;
        const tagged = await git(row.main, ["tag", "-f", tag, row.branch]);
        if (!tagged.ok) throw new Error(`could not save backup tag: ${tagged.err}`);
      }
      if (row.kind === "worktree") {
        if (isLive(row.path, live)) throw new Error("in use by a live terminal");
        const status = await git(row.path, ["status", "--porcelain"]);
        if (status.ok && status.out) throw new Error("changed since the scan (uncommitted files)");
        const rm = await git(row.main, ["worktree", "remove", row.path], { timeout: 600000 });
        if (!rm.ok && !/not a working tree|no such file/i.test(rm.err)) {
          throw new Error(rm.err || "git worktree remove failed");
        }
      }
      if (row.branch) {
        const del = await git(row.main, ["branch", "-D", row.branch]);
        if (!del.ok && !/not found|no branch named/i.test(del.err)) {
          throw new Error(del.err || "git branch -D failed");
        }
      }
      removed.push(row);
    } catch (e) {
      failed.push({ row, why: e?.message ?? String(e) });
    }
  }
  return { removed, failed };
}

const own = (el) =>
  el.on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_down("right", (_e, cx) => cx.stop_propagation());

export default class BranchCleanup extends View {
  init(_props, cx) {
    this.rows = [];
    this.autoBusy = false;
    this.error = null;
    this.status = "";
    this.staleDays = DEFAULT_STALE_DAYS;
    this.backupDays = DEFAULT_BACKUP_DAYS;
    this.auto = true;
    this.keep = [];
    this.configRaw = null;
    this.lastScan = 0;
    this.autoCopy = props()?.auto === true;
    this.scroll = ScrollHandle.new();
    this.reportAt = null;
    this.syncing = false;
    this.handledRescan = 0;
    this.repos = 0;

    if (this.autoCopy) {
      if (checking()) return;
      cx.timer.after(20000, (cx) => this.autoPass(cx));
      cx.timer.every(10000, (cx) => this.autoPass(cx));
      return;
    }
    if (checking()) return;
    cx.spawn(async (cx) => {
      await this.loadConfig();
      await this.reloadReport();
      cx.timer.every(5000, (cx) => this.sync(cx));
      cx.timer.every(60000, (cx) => cx.notify());
      cx.notify();
    });
  }

  async loadConfig() {
    const cfg = await readConfig();
    this.staleDays = cfg.staleDays;
    this.backupDays = cfg.backupDays;
    this.auto = cfg.auto;
    this.keep = cfg.keep;
    this.configRaw = cfg.raw;
  }

  async saveConfig(patch) {
    const next = {
      staleDays: this.staleDays, backupDays: this.backupDays,
      auto: this.auto, keep: this.keep, ...patch,
    };
    const text = `${JSON.stringify(next, null, 2)}\n`;
    try {
      await writeTextFile(configPath(), text, this.configRaw);
      this.configRaw = text;
      return;
    } catch {}
    const cfg = await readConfig();
    try {
      await writeTextFile(configPath(), text, cfg.raw);
      this.configRaw = text;
    } catch {}
  }

  cycleAge() {
    const index = AGE_STEPS.indexOf(this.staleDays);
    this.staleDays = AGE_STEPS[(index + 1) % AGE_STEPS.length];
  }

  cycleBackup() {
    const index = BACKUP_STEPS.indexOf(this.backupDays);
    this.backupDays = BACKUP_STEPS[(index + 1) % BACKUP_STEPS.length];
  }

  // The dialog never scans: it loads the background copy's last report.
  applyReport(report) {
    const previous = new Map(this.rows.map((r) => [`${r.kind}|${r.repo}|${r.branch}`, r.checked]));
    this.rows = (report.rows ?? []).map((row) => {
      const key = `${row.kind}|${row.repo}|${row.branch}`;
      const checked = previous.has(key) ? previous.get(key) : Boolean(row.checked);
      const out = { ...row, checked };
      if (out.verdict === "keep" && checked) {
        out.override = true;
        out.backup = !out.isBackup;
        out.allowUnpushed = Boolean(out.isBackup);
      }
      return out;
    });
    this.repos = report.repos ?? 0;
    if (report.atMs > (this.reportAt ?? 0)) this.reportAt = report.atMs;
  }

  async reloadReport() {
    const report = await readReport();
    if (!report || !Number.isFinite(report.atMs)) {
      this.status = "Waiting for the first background scan…";
      return;
    }
    this.status = "";
    this.applyReport(report);
  }

  sync(cx) {
    if (this.syncing) return;
    this.syncing = true;
    cx.spawn(async (cx) => {
      try {
        const report = await readReport();
        if (report && Number.isFinite(report.atMs) && report.atMs > (this.reportAt ?? 0)) {
          this.applyReport(report);
        }
      } finally {
        this.syncing = false;
      }
      cx.notify();
    });
  }

  requestScan(cx, { fetch = false } = {}) {
    this.status = "Background scan requested…";
    cx.notify();
    cx.spawn(async (cx) => {
      await writeRequest({
        at: Date.now(), fetch, staleDays: this.staleDays, backupDays: this.backupDays,
      });
      cx.notify();
    });
  }

  async runClean(rows) {
    setShared("branch-cleanup.cleaning", { count: rows.length, at: Date.now() });
    try {
      const { removed, failed } = await applyRows(rows);
      const removedKeys = new Set(removed.map((r) => `${r.kind}|${r.repo}|${r.branch}`));
      let base = this.rows;
      if (!base.length) {
        const report = await readReport();
        base = report?.rows ?? [];
        this.repos = report?.repos ?? this.repos;
      }
      this.rows = base.filter((r) => !removedKeys.has(`${r.kind}|${r.repo}|${r.branch}`));
      const at = Date.now();
      this.lastScan = at;
      await writeReport(this.rows, this.repos, this.staleDays, this.auto, at, this.backupDays);
      publish(this.rows, this.staleDays, this.auto, at);
      if (removed.length || failed.length) {
        notify({
          title: "Branch cleanup",
          body: removed.length
            ? `Removed ${removed.length}${failed.length ? `, ${failed.length} failed` : ""}.`
            : `${failed.length} failed.`,
          level: failed.length ? "warning" : "info",
          action: { name: "mod.open", args: { name: "branch-cleanup" } },
        });
      }
    } finally {
      setShared("branch-cleanup.cleaning", null);
    }
  }

  autoPass(cx) {
    if (this.autoBusy) return;
    this.autoBusy = true;
    cx.spawn(async (cx) => {
      try {
        const request = await readRequest();
        const wanted = request && typeof request === "object" && Number.isFinite(request.at) ? request : null;
        const requested = Boolean(wanted && !wanted.handled && wanted.at > this.handledRescan);
        if (!requested && Date.now() - this.lastScan < AUTO_INTERVAL) return;
        if (requested) {
          this.handledRescan = wanted.at;
          await markRequestHandled(wanted.at);
          if (Array.isArray(wanted.clean)) {
            if (Number.isFinite(wanted.staleDays) && wanted.staleDays > 0) this.staleDays = wanted.staleDays;
            if (Number.isFinite(wanted.backupDays) && wanted.backupDays > 0) this.backupDays = wanted.backupDays;
            await this.runClean(wanted.clean);
            return;
          }
          if (Number.isFinite(wanted.staleDays) && wanted.staleDays > 0) this.staleDays = wanted.staleDays;
          if (Number.isFinite(wanted.backupDays) && wanted.backupDays > 0) this.backupDays = wanted.backupDays;
        }
        const cfg = await readConfig();
        this.auto = cfg.auto;
        this.keep = cfg.keep;
        this.configRaw = cfg.raw;
        if (!requested || !Number.isFinite(wanted?.staleDays)) this.staleDays = cfg.staleDays;
        if (!requested || !Number.isFinite(wanted?.backupDays)) this.backupDays = cfg.backupDays;
        const fetch = Boolean(requested && wanted?.fetch);
        const result = await scanAll({
          fetch, fresh: fetch, staleDays: this.staleDays, backupDays: this.backupDays, keep: this.keep,
        });
        this.rows = result.rows;
        this.repos = result.repos;
        if (cfg.auto) {
          const auto = this.rows.filter((r) => r.verdict === "auto" && r.checked);
          if (auto.length) {
            const { removed } = await applyRows(auto);
            if (removed.length) {
              this.rows = this.rows.filter((r) => !removed.includes(r));
              notify({
                title: "Branch cleanup",
                body: `Removed ${removed.length} merged ${removed.length === 1 ? "checkout" : "checkouts"}.`,
                level: "info",
                action: { name: "mod.open", args: { name: "branch-cleanup" } },
              });
            }
          }
        }
        const at = Date.now();
        this.lastScan = at;
        await writeReport(this.rows, result.repos, this.staleDays, this.auto, at, this.backupDays);
        publish(this.rows, this.staleDays, this.auto, at);
      } catch {}
      finally {
        this.autoBusy = false;
      }
    });
  }

  // Queue the cleanup for the background copy and close the dialog.
  clean(cx, overlay) {
    const selected = this.rows.filter((r) => r.checked);
    if (!selected.length) return;
    this.error = null;
    setShared("branch-cleanup.cleaning", { count: selected.length, at: Date.now() });
    cx.spawn(async (cx) => {
      const ok = await writeRequest({
        at: Date.now(), clean: selected,
        staleDays: this.staleDays, backupDays: this.backupDays,
      });
      if (ok) {
        if (overlay) closeOverlay(overlay);
        return;
      }
      setShared("branch-cleanup.cleaning", null);
      this.error = "Could not queue the cleanup.";
      cx.notify();
    });
  }

  render() {
    if (this.autoCopy) return div();
    const t = theme();
    const overlay = props()?.overlay;
    const auto = this.rows.filter((r) => r.verdict === "auto");
    const review = this.rows.filter((r) => r.verdict === "review");
    const kept = this.rows.filter((r) => r.verdict === "keep");
    const selected = this.rows.filter((r) => r.checked);

    const badge = (text, color) =>
      div().flex_none().px(5).h(16).rounded(4).bg(`${color ?? t.dim}26`).text_size(9.5)
        .font_semibold().text_color(color ?? t.dim).flex().items_center().child(text);

    const button = (id, label, onClick, { primary = false, disabled = false } = {}) =>
      own(div())
        .id(id)
        .h(26)
        .px(10)
        .rounded(6)
        .bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : t.foreground)
        .flex()
        .items_center()
        .cursor_pointer()
        .when(disabled, (el) => el.opacity(0.45))
        .when(!disabled, (el) => el.hover((e) => e.bg(primary ? t.accent : t.hover)))
        .on_click((_e, cx) => {
          if (!disabled) onClick(cx);
        })
        .child(label);

    const checkbox = (row) =>
      div().size(16).flex_none().rounded(4).border_1()
        .border_color(row.checked ? t.accent : t.border)
        .when(row.checked, (el) => el.bg(t.accent))
        .flex().items_center().justify_center()
        .when(row.checked, (el) => el.child(
          svg("mods/branch-cleanup/check.svg").size(11).flex_none().text_color(t.accent_foreground),
        ));

    const rowView = (row) => {
      const reasons = row.reasons.join("; ");
      return own(h_flex())
        .id(`bc-${row.kind}-${row.repo}-${row.branch}`)
        .h(44)
        .mx(4)
        .px(8)
        .gap(8)
        .rounded(7)
        .items_center()
        .cursor_pointer()
        .hover((e) => e.bg(t.hover))
        .tooltip(`${row.repo}/${row.branch}${row.path ? `\n${row.path}` : ""}\n${reasons}`
          + (row.kind === "worktree" && row.branch
            ? "\nDeletes the worktree and its branch."
            : row.branch ? "\nDeletes the branch." : ""))
        .on_click((_e, cx) => {
          row.checked = !row.checked;
          if (row.verdict === "keep") {
            row.override = row.checked;
            row.backup = row.checked && !row.isBackup;
            row.allowUnpushed = row.checked && Boolean(row.isBackup);
          }
          cx.notify();
        })
        .child(checkbox(row))
        .child(svg(row.kind === "worktree"
          ? "mods/branch-cleanup/folder.svg"
          : "mods/branch-cleanup/git-branch.svg").size(14).flex_none()
          .text_color(row.verdict === "keep" ? t.dim : t.muted))
        .child(
          v_flex().flex_1().min_w(0).gap(1)
            .child(
              h_flex().gap(6).items_center()
                .child(div().truncate().text_size(12.5).font_medium()
                  .text_color(row.verdict === "keep" ? t.muted : t.foreground)
                  .child(`${row.repo}/${row.branch}`))
                .when(Boolean(row.pr), (el) => el.child(badge(`#${row.pr.number} ${row.pr.state.toLowerCase()}`))),
            )
            .child(div().truncate().text_size(10.5).text_color(t.dim).child(row.path ?? reasons)),
        )
        .when(row.ageDays !== null, (el) => el.child(badge(`${row.ageDays}d`, row.risk ? t.blocked : t.dim)))
        .when(row.backup, (el) => el.child(badge("backup", t.blocked)))
        .when(row.isBackup && !row.backup, (el) => el.child(badge("backup", t.dim)))
        .when(row.verdict === "keep", (el) => el.child(
          div().flex_none().max_w(340).truncate().text_size(10).text_color(t.dim).child(reasons),
        ));
    };

    const section = (title, rows, hint, action) =>
      rows.length
        ? v_flex().gap(0)
          .child(
            h_flex().h(30).px(12).gap(8).items_center()
              .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(title.toUpperCase()))
              .child(div().text_size(10).text_color(t.dim).child(String(rows.length)))
              .when(Boolean(hint), (el) => el.child(div().text_size(10).text_color(t.dim).child(hint)))
              .child(div().flex_1())
              .when(Boolean(action), (el) => el.child(action)),
          )
          .children(rows.map(rowView))
        : null;

    const allChecked = review.length > 0 && review.every((r) => r.checked);
    const toggleAll = own(div())
      .id("bc-all")
      .h(18)
      .px(6)
      .rounded(4)
      .bg(t.raised)
      .text_size(10)
      .text_color(t.muted)
      .flex()
      .items_center()
      .cursor_pointer()
      .hover((el) => el.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        const next = !allChecked;
        for (const row of review) row.checked = next;
        cx.notify();
      })
      .child(allChecked ? "none" : "all");

    const header = h_flex()
      .h(52)
      .px(14)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(svg("mods/branch-cleanup/git-branch.svg").size(18).flex_none().text_color(t.accent))
      .child(
        v_flex().gap(1).min_w(0)
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Branch cleanup"))
          .child(div().truncate().text_size(10.5).text_color(this.error ? t.blocked : t.dim)
            .child(this.error ?? `${auto.length} auto · ${review.length} to review · ${kept.length} kept${this.reportAt ? ` · scanned ${agoLabel(this.reportAt)}` : ""}`)),
      )
      .child(div().flex_1())
      .child(button("bc-auto", this.auto ? "Auto: on" : "Auto: off", (cx) => {
        this.auto = !this.auto;
        this.saveConfig({ auto: this.auto });
        publish(this.rows, this.staleDays, this.auto, this.reportAt ?? Date.now());
        cx.notify();
      }))
      .child(button("bc-age", `Stale: ${this.staleDays}d`, (cx) => {
        this.cycleAge();
        this.saveConfig({ staleDays: this.staleDays });
        this.requestScan(cx, { fetch: false });
      }))
      .child(button("bc-backup", `Backups: ${this.backupDays}d`, (cx) => {
        this.cycleBackup();
        this.saveConfig({ backupDays: this.backupDays });
        this.requestScan(cx, { fetch: false });
      }))
      .child(button("bc-scan", "Rescan", (cx) => this.requestScan(cx, { fetch: true })))
      .child(button("bc-close", "Close", () => {
        if (overlay) closeOverlay(overlay);
      }));

    const sections = [
      section("Ready to clean", auto, this.auto ? "auto" : "auto is off"),
      section("Review", review, "unmerged, closed PR or stale", toggleAll),
      section("Kept", kept, "click to override"),
    ].filter(Boolean);

    const body = v_flex()
      .id("bc-body")
      .flex_1()
      .min_h(0)
      .py(4)
      .overflow_y_scrollbar()
      .track_scroll(this.scroll)
      .when(sections.length === 0, (el) => el.child(
        div().p(24).text_size(12).text_color(t.dim).child(this.status || "Nothing to clean."),
      ))
      .children(sections);

    const footer = h_flex()
      .h(50)
      .px(14)
      .gap(8)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .when(Boolean(this.status), (el) => el.child(
        div().truncate().text_size(10.5).text_color(this.error ? t.blocked : t.dim).child(this.status),
      ))
      .child(div().flex_1())
      .child(button("bc-clean", `Clean ${selected.length}`,
        (cx) => this.clean(cx, overlay), { primary: true, disabled: selected.length === 0 }));

    return v_flex().size_full().bg(t.surface).child(header).child(body).child(footer);
  }
}


