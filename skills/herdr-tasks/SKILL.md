---
name: herdr-tasks
description: Register, edit or remove the action chips in Herdr's New Task (⌘T) dialog by editing ~/.config/herdr-app/tasks.json. Use when asked to add a task/action to Herdr's New Task modal, list or fix its chips, or make a command available in a project's task menu.
---

# Herdr task chips

Herdr's **New Task** dialog (`new-task` mod, ⌘T) shows a Run row of action chips
next to the agent: the chosen project's tasks, plus global tasks that apply.
The chips come from one JSON file:

```
${HERDR_APP_HOME:-~/.config/herdr-app}/tasks.json
```

Adding a task is a JSON edit — no mod code, no restart of the file's reader
beyond reopening the dialog.

## Format

An object keyed by group. Each group is an array of tasks:

```json
{
  "*": [
    { "name": "psclaude", "command": "psclaude", "requiresPR": true, "acceptsTask": true }
  ],
  "duck-force": [
    { "name": "Start", "command": "pnpm start" }
  ]
}
```

A task:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The chip's label. Keep it short (the built-in `+ Task` form truncates a command to 30 chars). |
| `command` | yes | One fish command line, run with `fish -lc <command>` in the chosen checkout. |
| `requiresPR` | no | Only shown when the selected row has an attached PR. |
| `acceptsTask` | no | The composer's "Extra instructions" text is appended as one quoted argument: `<command> 'the text'`. |

- Group keys are project names: the folder name of the chosen checkout (for a
  PR or worktree, the project that owns it). `"*"` holds global tasks, shown
  for every project whose requirement matches.
- A task with no `name` or `command` is ignored.
- Adding a task with an existing `name` in the same group replaces it (the
  `+ Task` form filters the name out before appending).
- Tasks are shown in array order after the agent chip.

## How to add or change one

1. Read the file first. If it is missing or empty, treat it as `{}`.
2. Parse it; refuse to continue if it is not a JSON object (report the parse
   error instead of overwriting it).
3. Merge: keep every other group and every other task exactly as it is. Append
   the new task, or replace the one with the same `name` in that group.
4. Write it back as 2-space-indented JSON with a trailing newline, matching the
   app's own `JSON.stringify(data, null, 2) + "\n"`.
5. Validate with `python3 -m json.tool <file>` (or `jq . <file>`).
6. Tell the person the chip appears the next time the New Task dialog opens;
   if it does not, close and reopen the dialog or restart Herdr.

Prefer the dialog's own `+ Task` form when a person is at the machine (it
saves and runs the task in one step). Use this file when an agent is asked to
register one.

## Rules

- Never put secrets, tokens or credentials in `command`; it is plain text in
  the person's config and may be shared.
- Do not reorder or rewrite unrelated entries; diffs should stay small.
- Commands run through the person's fish login shell, in the checkout, with
  Herdr's environment — the same place a terminal opened from Herdr runs.
- `name` is only a label. The `+ Task` form derives it from the command; a
  hand-written name is free to differ.
- Project groups are matched by folder name, so a task for a repo applies to
  every checkout of it, including worktrees.
