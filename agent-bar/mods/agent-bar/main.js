// Wrapping top bar: agents as cards, child terminals nested under the card that
// started them, and their listening servers underneath.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import {
  agents, terminals, panes, spaces, run, theme, openOverlay, setAgentOrder,
  keys, window as win, exec, notify, checking, layout, shared, focused,
} from "herdr";

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

// The card grid: a fixed width and one 26px row unit. A plain card is two
// units; a card with a linked parent, servers or child rows spans more.
const CARD_W = 232;
const GAP = 6;
const UNIT = 26;
const PAD = 6;
const BASE_H = 50;   // title and where lines
const LINK_H = 15;   // the linked-parent line
const SERVER_H = 23; // a row of server chips
const SUB_H = 20;    // one nested child row

const spanFor = (extras) =>
  Math.max(2, Math.ceil((BASE_H + extras.reduce((n, h) => n + h, 0) + GAP) / (UNIT + GAP)));
const spanH = (span) => span * UNIT + (span - 1) * GAP;

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// Row-major grid placement, dense: each card takes the first free slot that
// fits its row span, so a tall card leaves no hole beside it.
function placeGrid(cards, cols) {
  const taken = [];
  const free = (row, col, span) => {
    for (let r = row; r < row + span; r++) if (taken[r]?.has(col)) return false;
    return true;
  };
  const out = [];
  for (const card of cards) {
    let done = false;
    for (let row = 0; !done; row++) {
      for (let col = 0; col < cols; col++) {
        if (!free(row, col, card.span)) continue;
        for (let r = row; r < row + card.span; r++) (taken[r] ??= new Set()).add(col);
        out.push({ ...card, row, col });
        done = true;
        break;
      }
    }
  }
  return out;
}

