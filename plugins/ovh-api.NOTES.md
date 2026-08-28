# Notes on the OVHcloud API module

This is the sibling of `ovh.json`. Both collect the same invoices; they differ
in how they get in, and the trade-off is worth stating plainly:

| | `ovh.json` | `ovh-api.json` |
| --- | --- | --- |
| Credentials | customer id, password, 2FA secret | three API keys |
| Setup | none | create the keys once |
| Browser | yes, and a sign-in to pass | never |
| Can run unattended | no — a session expires | yes |
| Breaks when | OVHcloud redesigns the sign-in | the keys are revoked |

Neither is the successor of the other. Someone who collects once a quarter will
prefer the portal; someone who schedules it wants the keys.

## Creating the keys

<https://api.ovh.com/createToken/>, with the rights this plugin actually uses
and nothing more:

```
GET /me
GET /me/bill
GET /me/bill/*
```

`GET /me` is only there so `checkAuth` has something to call. Grant no write
rights: a collector reads, and the validator refuses anything but GET and POST
in any case.

Set no expiry if you want collection to keep working; OVHcloud otherwise
revokes the consumer key on the date you choose, and the app will report
"refused these credentials" the morning after.

## How it authenticates

OVHcloud signs each request rather than using a bearer token:

```
X-Ovh-Signature = "$1$" + sha1_hex(
    applicationSecret + "+" + consumerKey + "+" + METHOD + "+" +
    full URL + "+" + body + "+" + timestamp)
```

That is written out in the plugin's `api.auth.signature` block as an ordered
list of parts, a separator and an algorithm — not as code. The implementation is
checked in the application's test suite against signatures computed
independently (python `hashlib`), so a bug in the engine cannot agree with a bug
in the test.

The timestamp is **OVHcloud's**, not this machine's: `/auth/time` is read once
per run and the local clock advances it afterwards. A user whose Mac is a minute
off would otherwise be rejected for no visible reason.

## Regions

`baseUrl` is the European endpoint. Canada is `https://ca.api.ovh.com/1.0` and
the United States `https://api.us.ovhcloud.com/1.0`; both are already in
`allowedDomains`. Making it a config option would be a small change to
`baseUrl`, and is worth doing the first time somebody outside Europe asks.

## Still to verify

Written from OVHcloud's published API and signature scheme, and the signature is
covered by tests, but the whole has not yet run against a real account:

```bash
irctl run plugins/ovh-api.json --step
```

Run it twice. The second run must download nothing — `document.id` is `billId`,
which OVHcloud does not recycle.
