# Tasks layout

Herdr's `main` without the sidebar: the Agent bar across the top, one terminal
below it with a pane header, and Herdr's Files/Changes panel hidden but still
reachable. Two zero-size blocks keep New Task and Branch cleanup alive in the
background.

**Install:** copy `layouts/tasks.json` into `~/.config/herdr-app/layouts/` and
install the `agent-bar`, `new-task` and `branch-cleanup` mods (this repo's
`install.sh` does all of it). Switch with `herdr-app do layout.switch --name tasks`
or ⌘⇧L. It is a clone of Herdr's `main` (0.1.18), so it does not get later
changes to `main`.

## What you see

Top to bottom:

- **Agent bar**, 138px, a block showing `agent-bar`; the window drags by it.
- **Work body**, a row with 8px padding and gap:
  - **Main**, a lone active tab: one pane, radius 10, 1px `border` (1px `accent`
    when focused), with a 30px top header showing Herdr's `pane` mod.
  - **Panel**, 368px, hidden by default (`"hidden": true`), holding a stack of
    Herdr's `files` (active) and `changes` mods. ⌘B or the Agent bar's Files
    button shows and hides it.
- **Two zero-size blocks** after the row: `new-task` and `branch-cleanup` with
  `props: { "auto": true }`. They never show; they keep those mods running so
  the New Task cache stays warm and the branch scan runs every 15 minutes.

There is no sidebar and no tab bar; tabs are selected with ⌘1–⌘9 and cycled with
⌃Tab.

## Built from

Herdr's shipped `pane`, `files` and `changes` mods, plus this repo's `agent-bar`,
`new-task` and `branch-cleanup`. No custom art.

## Watch out

- The zero-size cache blocks are load-bearing. Removing them makes New Task
  start cold and stops background branch scans.
- The panel is hidden, not removed: if your layout has no `panel` id, ⌘B and the
  Files button have nothing to toggle.
- `cloned_from` records Herdr `main` 0.1.18. Herdr does not update clones, so
  compare against `main` after Herdr updates if something looks stale.
- The layout expects the three mods to be installed; missing ones show as empty
  blocks.

## Done when

- `herdr-app do layout.switch --name tasks` shows the bar, one terminal and no
  sidebar.
- ⌘T opens New Task, ⌘⇧B opens Branch cleanup, ⌘B toggles the Files panel.
- After a minute, `~/.config/herdr-app/branch-cleanup-last.json` exists and the
  Agent bar shows a cleanup count.
