# pi-auto-model

A Pi extension that classifies the first prompt in a new session and routes it to one of two or three configured models before the main agent request starts.

## Features

- Two tiers (`simple`, `complex`) or three (`simple`, `standard`, `complex`)
- A searchable, scrolling model picker for every tier
- A model and thinking level for every tier
- A separately configurable classifier model and thinking level
- The classifier may use any authenticated model, including fast or free models outside the routing scope
- Automatic deterministic routing with no sensitivity tuning required
- Interactive recovery when classification or model activation fails
- Global configuration only
- No rerouting of later prompts or resumed sessions

## Install

```bash
pi install npm:@janvitos/pi-auto-model
```

For local development:

```bash
pi -e /path/to/pi-auto-model
```

## Configure

Run:

```text
/automodel
```

On first startup or reload without a configuration, the extension directs the user to `/automodel setup`. Initial setup requires selecting every model and thinking level; the extension assumes no provider or model defaults. The tier picker respects Pi's current `enabledModels` or `--models` scope when one is active.

Commands:

```text
/automodel             Open the menu
/automodel setup       Reconfigure tiers and classifier
/automodel tiers       Reconfigure only the tiers
/automodel classifier  Reconfigure only the classifier
/automodel status      Show the active configuration
/automodel on          Enable routing
/automodel off         Disable routing
```

Configuration is stored at:

```text
~/.pi/agent/auto-model.json
```

## How routing works

On the first agent-bound prompt of an empty session, the extension asks the configured classifier model to return one tier label. It evaluates implied scope, investigation, data, ambiguity, constraints, consequences, and synthesis using a deterministic rubric. Pi then switches to that tier's model and thinking level before processing the task. In two-tier mode, exact `standard` output is normalized to `simple`, matching the routing policy for standard-level work when no Standard tier exists. The classifier call has a short timeout and a bounded output allowance that leaves room for reasoning tokens.

If classification fails, the selected tier model cannot be activated, or authentication fails, interactive modes ask whether to stop, use an available adjacent tier, choose a configured tier manually, or continue with the Pi model that was active before routing. No fallback preference is saved. Modes without interactive UI stop automatically.

Because Pi cannot cancel from the fully expanded `before_agent_start` event, Stop is implemented as a safe soft stop: the original task and images are removed from the outgoing task-model context, tools are temporarily disabled, and the active model receives only a minimal request to acknowledge that execution stopped. This makes one small acknowledgement model call; it does not execute the original task. The classifier has already received the expanded first prompt at that point.

Routing happens once per session. Existing, resumed, and already-routed sessions are left unchanged.

## Limitations

Pi does not currently expose an API for extensions to contribute entries to the built-in `/settings` menu, so this package provides its own native-style `/automodel` menu.

## License

MIT
