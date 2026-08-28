# Published plugins

These are the plugins the signed index carries, and what the application offers
in its catalogue.

Each one declares a `status`:

| | |
| --- | --- |
| `unverified` | Structurally valid, never run against a live account. Every plugin starts here. It is offered and badged, so a user choosing it knows they are the one finding out. |
| `active` | Someone has run it against a real account and it worked. |
| `degraded` | Failing for several people. Still installable, still badged. |
| `archived` | Unmaintained and broken for 90 days. No longer offered. |

Promoting `unverified` to `active` is the single most useful contribution to
this project: it takes an account you already have and about ten minutes. See
the notes next to each plugin.

[`../drafts/`](../drafts/) holds plugins nobody has adopted yet — not even far
enough along to publish.
