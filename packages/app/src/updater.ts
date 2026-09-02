import { app, dialog, Notification, type MenuItemConstructorOptions } from "electron";
import electronUpdater, { type ProgressInfo, type UpdateInfo } from "electron-updater";
import { logLocal } from "@workspace-agent/daemon";

// electron-updater is CommonJS and exposes `autoUpdater` through a getter that
// Node's ESM loader cannot see as a named export, so it has to come off the default.
const { autoUpdater } = electronUpdater;

/**
 * Self-update from GitHub Releases. electron-builder writes `latest-mac.yml`
 * next to the zip; electron-updater reads it from the newest release, downloads
 * the zip in the background, and Squirrel.Mac swaps the bundle on relaunch.
 * Only signed builds can do this, which is why it arrived after 0.1.2.
 */

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "failed"; message: string };

// A menu-bar app can stay up for weeks, so "on launch" alone is not enough.
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let status: UpdateStatus = { kind: "idle" };
let onChange: () => void = () => {};
/** Set while a check came from the menu, where silence would read as broken. */
let manual = false;
let notified: string | null = null;

function setStatus(next: UpdateStatus): void {
  status = next;
  onChange();
}

function check(): void {
  // A downloaded update installs on relaunch, and the check then runs again.
  if (status.kind !== "idle" && status.kind !== "failed") return;
  autoUpdater.checkForUpdates().catch(() => {
    // Also reported through the "error" event; nothing more to do here.
  });
}

/** Listener runs on every status change so the tray can redraw. No-op in dev builds. */
export function startUpdateChecks(listener: () => void): void {
  onChange = listener;
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // The default logger is chatty; only trouble belongs in the owner's activity log.
  autoUpdater.logger = {
    debug: () => {},
    info: () => {},
    warn: (message) => logLocal({ kind: "updater", level: "warn", message: String(message) }),
    error: (message) => logLocal({ kind: "updater", level: "error", message: String(message) }),
  };

  autoUpdater.on("checking-for-update", () => setStatus({ kind: "checking" }));
  autoUpdater.on("update-not-available", () => {
    setStatus({ kind: "idle" });
    if (!manual) return;
    manual = false;
    void dialog.showMessageBox({
      type: "info",
      message: "Workspace Agent is up to date",
      detail: `Version ${app.getVersion()} is the latest.`,
    });
  });
  autoUpdater.on("update-available", (info: UpdateInfo) => {
    manual = false;
    logLocal({ kind: "updater", event: "available", version: info.version });
    setStatus({ kind: "downloading", version: info.version, percent: 0 });
  });
  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    if (status.kind !== "downloading") return;
    const percent = Math.floor(progress.percent);
    if (percent !== status.percent) setStatus({ ...status, percent });
  });
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    logLocal({ kind: "updater", event: "downloaded", version: info.version });
    setStatus({ kind: "ready", version: info.version });
    if (notified === info.version || !Notification.isSupported()) return;
    notified = info.version;
    new Notification({
      title: `Workspace Agent ${info.version} is ready`,
      body: "Choose “Restart to Update” from the menu bar icon whenever convenient.",
    }).show();
  });
  autoUpdater.on("error", (err: Error) => {
    setStatus({ kind: "failed", message: err.message });
    if (!manual) return;
    manual = false;
    void dialog.showMessageBox({
      type: "warning",
      message: "Couldn't check for updates",
      detail: err.message,
    });
  });

  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
}

/** Tray entries for the current status. `onInstall` should stop the daemon, then call installUpdate. */
export function updateMenuItems(onInstall: () => void): MenuItemConstructorOptions[] {
  const version: MenuItemConstructorOptions = {
    label: `Version ${app.getVersion()}${app.isPackaged ? "" : " (dev)"}`,
    enabled: false,
  };
  if (!app.isPackaged) return [version];
  switch (status.kind) {
    case "checking":
      return [version, { label: "Checking for Updates…", enabled: false }];
    case "downloading":
      return [version, { label: `Downloading ${status.version}… ${status.percent}%`, enabled: false }];
    case "ready":
      return [version, { label: `Restart to Update to ${status.version}`, click: onInstall }];
    default:
      return [
        version,
        {
          label: "Check for Updates…",
          click: () => {
            manual = true;
            check();
          },
        },
      ];
  }
}

export function installUpdate(): void {
  if (status.kind !== "ready") return;
  logLocal({ kind: "updater", event: "install", version: status.version });
  autoUpdater.quitAndInstall();
}
