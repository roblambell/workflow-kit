# Using ninthwave with iTerm2

[iTerm2 has built-in tmux integration](https://iterm2.com/documentation-tmux-integration.html) called **control mode**. When you launch tmux with the `-CC` flag, iTerm2 renders each tmux window as a native tab. Ninthwave workers show up as regular iTerm2 tabs you can click between -- no tmux keybindings required.

## Quick start

1. Open iTerm2
2. Start a tmux session in control mode:

```bash
tmux -CC new -s nw
```

3. iTerm2 will display a small `** tmux mode started **` banner. You're now inside a tmux-managed session that looks and feels like normal iTerm2.

4. Run ninthwave:

```bash
nw
```

Each worker the orchestrator launches will appear as a new iTerm2 tab.

## Reattaching to an existing session

If you close iTerm2 or disconnect, workers keep running in the background. To reconnect:

```bash
tmux -CC attach -t nw
```

Your tabs reappear exactly where you left them.

## Tips

- **Naming:** ninthwave names each tmux window after the work item ID (e.g., `nw_H-AUTH-1`), which shows up in the iTerm2 tab title.
- **Scrollback:** iTerm2's native scrollback works normally in control mode -- scroll up to see worker output history.
- **Multiple projects:** each project gets its own tmux session (e.g., `nw-myapp`, `nw-api`). You can run multiple projects simultaneously.

## iTerm2 preferences

Under **iTerm2 > Settings > General > tmux**:

- **When attaching, open unrecognized windows in:** Tabs (default, recommended)
- **Automatically bury the tmux client session after connecting:** On (hides the control session, less clutter)
