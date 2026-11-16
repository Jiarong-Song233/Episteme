# Episteme for Obsidian

A thin desktop plugin: recall related understanding, propose a selected passage with its note source, and review
pending candidates. It calls the service, which alone owns the graph. It ships no model or Node dependencies.

## Install

Copy only `main.js`, `manifest.json` and `styles.css` to `<vault>/.obsidian/plugins/episteme/`, then enable
**Episteme** in Community plugins. The source stays in this repository. Reload an installed version with:

```powershell
obsidian vault=Notes plugin:reload id=episteme
```

Start the server using `pnpm serve --scene capture --blank` from the repository. The combined profile accepts
dev, Learn and discussion in the same graph. Single-scene servers work when the plugin's scene matches them.

Settings: service URL, optional agent credential, optional human credential, scene, and context scope. Local
mode permits anonymous read/propose; shared mode needs a separate agent token. A human token is needed to enable
confirm/reject. Credentials are masked in settings but stored as plaintext in local `data.json`; keep the human
field empty if review should happen in your own terminal. Local human tokens change when the service restarts.

Scope defaults to `scene:<scene>`; context `project:episteme` is prefixed accordingly. Recall scope is a ranking
preference and may include related items elsewhere. The plugin preserves the service's identity permissions.

## Use

1. Select a short passage and run **Episteme: Propose selection or note**. If there is no selection, the current
   note is used, subject to a 1000-character limit. Longer material needs CLI host distillation with quotes;
   the plugin does not silently truncate proposals.
2. The sidebar shows its pending candidate, rationale, source excerpt and scope. The graph remains unchanged.
3. Use **确认** or **驳回**, or review in a terminal with `ep pending` and `ep accept|reject`. Buttons are disabled
   without a human credential and guarded while a request is in flight.
4. Select a question and run **Episteme: Recall from selection or note**. The sidebar shows state and why each
   item matched. An unavailable service or invalid response produces a visible error.

Raw selected words become a proposal marked as inferred, not a declaration that the person has mastered them.
Source titles use `obsidian://open?vault=...&file=...`, so a graph origin retains the vault and note path without
hardcoding the vault's disk directory.

## Real-desktop verification

The optional smoke test runs against a **running Obsidian desktop** with this plugin installed. It creates a
short uniquely named note in `00-Inbox` and a temporary graph, temporarily changes plugin settings only in
memory, executes commands and clicks real sidebar buttons, and restores settings / prior note afterwards.
It never captures existing wiki material.

```powershell
pnpm build
node scripts/test-obsidian-epi.mjs --obsidian 'D:\obsidian\Obsidian.com' --vault Notes
```

It checks proposal with source, disabled review without human credentials, accept and recall, Learn rejection,
and unavailable-service feedback. The test is optional because CI has no Obsidian desktop. The plugin uses
Obsidian's existing `ItemView.setState` lifecycle; its own render state is kept by `show` to preserve workspace
restore behavior.
