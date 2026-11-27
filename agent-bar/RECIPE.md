# Agent bar

A horizontal strip of agent cards for the top of the window: one card per live
agent, plus cards for shells and servers that stand on their own, with the
terminals they spawned nested underneath. Click a card to go to it; server
chips open their `http://localhost:<port>` in the browser.

**Install:** copy `mods/agent-bar/` into `~/.config/herdr-app/mods/` and run
`herdr-app check ~/.config/herdr-app/mods/agent-bar`. Put it in a layout as a
block, e.g. `{ "id": "agentbar", "type": "block", "size": { "px": 138 }, "content": { "mod": "agent-bar" } }`;
the `tasks` item in this repo is a complete layout that uses it.

## What you see

One bar, top to bottom:

- **Header, 34px.** A space pill (stack icon, space name, machine) that opens
  Herdr's picker; a solid **New Task** button (⌘T) that opens `new-task`; an
  **Open Terminal in &lt;folder&gt;** button (⌘N) that runs `space.new` in the
  focused terminal's folder; then, right-aligned, `Cleaning N…` or `N to clean`
  (opens `branch-cleanup`), `N needs you` (blocked agents), agent/shell/server
  counts, and three icon buttons: Files (toggles the right-hand panel),
  Commands (command palette), plus (Herdr's new-tab menu).
- **Card grid.** Cards are 232px wide on a fixed 26px row unit (a plain card is
  two units; a card with a link, servers or sub-rows spans more), packed densely
  into as many columns as fit, in a vertical scroll area.
- **A card.** Rounded 10, 1px border (`accent` when focused), status glyph and
  agent name, the space/tab it lives in, the repo group it belongs to (derived
  from the pane's cwd: the segment after `.worktrees/` or `Development/`), and
  a link to its parent when it has one. A card with listening TCP servers shows
  a chip per server: click focuses the terminal, the ↗ opens
  `http://localhost:<port>`. Live terminals whose parent chain reaches a card
  are sub-rows (`├─`/`└─`) inside it; a transient child with no pane peeks on
  click, and one kept as a tab becomes its own card after its parent.
- **Shell and server cards.** A live terminal with no agent that stands alone
  (its own tab/space, or no live ancestor) gets a Shell card; a standalone
  server process gets its own card.

## How it behaves

- Status comes from Herdr's agent state; blocked outranks done, working, idle.
- The bar rescans on a timer and after its own actions. It runs `lsof` and `ps`
  to map listening ports to terminals and to build the parent chain.
- Clicking a card focuses its pane (`pane.focus`), or peeks a terminal with no
  pane (`terminal.peek`). Sub-rows behave the same way.
- The cleanup pill reads `shared("branch-cleanup")` counts written by the
  `branch-cleanup` mod; it is a summary, not a scanner.
- Server links are matched from the terminal title's URL when present, else
  from the listening port.

## Built from

`gpui-kit`, `gpui-base`, and `herdr` (`agents`, `terminals`, `panes`, `spaces`,
`run`, `theme`, `shared`, `exec`). Commands: `pane.focus`, `terminal.peek`,
`space.new`, `layout.show`/`layout.hide`/`layout.select`, `app.palette`,
`mod.open` (`branch-cleanup`, `new-task`, `picker`, `new-menu`), `overlay` via
the app. Programs: `lsof -nP -iTCP -sTCP:LISTEN -F pcn`, `ps -axo pid=,ppid=`,
`open <url>`.

## Watch out

- The 26px row unit is load-bearing: card heights are computed in units, so odd
  extra content can leave a card clipped or a gap in the grid.
- `lsof`/`ps` are local-machine only; remote spaces contribute terminals but no
  port or parent data.
- Repo grouping is a path heuristic (`.worktrees/<repo>/` or `Development/<repo>`);
  a checkout elsewhere groups by its folder name or not at all.
- A terminal whose title has no URL and no listening port shows no link.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/agent-bar` passes.
- With an agent running, a card appears with its name and space/tab; clicking
  it focuses that pane.
- Starting a local server in a terminal adds a server chip; its ↗ opens the URL
  and the chip focuses the terminal.
- ⌘T opens New Task, ⌘N opens a terminal in the focused folder, the Files button
  toggles the right-hand panel.
