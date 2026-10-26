# whereti.releases

The update endpoint for [whereti](https://github.com/whereti/app), running
at `releases.whereti.com` as a Cloudflare Worker. Same design as
releases.silentsilo.com.

whereti asks it **at most once a day** whether a newer version exists. This
repository is public so that the answer to "what does that request tell you
about me" can be read rather than believed.

## What it does

```
GET /windows/{x86_64|aarch64}/{installed_version}
```

`204` when the caller is current, or when nothing is published. When a newer
version exists, a small JSON with the version, notes, and the caller's own
installer: its GitHub URL, SHA-256 and size.

That is the whole endpoint. It is deliberately dumb: before installing, whereti
checks that the installer has a valid Authenticode signature from Software Hive
S.R.L. and matches the SHA-256, so this service serving wrong data can break
updating and cannot install anything.

## What it records

One datapoint per request, in `src/index.ts`, and this is all of it:

- the platform, as `windows-x86_64` or `windows-aarch64`
- the version that asked
- the outcome: `no-release`, `up-to-date` or `update-offered`

No IP addresses, no identifiers, no cookies, nothing that tells one install
from another. The app sends no identifier either: the request is the URL above
and nothing else.

The check can be turned off in whereti's Settings, which removes that install
from the count entirely.

## The limit of publishing this

Reading the source tells you what this code does. It does not prove that this
code is what runs at `releases.whereti.com`, because Cloudflare offers no way
to attest that. Where it matters most, whereti does not rely on trusting this
service: the installer's signature and hash are checked on the PC.

## Publishing a release

1. In the whereti repository: `scripts\package.ps1 -Release` builds and signs
   the installer and writes `dist\latest.json`.
2. Publish the GitHub release with the installer (the URL in latest.json must work).
3. Update the website (`whereti.website/src/links.ts`).
4. Copy `latest.json` here and run `npm run publish:manifest`. From now on,
   installed copies are offered the update at their next daily check.

## Dev

```bash
npm install
npm test          # version ordering, and every answer the endpoint gives
npm run typecheck
npm run dev       # local worker, local KV
```

Before the first deploy: `npx wrangler kv namespace create RELEASES` and paste
the id into `wrangler.toml`.

## Licence

MIT, see [LICENSE](LICENSE).
