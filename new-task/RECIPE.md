# New Task

One dialog (⌘T) to start an agent or a task in the right checkout: search
running sessions, your PRs and unlinked worktrees, or pick a project and create
a worktree from it. It also registers task chips into `tasks.json`, which is
what the `herdr-tasks` skill edits.

**Install:** copy `mods/new-task/` into `~/.config/herdr-app/mods/` and run
`herdr-app check ~/.config/herdr-app/mods/new-task`. Add `cmd-t` to
`~/.config/herdr-app/keys.json` (`"global": { "cmd-t": "mod.open:new-task" }`)
or use the Agent bar's New Task button. Needs `gh` (authenticated) and `git`.

## What you see

An 880×720 dialog, top to bottom:

- **Search field**, with a mode row: **Running / PRs / Worktrees / New**. The
  active mode is a filled chip; Tab/Shift-Tab cycle modes while browsing.
- **Results.** Running sessions list live agents and shells. PRs are the
  authored, assigned and local PRs (`gh` searches). Worktrees are linked
  checkouts not already shown as a space, with the repo group above each.
  New lists projects (top-level git checkouts in `~/Development`, plus
  `projects.json` roots).
- **Composer**, revealed when a row is chosen: the agent chip (Claude Code), the
  project's task chips, **Terminal**, and **+ Task**. The black chip is the
  active stop; Enter runs it or opens the form. A **Terminal** run opens a shell
  in the chosen checkout (creating it first when a PR or new worktree has none)
  and its prompt is an optional command to run there. A task with `acceptsTask`
  shows an **Extra instructions (optional)** field instead.
- **Primary button** names the stop Tab is on (`Open terminal`, `Choose base`),
  else the action's own label.
- **New worktree** is the exception: its only stops are the **From** base row and
  the task text; the Run row is hidden, an **Open terminal** button sits beside
  **Create worktree**, and the branch name is previewed under the text.

## How it behaves

- Tab and Shift-Tab are bound in the mod's own keymap under the `NewTask` key
  context (a focused text input swallows Tab before the view sees it). Esc
  closes the base picker, then the composer (including an open + Task form),
  the manual row, and finally the dialog.
- Choosing a PR or worktree with no checkout fetches `pull/<n>/head` and creates
  `~/Development/.worktrees/<repo>/<branch>` (from `settings.json`'s
  `worktrees.directory`).
- Tasks come from `tasks.json`, keyed by project name; `"*"` holds global tasks.
  A task is `{ "name", "command", "requiresPR"?, "acceptsTask"? }`.
- **+ Task** replaces the prompt row with one command field; Enter or **Add &
  run** saves the task to `tasks.json` and runs it, so the chip is available
  next time. The name is the command truncated to fit a chip.
- Agents and tasks run as labelled core terminals
  (`hc run --keep --label herdr.space=… --label herdr.tab=…`), so Herdr shows
  them as tabs and closes a tab when its program exits. Agents run as
  `fish -lic 'exec $argv[2..]' fish <agent> <task>`; tasks as `fish -lc <command>`.
- `bases.json` overrides a new worktree's base branch by GitHub repo, project
  folder or path; a bare name resolves to the remote-tracking branch, else the
  local branch.

## Built from

`gpui-kit`, `gpui-base`, `herdr` (`spaces`, `agents`, `panes`, `run`, `theme`,
`props`, `closeOverlay`, `exec`, `hc`, `home`, `appHome`, `readTextFile`,
`writeTextFile`, `knownAgents`, `shared`, `setShared`). Programs: `gh` (PR
search, `pr view`), `git` (worktree/branch), `hc` (run). Files read:
`tasks.json`, `projects.json`, `bases.json`, `settings.json`.

## Watch out

- Everything is fish-flavoured: tasks run through `fish -lc`, and one argument
  is quoted for fish (`'…'` with `'\''` escaping).
- `gh` must be installed and authenticated for the PRs tab; without it that
  mode is empty.
- The dialog reads `tasks.json` when it opens. An edit made outside the dialog
  appears on the next open (the `tasks` layout keeps a zero-size cache copy of
  this mod alive for the background data, so a reload of the mod itself is not
  needed).
- A task name longer than 30 characters is truncated with `…` in the chip.
- The hidden cache block in the `tasks` layout is what keeps the background
  refresh alive between opens; removing it makes every open start cold.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/new-task` passes.
- ⌘T opens the dialog, typing filters Running, and Tab cycles Running/PRs/Worktrees/New.
- Choosing a project reveals the composer; Enter on Claude starts an agent tab in
  that checkout and the tab is renamed.
- Choosing a PR with no checkout creates `~/Development/.worktrees/<repo>/<branch>`
  and starts there.
- + Task adds a chip, and the same task is present in `tasks.json` under the
  project's group.