// The repo a checkout belongs to: the segment after `.worktrees/` or
// `Development/`, else the folder's own name. Space names are usually branches,
// so this is the group an agent is working in.
function repoOf(path) {
  const p = (path ?? "").replace(/\/+$/, "");
  if (!p) return null;
  const worktree = /\/\.?worktrees\/([^/]+)\//.exec(p);
  if (worktree) return worktree[1];
  const dev = /\/Development\/([^/]+)/.exec(p);
  if (dev) return dev[1];
  return p.split("/").pop() || null;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function togglePanel() {
  const panel = find(layout(), "panel");
  if (panel?.hidden) {
    run("layout.select", { stack: "panel-body", child: "files" });
    run("layout.show", { id: "panel" });
  } else {
    run("layout.hide", { id: "panel" });
  }
}

// A control in the draggable bar: the press is its own, not the window's.
const own = (el) =>
  el.on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_down("right", (_e, cx) => cx.stop_propagation());

// Drops what an agent puts before its title: a status glyph or spinner and the
// separator after it, and Codex's blinking "[ ! ] " mark. Keeps a leading
// bracket, quote or emoji that is part of the title.
function clean(s) {
  return (s ?? "")
    .replace(/^(?:\[ [!.] \] |[✋⏳]️?(?=\s)|(?!(?:\p{Emoji}️|[#*]⃣))[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}])+/u, "")
    .trim();
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint
    ? svg(p.icon).size(size).flex_none().text_color(color)
    : image(p.icon).w(size).h(size).flex_none();
}

function statusGlyph(t, status) {
  if (status === "working") return svg("mods/agent-bar/spinner.svg").size(13).flex_none().text_color(t.working).spin(900);
  if (status === "blocked") return div().size(8).flex_none().rounded(4).bg(t.blocked);
  if (status === "done") return div().size(8).flex_none().rounded(4).bg(t.done);
  return div().size(8).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
}

function portOf(addr) {
  const m = /:(\d+)$/.exec(addr ?? "");
  return m ? Number(m[1]) : null;
}

// Prefer the URL the program put in its title (Vite, Next, Rails), else the port.
function urlFor(term, port) {
  const m = /https?:\/\/[^\s"'<>]+/.exec(term.title ?? "");
  if (m && m[0].includes(`:${port}`)) return m[0].replace(/[),.;]+$/, "");
  return `http://localhost:${port}`;
}

// Listening TCP ports, mapped back to the Herdr terminal that owns the process.
// A server started in a shell is a grandchild of the terminal's pid, so walk up.
async function scanServers() {
  const live = terminals().filter((t) => t.state === "live");
  if (!live.length) return new Map();

  let lsof;
  try {
    lsof = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { timeout: 5000 });
  } catch {
    return new Map();
  }
  if (lsof.code !== 0 && !lsof.stdout) return new Map();

  let ps = { stdout: "" };
  try {
    ps = await exec("ps", ["-axo", "pid=,ppid="], { timeout: 5000 });
  } catch {}

  const listeners = new Map();
  let pid = null;
  for (const line of (lsof.stdout ?? "").split("\n")) {
    if (!line) continue;
    const tag = line[0], val = line.slice(1);
    if (tag === "p") {
      pid = Number(val);
      if (Number.isFinite(pid) && !listeners.has(pid)) listeners.set(pid, { command: "", ports: new Set() });
    } else if (tag === "c" && pid) {
      listeners.get(pid).command = val;
    } else if (tag === "n" && pid) {
      const port = portOf(val);
      if (port) listeners.get(pid).ports.add(port);
    }
  }

  const ppid = new Map();
  for (const line of (ps.stdout ?? "").split("\n")) {
    const [a, b] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) ppid.set(a, b);
  }

  const byPid = new Map();
  for (const t of live) {
    if (t.pid) byPid.set(t.pid, t);
    if (t.foreground?.pid) byPid.set(t.foreground.pid, t);
  }

  const result = new Map();
  for (const [lpid, info] of listeners) {
    let p = lpid, hops = 0;
    while (p && p > 1 && hops++ < 16) {
      const t = byPid.get(p);
      if (t) {
        // An agent's own control port (Claude Code's IPC listener) is not a server.
        if (t.program?.agent && lpid === t.foreground?.pid) break;
        const entry = result.get(t.address) ?? { terminal: t, ports: new Map() };
        for (const port of info.ports) if (!entry.ports.has(port)) entry.ports.set(port, info.command);
        result.set(t.address, entry);
        break;
      }
      p = ppid.get(p);
    }
  }
  return result;
}

// The key as actually bound, so the hint never lies.
function shortcut(action) {
  const b = keys().find((k) => k.section === "global" && k.action === action);
  if (!b?.keys?.trim()) return "";
  const mac = win()?.platform === "macos";
  const names = mac
    ? { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", fn: "fn" }
    : { cmd: "Super", ctrl: "Ctrl", alt: "Alt", shift: "Shift", fn: "Fn" };
  return b.keys.trim().split(/\s+/).map((stroke) => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = parts.map((m) => names[m.toLowerCase()] ?? m);
    if (/^[A-Z]$/.test(key)) held.push(mac ? "⇧" : "Shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return held.join(mac ? "" : "+") + label;
  }).join(" ");
}

export default class AgentBar extends View {
  init(_props, cx) {
    this.servers = new Map();
    this.scanning = false;
    this.scroll = ScrollHandle.new(); // the card area's width, for the grid
    if (checking()) return;
    this.scan(cx);
    cx.timer.every(4000, (cx) => this.scan(cx));
    // The first frame has no viewport yet; redraw once it has one.
    cx.timer.after(120, (cx) => cx.notify());
  }

  scan(cx) {
    if (this.scanning) return;
    const w = win();
    if (w && !w.visible) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        this.servers = await scanServers();
      } catch {
        this.servers = new Map();
      }
      this.scanning = false;
      cx.notify();
    });
  }

  focusTerminal(s) {
    if (s.pane) run("pane.focus", { pane: s.pane });
    else run("terminal.peek", { terminal: s.term.address });
  }

  openLink(url) {
    exec("open", [url], { timeout: 5000 })
      .catch(() => notify({ title: "Could not open link", body: url, level: "error" }));
  }

  serverChip(t, s) {
    const label = `${s.command || s.term.program?.name || "server"} :${s.port}`;
    return own(h_flex())
      .id(`sv-${s.term.address}-${s.port}`)
      .flex_none()
      .h(19)
      .pl(4)
      .pr(2)
      .gap(3)
      .rounded(4)
      .bg(t.raised)
      .items_center()
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(`${s.url}\nClick to focus the terminal; ↗ opens the link`)
      .on_click((_e, cx) => { cx.stop_propagation(); this.focusTerminal(s); })
      .child(svg("mods/agent-bar/server.svg").size(10).flex_none().text_color(t.dim))
      .child(div().text_size(10).text_color(t.muted).child(label))
      .child(
        own(div())
          .id(`sv-open-${s.term.address}-${s.port}`)
          .px(3)
          .rounded(3)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((el) => el.bg(t.selected).text_color(t.foreground))
          .tooltip(s.url)
          .on_click((_e, cx) => { cx.stop_propagation(); this.openLink(s.url); })
          .child(div().text_size(11).child("↗")),
      );
  }

  render(cx) {
    const t = theme();
    const w = win() ?? {};
    const all = agents();
    const terms = terminals();
    const paneMap = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p.pane]));
    const paneCwd = new Map(panes().map((p) => [p.pane, p.cwd]));
    const spaceFolder = new Map(spaces().map((s) => [s.id, s.folder]));
    const byAddr = new Map(terms.map((x) => [x.address, x]));
    const live = new Map(terms.filter((x) => x.state === "live").map((x) => [x.address, x]));
    const agentAddrs = new Set(all.map((a) => a.address));
    const agentByAddr = new Map(all.map((a) => [a.address, a]));

    // Cards are agents, plus shells that stand alone or were popped out into
    // their own tab/space. Every other live terminal is a sub-item of the card
    // its parent chain reaches.
    const cardAddrs = new Set(agentAddrs);
    const shells = [];
    const transient = [];
    const liveAncestor = (addr) => {
      let p = byAddr.get(addr)?.parent, hops = 0;
      while (p && hops++ < 12) {
        if (byAddr.get(p)) return true;
        p = byAddr.get(p)?.parent;
      }
      return false;
    };
    for (const x of terms) {
      if (x.state !== "live" || agentAddrs.has(x.address)) continue;
      const popped = paneMap.has(x.address) || Boolean(x.labels?.["herdr.space"]);
      if (popped || !liveAncestor(x.address)) {
        cardAddrs.add(x.address);
        shells.push(x);
      } else {
        transient.push(x);
      }
    }
    const parentCard = (addr) => {
      let p = byAddr.get(addr)?.parent, hops = 0;
      while (p && hops++ < 12) {
        if (cardAddrs.has(p)) return p;
        p = byAddr.get(p)?.parent;
      }
      return null;
    };
    const transientAddrs = new Set(transient.map((x) => x.address));

    const nameOf = (addr) => {
      const a = agentByAddr.get(addr);
      if (a) return clean(a.title) || (/^\d+$/.test(a.tab_name ?? "") ? "" : a.tab_name) || a.program?.name || a.address;
      const x = byAddr.get(addr);
      return clean(x?.title) || x?.name || x?.foreground?.command || x?.program?.name || addr;
    };

    const cardByTab = new Map();
    for (const a of all) if (!cardByTab.has(a.tab)) cardByTab.set(a.tab, a.address);
    for (const x of shells) {
      const tab = x.labels?.["herdr.tab"] ?? x.tab;
      if (tab && !cardByTab.has(tab)) cardByTab.set(tab, x.address);
    }

    // Attach each listening terminal to the card that owns it: a parent chain
    // first (hc run from an agent), else the first card in the same tab.
    const attached = new Map();
    const standalone = [];
    for (const [addr, entry] of this.servers) {
      const term = live.get(addr);
      if (!term || agentAddrs.has(addr)) continue;
      const pane = paneMap.get(addr) ?? null;
      const servers = [...entry.ports].map(([port, command]) => ({
        term, pane, port, command, url: urlFor(term, port),
      }));
      if (!servers.length) continue;
      let owner = null, p = term.parent, hops = 0;
      while (p && hops++ < 12) {
        if (cardAddrs.has(p)) { owner = p; break; }
        p = byAddr.get(p)?.parent;
      }
      if (!owner) owner = cardAddrs.has(addr) ? addr : (cardByTab.get(term.labels?.["herdr.tab"] ?? term.tab) ?? null);
      if (owner) {
        const list = attached.get(owner) ?? [];
        list.push(...servers);
        attached.set(owner, list);
      } else {
        standalone.push(...servers);
      }
    }

    const sorted = [...all].sort((x, y) =>
      (y.pinned ? 1 : 0) - (x.pinned ? 1 : 0) ||
      (RANK[y.status] ?? 0) - (RANK[x.status] ?? 0) ||
      (y.seq ?? 0) - (x.seq ?? 0));
    setAgentOrder(sorted.map((a) => a.address));

    // Cards in display order: roots first, each popped-out child directly after
    // its parent so the link sits beside it.
    const order = [...sorted.map((a) => a.address), ...shells.map((x) => x.address)];
    const parentOf = new Map(order.map((addr) => [addr, parentCard(addr)]));
    const kids = new Map();
    for (const addr of order) {
      const p = parentOf.get(addr);
      if (p && p !== addr) push(kids, p, addr);
    }
    const seen = new Set();
    const flat = [];
    const walk = (addr) => {
      if (seen.has(addr)) return;
      seen.add(addr);
      flat.push(addr);
      for (const child of kids.get(addr) ?? []) walk(child);
    };
    for (const addr of order) if (!parentOf.get(addr)) walk(addr);
    for (const addr of order) walk(addr);

    // Transient children stay under their immediate parent, which may itself be
    // a transient child; a missing parent falls back to the nearest card.
    const transientKids = new Map();
    for (const x of transient) {
      const p = x.parent;
      const host = p && (cardAddrs.has(p) || transientAddrs.has(p)) ? p : parentCard(x.address);
      if (host) push(transientKids, host, x);
    }

    const subRow = (x, depth, last) => {
      const pane = paneMap.get(x.address) ?? null;
      const name = clean(x.title) || x.name || x.foreground?.command || x.program?.name || x.address;
      const pic = icon(x.program, 12, t.muted);
      return own(h_flex())
        .id(`ab-sub-${x.address}`)
        .h(17)
        .pl(depth * 9)
        .gap(4)
        .items_center()
        .rounded(4)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip(`${name}\nClick to ${pane ? "focus" : "peek"}${x.status ? ` · ${x.status}` : ""}`)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (pane) run("pane.focus", { pane });
          else run("terminal.peek", { terminal: x.address });
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({
            mod: "menu", kind: "popup", width: 200,
            props: { tab: "pane", target: { pane, terminal: x.address } },
          });
        })
        .child(div().flex_none().text_size(9.5).text_color(t.dim).child(last ? "└─" : "├─"))
        .when(Boolean(x.status), (el) => el.child(statusGlyph(t, x.status)))
        .when(!x.status, (el) => el.child(
          div().size(6).flex_none().rounded(3).border(1.2).border_color(t.dim),
        ))
        .when(Boolean(pic), (el) => el.child(pic))
        .child(div().flex_1().min_w(0).truncate().text_size(11)
          .text_color(x.status === "working" ? t.foreground : t.muted).child(name));
    };

    const subRows = (addr, depth = 0, out = [], seenSub = new Set()) => {
      const list = (transientKids.get(addr) ?? []).filter((x) => !seenSub.has(x.address));
      list.forEach((x, i) => {
        seenSub.add(x.address);
        out.push(subRow(x, depth, i === list.length - 1));
        subRows(x.address, depth + 1, out, seenSub);
      });
      return out;
    };

    const active = spaces().find((s) => s.active);
    const needs = all.filter((a) => a.status === "blocked").length;
    const cleanup = shared("branch-cleanup") ?? {};
    const cleanupTotal = Number(cleanup.total) || 0;
    const cleaning = shared("branch-cleanup.cleaning") ?? {};
    const cleaningCount = Number(cleaning.count) || 0;

    const card = (a) => {
      const name = nameOf(a.address);
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      const servers = attached.get(a.address) ?? [];
      const pic = icon(a.program, 15, t.foreground);
      const where = a.space_name + (a.tab_name && !/^\d+$/.test(a.tab_name) ? ` · ${a.tab_name}` : "");
      const group = repoOf(paneCwd.get(a.pane) ?? spaceFolder.get(a.space));
      const link = parentOf.get(a.address) ?? null;
      const siblings = link ? (kids.get(link) ?? []) : [];
      const lastSibling = siblings[siblings.length - 1] === a.address;
      const subs = subRows(a.address);
      const span = spanFor([
        ...(link ? [LINK_H] : []),
        ...(servers.length ? [SERVER_H] : []),
        ...subs.map(() => SUB_H),
      ]);
      const el = own(v_flex())
        .id(`ab-${a.address}`)
        .w(CARD_W)
        .flex_none()
        .p(6)
        .gap(3)
        .rounded(9)
        .border_1()
        .border_color(a.focused ? t.accent : t.border)
        .bg(a.focused ? t.selected : t.surface)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip(`${name}\n${where}${machine ? ` · ${machine}` : ""}${link ? `\nunder ${nameOf(link)}` : ""}`)
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .on_mouse_down("right", () => openOverlay({
          mod: "menu", kind: "popup", width: 200,
          props: { tab: "pane", target: { pane: a.pane, terminal: a.address } },
        }))
        .when(Boolean(link), (el) => el.child(
          div().h(12).min_w(0).truncate().text_size(9.5).text_color(t.muted)
            .child(`${lastSibling ? "└─" : "├─"} ${nameOf(link)}`),
        ))
        .when(!link && Boolean(group), (el) => el.child(
          div().min_w(0).truncate().text_size(9.5).text_color(t.muted).child(group),
        ))
        .child(
          h_flex().gap(6).items_center()
            .child(statusGlyph(t, a.status))
            .when(Boolean(pic), (el) => el.child(pic))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium()
              .text_color(a.status === "idle" ? t.muted : t.foreground).child(name))
            .when(a.pinned, (el) => el.child(svg("mods/agent-bar/pin.svg").size(11).flex_none().text_color(t.dim))),
        )
        .child(
          h_flex().gap(4).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(where))
            .when(Boolean(machine), (el) => el.child(div().text_size(9.5).text_color(t.dim).child(machine)))
            .when(a.status === "blocked", (el) => el.child(
              div().px(4).h(14).rounded(3).bg(t.blocked + "26").text_size(9.5).font_semibold()
                .text_color(t.blocked).flex().items_center().child("Needs you"),
            )),
        )
        .when(servers.length > 0, (el) => el.child(
          h_flex().flex_wrap().gap(3).items_center().children(servers.map((s) => this.serverChip(t, s))),
        ))
        .children(subs);
      return { el, span };
    };

    const shellCard = (term) => {
      const pane = paneMap.get(term.address) ?? null;
      const servers = attached.get(term.address) ?? [];
      const info = tabInfo.get(term.labels?.["herdr.tab"] ?? term.tab);
      const name = nameOf(term.address);
      const where = [info?.space?.name, info?.tab?.named ? info.tab.name : null]
        .filter(Boolean).join(" · ");
      const link = parentOf.get(term.address) ?? null;
      const siblings = link ? (kids.get(link) ?? []) : [];
      const lastSibling = siblings[siblings.length - 1] === term.address;
      const subs = subRows(term.address);
      const span = spanFor([
        ...(link ? [LINK_H] : []),
        ...(servers.length ? [SERVER_H] : []),
        ...subs.map(() => SUB_H),
      ]);
      const pic = icon(term.program, 14, t.muted);
      const el = own(v_flex())
        .id(`ab-shell-${term.address}`)
        .w(CARD_W)
        .flex_none()
        .p(6)
        .gap(3)
        .rounded(9)
        .border_1()
        .border_color(t.border)
        .bg(t.surface)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip(`${name}${where ? `\n${where}` : ""}${link ? `\nunder ${nameOf(link)}` : ""}`)
        .on_click(() => pane
          ? run("pane.focus", { pane })
          : run("terminal.peek", { terminal: term.address }))
        .on_mouse_down("right", () => openOverlay({
          mod: "menu", kind: "popup", width: 200,
          props: { tab: "pane", target: { pane, terminal: term.address } },
        }))
        .when(Boolean(link), (el) => el.child(
          div().h(12).min_w(0).truncate().text_size(9.5).text_color(t.muted)
            .child(`${lastSibling ? "└─" : "├─"} ${nameOf(link)}`),
        ))
        .child(
          h_flex().gap(6).items_center()
            .when(Boolean(term.status), (el) => el.child(statusGlyph(t, term.status)))
            .when(!term.status, (el) => el.child(
              div().size(8).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim),
            ))
            .when(Boolean(pic), (el) => el.child(pic))
            .when(!pic, (el) => el.child(svg("mods/agent-bar/terminal.svg").size(14).flex_none().text_color(t.muted)))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium()
              .text_color(t.muted).child(name)),
        )
        .child(
          h_flex().gap(4).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(where))
            .child(div().px(4).h(14).rounded(3).bg(t.raised).text_size(9.5).text_color(t.dim)
              .flex().items_center().child("Shell")),
        )
        .when(servers.length > 0, (el) => el.child(
          h_flex().flex_wrap().gap(3).items_center().children(servers.map((s) => this.serverChip(t, s))),
        ))
        .children(subs);
      return { el, span };
    };

    const tabInfo = new Map();
    for (const s of spaces()) for (const tab of s.tabs) tabInfo.set(tab.id, { space: s, tab });

    const serverCard = standalone.length > 0
      ? own(v_flex())
        .id("ab-servers")
        .w(CARD_W)
        .flex_none()
        .p(6)
        .gap(4)
        .rounded(9)
        .border_1()
        .border_color(t.border)
        .bg(t.surface)
        .child(
          h_flex().gap(6).items_center()
            .child(svg("mods/agent-bar/server.svg").size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().text_size(12.5).font_medium().text_color(t.foreground).child("Servers"))
            .child(div().text_size(10.5).text_color(t.dim).child(String(standalone.length))),
        )
        .child(h_flex().flex_wrap().gap(3).items_center().children(standalone.map((s) => this.serverChip(t, s))))
      : null;

    const iconButton = (id, name, onClick, tip) =>
      own(div())
        .id(id)
        .p(5)
        .rounded(6)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .tooltip(tip)
        .on_click(onClick)
        .child(svg(`mods/agent-bar/${name}.svg`).size(14));

    const spacePill = own(h_flex())
      .id("ab-space")
      .h(26)
      .pl(8)
      .pr(10)
      .gap(6)
      .rounded(6)
      .bg(t.raised)
      .items_center()
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip("Switch space")
      .on_click(() => openOverlay({ mod: "picker", kind: "popup", at: "top", offset: 40, width: 640, height: 0.8 }))
      .child(svg("mods/agent-bar/stack.svg").size(13).flex_none().text_color(t.muted))
      .child(div().max_w(200).truncate().text_size(12).font_medium().text_color(t.foreground).child(active?.name ?? "No space"))
      .when(Boolean(active?.machine), (el) => el.child(div().text_size(9.5).text_color(t.dim).child(active.machine)));

    const here = focused()?.cwd ?? null;
    const hereName = here ? here.replace(/\/+$/, "").split("/").pop() : null;
    const termHint = shortcut("space.new");
    const openTerminal = own(h_flex())
      .id("ab-terminal")
      .h(26)
      .pl(7)
      .pr(9)
      .gap(5)
      .rounded(6)
      .bg(t.raised)
      .items_center()
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(here ? `New terminal in ${here}` : "New terminal")
      .on_click(() => run("space.new"))
      .child(svg("mods/agent-bar/terminal.svg").size(12).flex_none().text_color(t.muted))
      .child(div().max_w(220).truncate().text_size(11.5).text_color(t.muted)
        .child(hereName ? `Open Terminal in ${hereName}` : "Open Terminal"))
      .when(Boolean(termHint), (el) => el.child(div().text_size(9.5).text_color(t.dim).child(termHint)));

    const hint = shortcut("mod.open:new-task");
    const newTask = own(h_flex())
      .id("ab-new-task")
      .h(26)
      .pl(7)
      .pr(9)
      .gap(5)
      .rounded(6)
      .bg(t.solid)
      .items_center()
      .cursor_pointer()
      .hover((el) => el.bg(t.accent))
      .tooltip("New task")
      .on_click(() => openOverlay({ mod: "new-task", kind: "dialog", width: 880, height: 720 }))
      .child(svg("mods/agent-bar/plus.svg").size(11).flex_none().text_color(t.solid_foreground))
      .child(div().text_size(11.5).font_medium().text_color(t.solid_foreground).child("New Task"))
      .when(Boolean(hint), (el) => el.child(div().text_size(9.5).text_color(t.solid_foreground).child(hint)));

    const header = h_flex()
      .h(34)
      .px(8)
      .gap(7)
      .items_center()
      .when(w.platform === "macos" && w.titlebar === "none" && !w.fullscreen, (el) => el.pl(72))
      .child(spacePill)
      .child(newTask)
      .child(openTerminal)
      .child(div().flex_1())
      .when(cleaningCount > 0, (el) => el.child(
        own(h_flex())
          .id("ab-cleaning")
          .h(24)
          .pl(7)
          .pr(8)
          .gap(5)
          .rounded(6)
          .bg(`${t.working}1f`)
          .items_center()
          .tooltip("Cleanup running in the background")
          .child(svg("mods/agent-bar/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))
          .child(div().text_size(10.5).font_semibold().text_color(t.working).child(`Cleaning ${cleaningCount}…`)),
      ))
      .when(cleaningCount === 0 && cleanupTotal > 0, (el) => el.child(
        own(h_flex())
          .id("ab-cleanup")
          .h(24)
          .pl(7)
          .pr(8)
          .gap(5)
          .rounded(6)
          .bg(`${t.accent}1f`)
          .items_center()
          .cursor_pointer()
          .hover((e) => e.bg(`${t.accent}33`))
          .tooltip(`${cleanup.review ?? 0} to review (${cleanup.ready ?? 0} ready, ${cleanup.risky ?? 0} need a look) · ${cleanup.auto ?? 0} auto-clean · click to review`)
          .on_click(() => run("mod.open", { name: "branch-cleanup" }))
          .child(svg("mods/branch-cleanup/git-branch.svg").size(11).flex_none().text_color(t.accent))
          .child(div().text_size(10.5).font_semibold().text_color(t.accent).child(`${cleanupTotal} to clean`)),
      ))
      .when(needs > 0, (el) => el.child(
        div().px(6).h(20).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold()
          .text_color(t.blocked).flex().items_center().child(`${needs} needs you`),
      ))
      .child(div().text_size(10.5).text_color(t.dim).child(`${all.length} ${all.length === 1 ? "agent" : "agents"}`))
      .when(shells.length > 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${shells.length} ${shells.length === 1 ? "shell" : "shells"}`)))
      .when(standalone.length > 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${standalone.length} ${standalone.length === 1 ? "server" : "servers"}`)))
      .child(iconButton("ab-files", "files", togglePanel, "Files"))
      .child(iconButton("ab-palette", "command", () => run("app.palette"), "Commands"))
      .child(iconButton("ab-plus", "plus", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }), "New tab or agent"));

    const items = [
      ...flat.map((addr) => agentAddrs.has(addr) ? card(agentByAddr.get(addr)) : shellCard(byAddr.get(addr))),
      ...(serverCard ? [{ el: serverCard, span: 2 }] : []),
    ];
    // The scroll area's width is the last frame's; before the first one, assume
    // the common six columns and correct on the next redraw.
    const viewW = this.scroll.viewport_size().width;
    const avail = Math.max(CARD_W, (viewW || 1440) - PAD * 2);
    const cols = Math.max(1, Math.floor((avail + GAP) / (CARD_W + GAP)));
    const placed = placeGrid(items, cols);
    const gridH = placed.reduce((h, p) => Math.max(h, p.row * (UNIT + GAP) + spanH(p.span)), 0);

    return v_flex()
      .size_full()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(header)
      .child(
        div()
          .flex_1()
          .min_h(0)
          .px(PAD)
          .pb(6)
          .overflow_y_scrollbar()
          .track_scroll(this.scroll)
          .when(items.length === 0, (el) => el.child(
            div().p(10).text_size(11.5).text_color(t.dim).child("No agents yet — start one with + or New Task."),
          ))
          .when(placed.length > 0, (el) => el.child(
            div()
              .relative()
              .w_full()
              .h(gridH)
              .children(placed.map((p) => p.el
                .absolute()
                .left(p.col * (CARD_W + GAP))
                .top(p.row * (UNIT + GAP))
                .h(spanH(p.span)))),
          )),
      );
  }
}
