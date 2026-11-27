# Branch cleanup

One dialog (⌘⇧B, the command palette, or the Agent bar's "N to clean" pill) that
finds merged, closed-PR and stale branches and worktrees, and deletes the ones
you pick. A hidden copy runs the scans in the background.

**Install:** copy `mods/branch-cleanup/` into `~/.config/herdr-app/mods/` and run
`herdr-app check ~/.config/herdr-app/mods/branch-cleanup`. Add
`cmd-shift-b` to `~/.config/herdr-app/keys.json`
(`"global": { "cmd-shift-b": "mod.open:branch-cleanup" }`), or use the palette
entry. For the background scans, put a zero-size copy in your layout:
`{ "id": "branch-cleanup-cache", "type": "block", "size": { "px": 0 }, "content": { "mod": "branch-cleanup", "props": { "auto": true } } }`.
Needs `git` and `gh`.

## What you see

A 900×720 dialog:

- **Header:** "Branch cleanup", a **Rescan** button, and chips for the **Stale**
  limit (default 30 days) and **Backups** retention (default 14 days); clicking
  a chip cycles it. A `Clean N` button appears when rows are selected.
- **Rows**, one per worktree or branch, with the repo group above them. Each row
  shows its branch, what it is (worktree/branch), its age, and the verdict:
  `Ready`, `Review`, `Kept`, `Backup`, or a running state. Reasons are listed on
  the row (merged PR, closed PR, stale, backup branch, keep-list, unpushed
  commits). A row with a worktree deletes the worktree and its branch together.
- **Background state** shows in the Agent bar as `Cleaning N…` while a batch
  runs and `N to clean` otherwise (clicking it opens this dialog).

## How it behaves

- Scans run when the background copy starts, every 15 minutes, and when the
  dialog asks. The dialog opens from the last scan (`branch-cleanup-last.json`)
  and never scans itself; **Rescan** queues a background scan.
- A merged PR is verified against the PR's head commit (`headRefOid`, fetching
  `pull/<n>/head` once if missing), not remote-tracking refs — after a squash
  merge or a deleted PR branch those make commits look unpushed. Only commits
  beyond the PR head hold a row back.
- Auto-clean removes merged, clean worktrees/branches with no age gate. Closed-PR
  branches and unmerged branches/worktrees older than the stale limit are
  reviewed. `backup` branches are kept for the backup limit and then reviewed.
- Default branches are left out of the report entirely.
- Overriding a `Kept` row that is not a backup first saves its tip as a
  `branch-cleanup/<date>/<branch>` tag. A stale row with unpushed commits is
  also tagged before deletion.
- **Clean N** queues the selected rows, closes the dialog, and the background
  copy applies them.

## Config and state (all in `~/.config/herdr-app/`)

- `branch-cleanup.json` — `{ "staleDays", "backupDays", "keep": [patterns] }`.
- `branch-cleanup-keep` and the old `~/.config/worktree-gc/keep` — extra keep
  patterns.
- `branch-cleanup-last.json` — the last scan, what the dialog opens from.
- `branch-cleanup-request.json` — scan/clean requests handed to the background
  copy.
- `shared("branch-cleanup")` — counts the Agent bar reads.

## Built from

`gpui-kit`, `gpui-base`, `herdr` (`run`, `theme`, `props`, `closeOverlay`,
`exec`, `appHome`, `readTextFile`, `writeTextFile`, `setShared`, `notify`,
`checking`). Programs: `git` (worktree/branch/ref/tag), `gh` (PR state, head
ref), `lsof` (busy directories).

## Watch out

- It deletes branches and worktrees. The only safety nets are the keep list, the
  PR-head check, and backup tags; a `Kept` override on a non-backup row tags
  first.
- `gh` must be authenticated for PR verification; without it rows fall back to
  the stale/age rules.
- Branch names are read from full refs, so a name that is also a tag does not
  split into two rows.
- The background copy must stay in the layout; without it the dialog opens from
  an old report and **Rescan** queues work nothing will run.
- The dialog never scans itself, so the first open on a fresh install can be
  empty until the background copy's first scan.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/branch-cleanup` passes.
- With the background copy in the layout, `branch-cleanup-last.json` appears and
  the Agent bar shows a count.
- ⌘⇧B opens the dialog with rows and their reasons.
- Selecting a merged, clean worktree and clicking **Clean N** removes the
  worktree and branch, and the counts update.
