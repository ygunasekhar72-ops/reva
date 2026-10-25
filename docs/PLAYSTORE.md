# REVA on Google Play — production checklist

The `android/` directory is a complete, zero-dependency Android project that
runs **the entire REVA harness on the phone itself** via an embedded Node.js
runtime (nodejs-mobile v18.20.4, fetched at build time). The WebView talks to
`127.0.0.1:7463` — no external server required. Connecting to a remote REVA
server (PC on LAN / public host) remains available as a fallback mode.
The GitHub Actions workflow (`.github/workflows/android-build.yml`) builds it
in the cloud — you do not need Android Studio or the SDK on your machine.

## 1. Get an installable APK (5 minutes, no setup)

1. Go to the repo → **Actions** → **android-build** → **Run workflow**.
2. When it finishes, download the `reva-android` artifact.
3. `app-debug.apk` installs directly on any Android 8+ phone
   (Settings → allow install from this source, first time only).
4. The app starts REVA **on the device** — everything works offline:
   chat with visible thinking, tools on the app workspace, skills, memory,
   bots. Add a provider key in the app (System → providers & keys) and the
   agent runs fully from your pocket. "Connect to remote" on the setup
   screen points it at a REVA server on your PC instead, if you prefer.

## 2. Production signing (one-time)

```bash
keytool -genkeypair -v -keystore reva-release.jks \
  -alias reva -keyalg RSA -keysize 2048 -validity 10000
```

**Keep this file and its passwords safe — losing them means losing the ability
to update the app on Play.** Never commit the keystore.

Add four repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of the .jks (`base64 -w0 reva-release.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | `reva` |
| `ANDROID_KEY_PASSWORD` | key password |

Re-run the workflow — `app-release.aab` is now signed and Play-ready.

## 3. Play Console checklist

1. **Create the app**: Play Console → Create app → name "REVA", type
   "Application", free or paid, then complete the store listing.
2. **Store listing assets**:
   - App icon: 512×512 PNG (export the brand mark: black square, white square)
   - Feature graphic: 1024×500
   - Phone screenshots: 2–8 (connect screen + chat with visible thinking)
   - Full description — draft: *REVA runs an AI agent on your own machine and
     puts it in your pocket: visible thinking, tool calls, project memory,
     bots and automation. Requires a REVA server that you control.*
3. **App content forms**:
   - *Privacy policy*: required URL. Host a page stating REVA collects no
     data — the app talks only to the server address the user entered, and
     all credentials go to that server.
   - *Data safety*: **No data collected, no data shared** (it is a client for
     a self-hosted service).
   - *App access*: since it's bring-your-own-server, provide working test
     credentials + server address in the "App access" form (e.g. a demo REVA
     instance on a small VPS), or a demo video of the login + chat flow.
   - *Ads*: none. *Content rating*: complete the questionnaire (everyone).
4. **Cleartext HTTP disclosure**: the app permits HTTP so it can reach
   `http://192.168.x.x` servers on the LAN and Termux `127.0.0.1`. Mention
   this in the listing ("connects to servers on your local network") and
   recommend HTTPS for public servers. If Play review pushes back, the
   alternative is scoping `networkSecurityConfig` to private ranges only —
   the manifest change is one file.
5. **Release**: start with **Internal testing**, then closed, then production.
   Upload `app-release.aab`. Play signs it with the Play-managed key
   (Play App Signing) — opt in when prompted, keep your upload key.

## 4. Versioning

Bump `versionCode` / `versionName` in `android/app/build.gradle` for every
release, tag (`git tag v1.0.1 && git push --tags`) — CI builds it.

## 5. Building locally (optional)

With Android Studio (or SDK + Gradle 8.7): open `android/`, then
`gradle assembleDebug` — same output as CI.
