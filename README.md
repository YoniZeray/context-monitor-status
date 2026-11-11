# Context Monitor Status

A VS Code status-bar companion for the [context-monitor](https://github.com/YoniZeray/claude-context-monitor) Claude Code mod. It shows how close the Claude chat in the focused tab is to its handoff point, and lets you create a handoff note with one click.

**It needs the mod.** The mod measures each chat and writes the readings to `.claude/context-monitor/` in your project. This extension only reads them. Without the mod, the status bar shows `○ —`.

## Install

1. Install the mod in Claude Code:
   ```
   /plugin marketplace add YoniZeray/claude-context-monitor
   /plugin install context-monitor@claude-context-monitor
   ```
2. Download `context-monitor-status-1.0.0.vsix` from this repo's [latest release](https://github.com/YoniZeray/context-monitor-status/releases/latest), then run:
   ```
   code --install-extension context-monitor-status-1.0.0.vsix
   ```
3. Start a new Claude chat in VS Code. The gauge appears after its first reply.

## What it shows

- **Status bar.** A pie and a percent, such as `◔ 34%`. The gauge counts from the setup tokens every chat starts with (0%) up to the mod's handoff threshold (100%). It turns amber, then red, as the chat gets close.
- **Hover.** A ring, the token count, the share of the context window used, and the setup tokens left out of the percent. It also shows the state of the latest handoff and has a **Create handoff** button.
- **Click.** Opens `.claude/handoffs/latest.md`.
- **Popups.** You get one warning per chat when it reaches `warnAtTokens`. After a handoff is saved, it offers to start a new chat. In a fresh chat, it reminds you that a recent handoff is waiting: type `continue` to pick it up.

With several Claude tabs open, it shows the chat in the focused tab, matched by the tab title. When no single chat matches, it shows the chat that was active most recently.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `contextMonitorStatus.warnAtTokens` | 100000 | Ask once per chat whether to create a handoff at this many tokens. 0 turns it off. |
| `contextMonitorStatus.offerNewChat` | true | Offer a new chat after a handoff, and point out a recent handoff in a fresh chat. |

The handoff threshold and the colors are set in the mod's own settings (`/plugin`).

## Commands

- `Context Monitor: Create handoff now`
- `Context Monitor: Open latest handoff`
- `Context Monitor: Refresh`

## License

MIT
