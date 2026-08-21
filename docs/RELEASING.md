# Releasing

Pushing to `main` builds, signs, notarizes, and publishes the macOS app.
[`.github/workflows/release.yml`](../.github/workflows/release.yml) does the work.

- The build runs on **every** push to `main`, so breakage surfaces immediately.
- The **release** is published only when the tag `v<version>` does not already
  exist, where `<version>` is read from `packages/app/package.json`. To cut a
  release, bump that version. Pushes that don't bump it still build, verify, and
  keep the DMG as a 14-day workflow artifact.

## One-time signing setup

The workflow fails fast if any of the five secrets below are missing. Signing is
not optional — an unsigned build will not launch on anyone else's Mac.

Everything here needs a paid Apple Developer Program membership.

### 1. Developer ID Application certificate

This is the certificate that signs the app. It is *not* the "Apple Development"
or "Apple Distribution" certificate, and it is not the Mac App Store one.

On your Mac:

1. **Keychain Access → Certificate Assistant → Request a Certificate From a
   Certificate Authority.** Enter your email, leave CA Email blank, pick *Saved
   to disk*. This produces a `CertificateSigningRequest.certSigningRequest`.
2. Go to <https://developer.apple.com/account/resources/certificates/add>, choose
   **Developer ID Application**, upload the CSR, and download the resulting
   `developerID_application.cer`.
3. Double-click the `.cer` to import it into your login keychain.
4. In Keychain Access, find **Developer ID Application: <your name> (TEAMID)**,
   expand it so both the certificate *and* its private key are selected, right-click
   → **Export 2 items…**, and save as `certificate.p12`. Set a strong export
   password — that password becomes `APPLE_CERTIFICATE_PASSWORD`.

Then base64 it for GitHub:

```sh
base64 -i certificate.p12 | pbcopy   # now on your clipboard
```

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

## What the workflow verifies

After the build, before publishing, it checks the things that would otherwise
only fail on a user's Mac:

- `codesign --verify --deep --strict` — every nested binary is properly sealed.
- Hardened runtime is actually enabled (`flags=…runtime`).
- `xcrun stapler validate` — the notarization ticket is stapled into the app, so
  it launches on a machine that has never seen it, even offline.
- `spctl --assess --type execute` — the exact question Gatekeeper asks at launch.

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
Gatekeeper-blocked anywhere else — use CI for anything you hand to someone.

## Notes

- **Apple Silicon only.** `build.mac.target` is `dmg`/`arm64`. Intel Macs are not
  covered; add `x64` to that array (and expect a much slower build) if needed.
- **Notarization is slow.** Apple's notary service has to ingest the whole app,
  and this one is large — the bundled `claude` binary alone is ~317 MB. Expect
  the signing and notarization steps to dominate the run.
- **Certificates expire** after 5 years, and the App Store Connect key can be
  revoked. Both surface as a failure in the preflight or signing step.
