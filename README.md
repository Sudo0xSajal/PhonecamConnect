<div align="center">

# 📱 → 💻 PhoneCam Connect

### Turn Your Android Into a Professional Webcam

**Zero cloud · Zero latency · 100% local WiFi**

[![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://github.com/Sudo0xSajal/phonecam/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey?style=flat-square)](https://github.com/Sudo0xSajal/phonecam/releases/latest)
[![Android](https://img.shields.io/badge/Android-8.0%2B-3DDC84?style=flat-square&logo=android)](https://github.com/Sudo0xSajal/phonecam/releases/latest/download/PhoneCam.apk)
[![Electron](https://img.shields.io/badge/Electron-29-47848F?style=flat-square&logo=electron)](https://electronjs.org)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

</div>

---

## ⬇️ Downloads

| What | File | Platform |
|---|---|---|
| **Desktop App** | [`PhoneCam.Connect.Setup.1.0.0.exe`](https://github.com/Sudo0xSajal/PhonecamConnect/releases/download/v1.0.0/PhoneCam.Connect.Setup.1.0.0.exe) | Windows 10/11 64-bit |
| **Virtual Camera Driver** | [`PhoneCam-Driver.zip`](https://github.com/Sudo0xSajal/PhonecamConnect/blob/main/driver/README.md) | Windows 10/11 64-bit |
| **Android App** | [`Phonecam-Connect.apk`](https://github.com/Sudo0xSajal/PhonecamConnect/releases/download/v1.0.0/Phonecam-Connect.apk) | Android 8.0+ |

> All links always point to the **latest release** automatically.

---

## 🗂 Repository Structure

This is a **monorepo** — all three components live in one place.

```
phonecam/                               ← GitHub repo root (Sudo0xSajal/phonecam)
│
├── 📄 README.md                        ← You are here
├── 📄 LICENSE                          ← MIT
├── 📄 .gitignore                       ← Root gitignore (covers all sub-projects)
│
├── 🌐 website/                         ← Landing page (GitHub Pages)
│   └── index.html                      ← Self-contained single-file site
│
├── 🖥️  desktop/                         ← Electron desktop app (Windows)
│   ├── src/
│   │   ├── main.js                     ← Electron main process
│   │   ├── preload.js                  ← Context bridge / IPC
│   │   ├── vcam-pipe.js                ← Virtual camera piping logic
│   │   └── renderer/
│   │       └── index.html              ← App UI (renderer process)
│   ├── assets/
│   │   ├── icon.ico                    ← Windows app icon
│   │   ├── icon.icns                   ← macOS app icon
│   │   ├── icon.png                    ← Linux / generic icon
│   │   ├── tray-icon.png               ← System tray icon
│   │   └── tray-icon@2x.png            ← Retina tray icon
│   ├── package.json                    ← npm scripts + electron-builder config
│   ├── package-lock.json
│   └── .gitignore                      ← Ignores node_modules/, dist/
│
├── 📱 android/                         ← Android camera app (Kotlin)
│   ├── app/
│   │   ├── src/
│   │   │   ├── main/
│   │   │   │   ├── AndroidManifest.xml
│   │   │   │   ├── java/com/phonecam/
│   │   │   │   │   ├── MainActivity.kt         ← Main screen + QR scan entry
│   │   │   │   │   ├── QRScanActivity.kt       ← QR code scanner screen
│   │   │   │   │   ├── ScanOverlayView.kt      ← Custom scan overlay UI
│   │   │   │   │   ├── StreamingService.kt     ← Background camera streamer
│   │   │   │   │   └── ui/theme/
│   │   │   │   │       ├── Color.kt
│   │   │   │   │       ├── Theme.kt
│   │   │   │   │       └── Type.kt
│   │   │   │   └── res/
│   │   │   │       ├── drawable/               ← Icons, badges, HUD elements
│   │   │   │       ├── layout/                 ← activity_main.xml, activity_qr_scan.xml
│   │   │   │       ├── mipmap-hdpi/ … xxxhdpi/ ← App launcher icons (all densities)
│   │   │   │       ├── values/                 ← colors.xml, strings.xml, themes.xml
│   │   │   │       └── xml/                    ← backup_rules.xml, data_extraction_rules.xml
│   │   │   ├── androidTest/                    ← Instrumentation tests
│   │   │   └── test/                           ← Unit tests
│   │   ├── build.gradle.kts
│   │   └── proguard-rules.pro
│   ├── gradle/
│   │   ├── libs.versions.toml                  ← Dependency version catalog
│   │   └── wrapper/
│   │       ├── gradle-wrapper.jar
│   │       └── gradle-wrapper.properties
│   ├── build.gradle.kts
│   ├── settings.gradle.kts
│   ├── gradle.properties
│   ├── gradlew                                 ← Unix build script
│   ├── gradlew.bat                             ← Windows build script
│   └── .gitignore                              ← Ignores build/, *.apk, local.properties
│
└── 🔧 driver/                          ← Virtual camera driver (Windows)
    └── README.md                       ← Driver build / install notes
```

---

## 🏗️ How to Build Each Component

### 🖥️ Desktop App (Electron → `PhoneCam-Setup.exe`)

```bash
cd desktop
npm install
npm run build:win       # produces dist/PhoneCam-Setup.exe
```

Requires: Node.js 18+, Windows or WSL2.

---

### 📱 Android App (Kotlin → `PhoneCam.apk`)

```bash
cd android
./gradlew assembleRelease     # produces app/build/outputs/apk/release/app-release.apk
# then rename to PhoneCam.apk before uploading to release
```

Requires: Android Studio / JDK 17, Android SDK API 26+.

---

### 🔧 Driver (`PhoneCam-Driver.zip`)

Build the virtual camera driver separately, zip the installer, and attach as `PhoneCam-Driver.zip` to the GitHub Release. See [`driver/README.md`](driver/README.md) for details.

---

## 📋 What Goes Where — Quick Reference

| Component | Folder | Produces | Upload as |
|---|---|---|---|
| Landing page | `website/` | `index.html` | GitHub Pages |
| Windows app | `desktop/` | `PhoneCam-Setup.exe` | GitHub Release asset |
| Android app | `android/` | `PhoneCam.apk` | GitHub Release asset |
| Camera driver | `driver/` | `PhoneCam-Driver.zip` | GitHub Release asset |

---

## 📄 License

MIT © 2026 PhoneCam Connect — [Sudo0xSajal](https://github.com/Sudo0xSajal)
