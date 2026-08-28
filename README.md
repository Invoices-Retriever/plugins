# Invoices Retriever — plugins

Community plugins for [Invoices Retriever](https://github.com/Invoices-Retriever/mac-os-app),
the open-source, local-first invoice collector for macOS.

**A plugin is one JSON file.** No compiler, no build step, no Swift. It describes
how to check whether you are signed in to a supplier's portal, how to sign in,
and where the invoices are. The application interprets it; the plugin never
runs code of its own unless it explicitly asks to, and that case is flagged and
reviewed by a human.

```
plugins/          Plugins verified against a real account. These are published.
drafts/           Plugins that are structurally valid but have not been run
                  against a live account yet. Not published; help us test them.
schema/           The JSON Schema. Point your editor at it for autocompletion.
tests/            Anonymised HTML captures, so CI can check selectors without an account.
```

## Using a plugin before it is merged

In the app, open **Plugin developer** and add the folder you cloned this
repository into. Your local copy takes precedence over anything shipped, so you
can fix `ovh.json` and test the fix immediately.

## Writing one

Read [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

```bash
cp docs/template.json plugins/my-supplier.json
$EDITOR plugins/my-supplier.json          # your editor will autocomplete from schema/
irctl validate plugins/my-supplier.json   # the same checks CI runs
irctl run plugins/my-supplier.json --step # walk through it against the real portal
```

`irctl` ships inside the application bundle:

```bash
export PATH="/Applications/Invoices Retriever.app/Contents/MacOS:$PATH"
```

## Coverage

The point of this repository is coverage of **French and European suppliers**,
which the German-speaking commercial alternatives serve poorly. If your supplier
is missing, you are the person best placed to add it — you have the account.

## The three rules

Automating the retrieval of *your own* invoices with *your own* credentials is
legitimate. It also runs against the terms of service of many portals. Three
rules are non-negotiable, and pull requests that break them are closed:

1. **Never circumvent a technical protection.** No captcha solving, no
   fingerprint spoofing, no defeating bot detection. If a portal blocks the
   plugin, the plugin fails and asks the user to do it by hand.
2. **Keep to a human request rate.** The engine enforces this; do not fight it
   with parallel tricks.
3. **Collect nothing beyond the user's own documents.**

## Licence

Plugins are [MIT](LICENSE). The schema is Apache-2.0. The application itself is
AGPL-3.0-or-later.
