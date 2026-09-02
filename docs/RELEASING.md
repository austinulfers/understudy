# Releasing

Pushing to `main` builds, signs, notarizes, and publishes the macOS app.
[`.github/workflows/release.yml`](../.github/workflows/release.yml) does the work.

- The build runs on **every** push to `main`, so breakage surfaces immediately.
- The **release** is published only when the tag `v<version>` does not already
  exist, where `<version>` is read from `packages/app/package.json`. To cut a
  release, bump that version. Pushes that don't bump it still build, verify, and
  keep the DMG as a 14-day workflow artifact.
- Installed copies **update themselves** from that release: the app checks a
  few times a day, downloads in the background, and offers **Restart to
  Update** in its menu. See [Self-update](#self-update) for what that relies on.

## One-time signing setup

The workflow fails fast if any of the five secrets below are missing. Signing is
not optional — an unsigned build will not launch on anyone else's Mac.

Everything here needs a paid Apple Developer Program membership.

### 1. Developer ID Application certificate

This is the certificate that signs the app. It is *not* "Apple Development",
"Apple Distribution", or "Developer ID **Installer**" (that one is for `.pkg`).

The current certificate lives in `~/Documents/offhourslab/workspace-agent-signing/`
and expires **2031-08-22**. What follows is how it was made — for renewal, or if
someone else has to take this over.

**Generate a key and CSR locally.** The private key never leaves your Mac.

```sh
mkdir -p ~/Documents/offhourslab/workspace-agent-signing
cd ~/Documents/offhourslab/workspace-agent-signing
openssl req -new -newkey rsa:2048 -nodes \
  -keyout devid.key -out devid.csr \
  -subj "/emailAddress=you@example.com/CN=Your Name/C=US"
chmod 600 devid.key
```

**Create the certificate** at
<https://developer.apple.com/account/resources/certificates/add> → **Developer ID
Application** → upload `devid.csr` → download `developerID_application.cer`.

> When asked which intermediate to use, choose **G2 Sub-CA**. This matters more
> than it looks. A leaf certificate cannot outlive its issuer, and the legacy
> "Developer ID Certification Authority" expires 2027-02-01 — so a cert issued
> from it is truncated to whatever is left of that, regardless of the 5 years you
> are entitled to. The G2 intermediate runs to 2031-09-17. If your new cert has a
> suspiciously short life, this is why; make another one and pick G2. You get 5
> Developer ID certs per account.

**Build the `.p12`,** bundling the intermediate:

```sh
openssl x509 -inform DER -in developerID_application.cer -out devid-leaf.pem
curl -sfO https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
curl -sfo AppleRoot.cer https://www.apple.com/appleca/AppleIncRootCertificate.cer
openssl x509 -inform DER -in DeveloperIDG2CA.cer -out intermediate.pem
openssl x509 -inform DER -in AppleRoot.cer       -out root.pem
cat intermediate.pem root.pem > chain.pem

# Sanity check: does this cert actually match the key you generated?
openssl x509 -in devid-leaf.pem -noout -modulus | openssl md5
openssl rsa  -in devid.key      -noout -modulus | openssl md5   # must be identical

openssl pkcs12 -export -inkey devid.key -in devid-leaf.pem -certfile chain.pem \
  -name "Developer ID Application: Your Name (TEAMID)" -out certificate.p12
```

**The `.p12` must carry the whole chain — leaf *and* intermediate *and* Apple
Root CA.** `codesign` builds the trust chain using only the keychain it was
handed, and electron-builder hands it a throwaway keychain holding just what the
`.p12` contained. Its bundled root keychain carries the WWDR CA, not Apple Root
CA, so a `.p12` stopping at the intermediate fails partway through signing with:

```
Warning: unable to build chain to self-signed root for signer "Developer ID Application: …"
… locale.pak: errSecInternalComponent
```

which `find-identity` reports as `CSSMERR_TP_NOT_TRUSTED` while still counting
the identity as "1 valid identities found". The identity is fine; the anchor is
missing. Bundling `root.pem` fixes it.

Verify it the way electron-builder will, before trusting it to CI:

```sh
KC=~/Library/Keychains/p12-test.keychain-db
security create-keychain -p testpw "$KC" && security unlock-keychain -p testpw "$KC"
security list-keychains -d user -s $(security list-keychains -d user | tr -d ' "') "$KC"
security import certificate.p12 -k "$KC" -P "<p12 password>" -T /usr/bin/codesign -f pkcs12
security find-identity -v -p codesigning "$KC"      # expect: 1 valid identities found
security delete-keychain "$KC"
```

The `list-keychains` line matters — trust evaluation only consults keychains in
the search list, so without it a perfectly good `.p12` reports
`0 valid identities found`.

### 2. App Store Connect API key

This is what authenticates the notarization upload. An API key is used rather
than an Apple ID + app-specific password because it isn't tied to a person, has
no 2FA interaction, and can be revoked on its own.

1. Go to <https://appstoreconnect.apple.com/access/integrations/api>.
2. Create a key with the **Developer** role (Account Holder can also mint keys
   with broader access; Developer is sufficient to notarize).
3. Download the `AuthKey_XXXXXXXXXX.p8`. **Apple lets you download it once.**
4. Note the **Key ID** (the `XXXXXXXXXX` part) and the **Issuer ID** (a UUID shown
   at the top of that page).

### 3. Set the repository secrets

```sh
gh secret set APPLE_CERTIFICATE_P12_BASE64 < <(base64 -i certificate.p12)
gh secret set APPLE_CERTIFICATE_PASSWORD          # paste the .p12 export password
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID                    # e.g. ABCD123456
gh secret set APPLE_API_ISSUER                    # the issuer UUID
```

Verify with `gh secret list`. Then delete the local `.p12` and `.p8`, or move
them somewhere you actually keep secrets — they are not in this repo and must
never be.

| Secret | Maps to | What it is |
| --- | --- | --- |
| `APPLE_CERTIFICATE_P12_BASE64` | `CSC_LINK` | base64 of the Developer ID `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_API_KEY_P8` | written to a file, path in `APPLE_API_KEY` | contents of `AuthKey_*.p8` |
| `APPLE_API_KEY_ID` | `APPLE_API_KEY_ID` | the key's 10-char ID |
| `APPLE_API_ISSUER` | `APPLE_API_ISSUER` | issuer UUID from App Store Connect |

electron-builder imports the certificate into a throwaway keychain on the runner;
there is no manual `security create-keychain` step.

## Two notarization passes

electron-builder signs the `.app`, notarizes it, staples the ticket, and *then*
builds the DMG around it — but it leaves the DMG itself unsigned. The DMG is what
people actually download, and Gatekeeper assesses it on mount, so the workflow
signs, notarizes, and staples the DMG as a separate step afterwards, then
refreshes `latest-mac.yml`, whose DMG hash that step just invalidated.

That means **two** round trips to Apple's notary service per release.

Notarization time is dominated by Apple's queue, not by this app, and it varies
enormously: the very first submission from a brand-new account took ~85 minutes,
while a full CI run doing *both* passes finished in **6 minutes**. Assume minutes,
but don't be alarmed by an occasional long one. `timeout-minutes` is set to 350
so a bad day at Apple doesn't kill the job.

electron-builder deletes the throwaway keychain it creates, so the DMG step
builds its own from the same `.p12`. Two things in that step are load-bearing and
non-obvious:

- The new keychain must be added to the **search list** (`security list-keychains
  -d user -s …`). Trust evaluation only consults keychains on that list; without
  it `codesign` fails with `errSecInternalComponent` and `find-identity` reports
  `CSSMERR_TP_NOT_TRUSTED`.
- `security set-key-partition-list` must run after the import, or `codesign`
  blocks waiting on a keychain-access prompt that nobody is there to answer.

## Self-update

Installed copies keep themselves current, so nobody returns to GitHub after the
first install. [`packages/app/src/updater.ts`](../packages/app/src/updater.ts)
drives it through electron-updater's GitHub provider:

1. Thirty seconds after launch, and every four hours after that, the app asks
   GitHub for the newest release's tag and fetches that release's
   `latest-mac.yml`.
2. If the manifest names a newer version, it downloads the `.zip` in the
   background; the tray menu shows the progress.
3. Once downloaded, the tray offers **Restart to Update to <version>** and a
   notification says so. Nothing installs on its own — a menu-bar app can run
   for weeks, so "on next quit" would mean never.

What this relies on, all of it easy to break by accident:

- **Signed by the same Developer ID.** Squirrel.Mac validates the downloaded
  app's signature against the running one before swapping bundles. Unsigned
  builds cannot update, which is why this arrived after 0.1.2.
- **A `zip` target.** Squirrel.Mac installs from a zip of the `.app`; it cannot
  use a DMG. `build.mac.target` lists both. The DMG is for humans.
- **`latest-mac.yml` on the release.** electron-builder writes it because the
  build config has a `publish` block. That block only names the repo the updater
  reads from — uploading is this workflow's own `gh release create`, so every
  electron-builder invocation passes `--publish never`.
- **Artifact names without spaces.** GitHub rewrites spaces to dots in uploaded
  asset names, and the updater requests whatever the manifest says, so
  `Workspace Agent-…` would 404. `build.artifactName` fixes the names.
- **A manifest that matches the files.** electron-builder hashes each artifact
  as it is built; signing, notarizing, and stapling the DMG afterwards changes
  its bytes. [`update-manifest.mjs`](../packages/app/scripts/update-manifest.mjs)
  recomputes every entry after the DMG step, and the verify step runs it again
  with `--check`.

The repo is public, so the updater needs no token. If it ever goes private,
updates stop until the manifest and zip are served from somewhere else (the
broker would do).

Copies installed before 0.1.5 predate the updater and need one last manual
install. A copy running from outside Applications — typically straight off the
disk image — is offered a move there at launch, since the swap cannot happen on
a read-only volume.

There is no way to exercise this short of two consecutive signed releases: cut
one, install it, cut the next, and watch the first pull it in.

## What the workflow verifies

After both notarization passes, before publishing, it checks the things that
would otherwise only fail on someone else's Mac:

For the app:

- `codesign --verify --deep --strict` — every nested binary is properly sealed.
- Hardened runtime is actually enabled (`flags=…runtime`).
- `xcrun stapler validate` — the ticket is stapled, so it launches on a machine
  that has never seen it, even offline.
- `spctl --assess --type execute` — the exact question Gatekeeper asks at launch.

For the DMG:

- `codesign --verify --strict`
- `xcrun stapler validate`
- `spctl --assess --type open --context context:primary-signature` — what
  Gatekeeper asks when someone opens the downloaded disk image.

For the update zip:

- The `.app` inside passes the same `codesign`, `stapler`, and `spctl` checks —
  Squirrel.Mac judges what comes out of the zip, not the zip itself.
- `latest-mac.yml` agrees with the files being published
  (`update-manifest.mjs --check`). electron-updater refuses a download whose
  sha512 differs from the manifest, so a stale entry would strand every
  installed copy on the old version.

Any of these failing fails the job, so a broken build can't reach a release.

## Entitlements

[`packages/app/build/entitlements.mac.plist`](../packages/app/build/entitlements.mac.plist)
is applied to both the app and every nested binary. Hardened runtime is required
for notarization and blocks several things Electron needs; each entitlement in
that file buys one of them back. The bundled `claude` binary is a
Bun/JavaScriptCore executable that JITs, so it needs the same JIT entitlements
the Electron process does.

## Building locally

```sh
pnpm --filter workspace-agent-app dist:unsigned
```

Skips signing and notarization. The result runs on your own machine but will be
Gatekeeper-blocked anywhere else — use CI for anything you hand to someone. It
also writes the zip and `latest-mac.yml`; those only mean something on a release.

## Notes

- **Apple Silicon only.** `build.mac.target` builds `dmg` and `zip` for `arm64`.
  Intel Macs are not covered; add `x64` to both arch arrays (and expect a much
  slower build) if needed — the updater picks the zip for its own architecture.
- **Notarization is slow.** Apple's notary service has to ingest the whole app,
  and this one is large — the bundled `claude` binary alone is ~317 MB. Expect
  the signing and notarization steps to dominate the run.
- **The certificate expires 2031-08-22.** Renewal is section 1 again; the App
  Store Connect key can also be revoked independently. Either failing shows up in
  the signing or notarization step, not the preflight — the preflight only checks
  that the secrets are non-empty, not that they still work.
