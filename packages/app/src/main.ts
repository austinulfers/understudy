import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  daemonEvents,
  DEFAULT_PROMPT,
  deleteConfig,
  enrollWithBroker,
  LOG_DIR,
  loadConfig,
  logLocal,
  MODEL_CHOICES,
  modelLabel,
  normalizePrompt,
  normalizeRoot,
  queryNotice,
  runDaemon,
  saveConfig,
  unenrollFromBroker,
  type DaemonConfig,
  type DaemonControl,
  type DaemonState,
  type QueryEvent,
} from "@understudy/daemon";
import { installUpdate, startUpdateChecks, updateMenuItems } from "./updater";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML = path.join(__dirname, "..", "ui", "onboard.html");
const PANEL_HTML = path.join(__dirname, "..", "ui", "panel.html");
const HELP_HTML = path.join(__dirname, "..", "ui", "help.html");
const PRELOAD = path.join(__dirname, "preload.cjs");
const TRAY_ICON = path.join(__dirname, "..", "icons", "trayTemplate.png");
const CLAUDE_DOCS = "https://claude.com/claude-code";

let tray: Tray | null = null;
let onboarding: BrowserWindow | null = null;
let panel: BrowserWindow | null = null;
let help: BrowserWindow | null = null;
let config: DaemonConfig | null = null;
let control: DaemonControl | null = null;
let connState: DaemonState = "disconnected";
let pendingPrefill: { broker?: string; token?: string } = {};
const recent: QueryEvent[] = [];

// ---------- single instance + enrollment deep links ----------

/**
 * URL schemes that open the app with an enrollment link. The first is current;
 * the second is the one the app registered before it was renamed Understudy,
 * kept so links minted before the rename still open the app.
 */
const ENROLL_SCHEMES = ["understudy", "workspace-agent"];
const isEnrollLink = (candidate: string): boolean => ENROLL_SCHEMES.some((scheme) => candidate.startsWith(`${scheme}://`));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", (_event, argv) => {
  const link = argv.find(isEnrollLink);
  if (link) handleEnrollLink(link);
  else if (config) showHelp();
  else showOnboarding();
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleEnrollLink(url);
});

function handleEnrollLink(link: string): void {
  try {
    const url = new URL(link);
    if (!ENROLL_SCHEMES.includes(url.protocol.replace(/:$/, ""))) return;
    pendingPrefill = {
      broker: url.searchParams.get("broker") ?? undefined,
      token: url.searchParams.get("token") ?? undefined,
    };
  } catch {
    return;
  }
  if (app.isReady()) {
    showOnboarding();
    onboarding?.webContents.send("prefill", prefillPayload());
  }
}

// ---------- helpers ----------

function claudeSignedIn(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], { stdio: "ignore" });
    return true;
  } catch {
    // fall through to the file check
  }
  return fs.existsSync(path.join(os.homedir(), ".claude", ".credentials.json"));
}

/**
 * Folders the onboarding form starts out sharing: ~/.claude, when Claude Code
 * has run on this Mac. The owner can remove it before enrolling, and
 * .credentials* inside it is on the deny-list regardless. Only the onboarding
 * form reads this, so a copy that is already enrolled keeps exactly the roots
 * its owner chose.
 */
function defaultRoots(): string[] {
  try {
    return [normalizeRoot(path.join(os.homedir(), ".claude"))];
  } catch {
    return [];
  }
}

function prefillPayload() {
  return {
    broker: pendingPrefill.broker ?? "",
    token: pendingPrefill.token ?? "",
    defaultRoots: defaultRoots(),
    claudeSignedIn: claudeSignedIn(),
  };
}

function truncate(text: string, n: number): string {
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

// ---------- daemon lifecycle ----------

function startDaemon(): void {
  if (!config || control) return;
  control = runDaemon(config, {
    onRevoked: () => {
      control = null;
      connState = "revoked";
      rebuildMenu();
      void dialog.showMessageBox({
        type: "warning",
        message: "Understudy access was revoked",
        detail: "The admin revoked this Mac's access. The app will stay idle; ask the admin for a new enrollment link if this is unexpected.",
      });
    },
  });
}

daemonEvents.on("state", (state: DaemonState) => {
  connState = state;
  rebuildMenu();
});

daemonEvents.on("query", (event: QueryEvent) => {
  if (event.state === "start") {
    recent.unshift(event);
    recent.splice(8);
    notifyQuery(event);
  }
  rebuildMenu();
});

/**
 * Posted from the main process so macOS files it under Understudy and shows
 * the app icon; an osascript notification would appear as Script Editor's.
 * Clicking it opens the owner panel.
 */
function notifyQuery(event: QueryEvent): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: queryNotice(event), body: truncate(event.question, 120) });
  notification.on("click", () => showPanel());
  notification.show();
}

// ---------- tray ----------

function statusLabel(): string {
  if (!config) return "Not set up";
  if (connState === "revoked") return "Access revoked";
  if (connState !== "connected") return `Offline — reconnecting…`;
  return config.paused ? `Paused — “${config.hostName}”` : `Connected — “${config.hostName}”`;
}

function rebuildMenu(): void {
  if (!tray) return;
  const items: Electron.MenuItemConstructorOptions[] = [{ label: statusLabel(), enabled: false }, { type: "separator" }];

  if (!config) {
    items.push({ label: "Set Up…", click: () => showOnboarding() });
    items.push({ label: "Help", click: () => showHelp() });
  } else {
    items.push({ label: "Open Understudy…", click: () => showPanel() });
    items.push({ label: "Help", click: () => showHelp() });
    items.push({ type: "separator" });
    items.push({
      label: "Pause Answering",
      type: "checkbox",
      checked: config.paused,
      click: () => {
        if (!config) return;
        config.paused = !config.paused;
        saveConfig(config);
        control?.setPaused(config.paused);
        rebuildMenu();
      },
    });
    items.push({
      label: "Shared Folders",
      submenu: [
        ...config.roots.map<Electron.MenuItemConstructorOptions>((root) => ({
          label: root.replace(os.homedir(), "~"),
          submenu: [{ label: "Stop Sharing", click: () => removeRoot(root) }],
        })),
        { type: "separator" },
        { label: "Add Folder…", click: () => void addFolders() },
      ],
    });
    items.push({
      label: `Answer Model — ${modelLabel(config.model)}`,
      submenu: MODEL_CHOICES.map<Electron.MenuItemConstructorOptions>((choice) => ({
        label: `${choice.label} — ${choice.hint}`,
        type: "radio",
        checked: (choice.id ?? undefined) === config?.model,
        click: () => setModel(choice.id ?? undefined),
      })),
    });
    items.push({
      label: "Recent Questions",
      submenu: recent.length
        ? recent.map<Electron.MenuItemConstructorOptions>((event) => ({
            label: `${new Date(event.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${event.askerName}${event.viaHost ? ` via ${event.viaHost}'s agent` : ""}: ${truncate(event.question, 42)}`,
            enabled: false,
          }))
        : [{ label: "None yet", enabled: false }],
    });
    items.push({ label: "Open Activity Log", click: () => void shell.openPath(LOG_DIR) });
    items.push({ type: "separator" });
    items.push({
      label: "Start at Login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    });
    items.push({ label: "Unenroll This Mac…", click: () => void unenrollFlow() });
  }

  items.push({ type: "separator" }, ...updateMenuItems(restartToUpdate));
  items.push({ type: "separator" }, { label: "Quit Understudy", role: "quit" });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function restartToUpdate(): void {
  // Same shutdown as unenroll: close the broker socket before the process goes away.
  control?.stop();
  control = null;
  installUpdate();
}

async function addFolders(): Promise<void> {
  if (!config) return;
  const result = await dialog.showOpenDialog({
    title: "Share folders with your agent",
    message: "Coworkers' questions can only read inside the folders you share.",
    properties: ["openDirectory", "multiSelections"],
  });
  for (const dir of result.filePaths) {
    try {
      const normalized = normalizeRoot(dir);
      if (!config.roots.includes(normalized)) config.roots.push(normalized);
    } catch {
      // skip anything that isn't a real directory
    }
  }
  saveConfig(config);
  rebuildMenu();
}

function setModel(model: string | undefined): void {
  if (!config) return;
  if (model) config.model = model;
  else delete config.model;
  saveConfig(config);
  control?.setModel(model);
  rebuildMenu();
}

function removeRoot(root: string): void {
  if (!config) return;
  if (config.roots.length === 1) {
    void dialog.showMessageBox({
      type: "info",
      message: "At least one folder must stay shared",
      detail: "Add another folder first, or use Pause Answering / Unenroll instead.",
    });
    return;
  }
  config.roots = config.roots.filter((r) => r !== root);
  saveConfig(config);
  rebuildMenu();
}

async function unenrollFlow(): Promise<void> {
  if (!config) return;
  const choice = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Unenroll", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Unenroll “${config.hostName}”?`,
    detail: "Coworkers will no longer be able to ask this Mac anything. This deletes the local credentials; re-enrolling needs a fresh link from the admin.",
  });
  if (choice.response !== 0) return;
  control?.stop();
  control = null;
  await unenrollFromBroker(config);
  deleteConfig();
  config = null;
  connState = "disconnected";
  rebuildMenu();
  showOnboarding();
}

// ---------- onboarding window ----------

function showOnboarding(): void {
  // Already enrolled: there is no form to fill in, so show the connected page instead.
  if (config) {
    showHelp(true);
    return;
  }
  if (onboarding) {
    onboarding.show();
    onboarding.focus();
    return;
  }
  onboarding = new BrowserWindow({
    width: 520,
    height: 720,
    resizable: false,
    fullscreenable: false,
    title: "Understudy",
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  void onboarding.loadFile(UI_HTML);
  onboarding.on("closed", () => {
    onboarding = null;
  });
}

// ---------- help window ----------

/**
 * Worked examples and the full Slack command list, written around this Mac's
 * agent name. `welcome` is the version shown right after enrolling: it opens
 * on the "you're connected" note instead of the plain title.
 */
function showHelp(welcome = false): void {
  const query: Record<string, string> = welcome ? { welcome: "1" } : {};
  if (help) {
    // A window opened before enrolling would otherwise keep the placeholder name.
    if (welcome) void help.loadFile(HELP_HTML, { query });
    help.show();
    help.focus();
    return;
  }
  help = new BrowserWindow({
    width: 640,
    height: 780,
    minWidth: 480,
    minHeight: 480,
    title: "Understudy Help",
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  void help.loadFile(HELP_HTML, { query });
  help.on("closed", () => {
    help = null;
  });
}

// ---------- owner panel ----------

function showPanel(): void {
  if (panel) {
    panel.show();
    panel.focus();
    return;
  }
  panel = new BrowserWindow({
    width: 780,
    height: 620,
    minWidth: 640,
    minHeight: 480,
    title: "Understudy",
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  void panel.loadFile(PANEL_HTML);
  panel.on("closed", () => {
    panel = null;
  });
}

/** Calls the broker's device-authenticated owner API. Secrets stay in main. */
async function brokerFetch(pathname: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  if (!config) throw new Error("Not enrolled.");
  const res = await fetch(config.brokerUrl + pathname, {
    method: init?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-device-id": config.deviceId,
      "x-device-secret": config.deviceSecret,
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `The broker returned HTTP ${res.status}.`);
  return data;
}

function panelHandler(fn: () => Promise<unknown>) {
  return async () => {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };
}

ipcMain.handle("panel-overview", () => panelHandler(() => brokerFetch("/api/host/overview"))());
ipcMain.handle("panel-search-users", (_event, query: string) =>
  panelHandler(() => brokerFetch(`/api/host/users?q=${encodeURIComponent(String(query))}`))(),
);
ipcMain.handle("panel-acl", (_event, payload: { action: string; slackUserId: string }) =>
  panelHandler(() => brokerFetch("/api/host/acl", { method: "POST", body: payload }))(),
);
ipcMain.handle("panel-limit", (_event, dailyLimit: number | null) =>
  panelHandler(() => brokerFetch("/api/host/limit", { method: "POST", body: { dailyLimit } }))(),
);
ipcMain.handle("panel-peers", (_event, acceptPeerAsks: boolean) =>
  panelHandler(() => brokerFetch("/api/host/peers", { method: "POST", body: { acceptPeerAsks: acceptPeerAsks === true } }))(),
);
ipcMain.handle("panel-transcript", (_event, threadKey: string) =>
  panelHandler(() => brokerFetch(`/api/host/transcript?key=${encodeURIComponent(String(threadKey))}`))(),
);

/**
 * The agent's instructions are the one panel setting that never touches the
 * broker: like the model, they live in this Mac's config.
 */
ipcMain.handle("panel-prompt", () =>
  panelHandler(async () => ({ prompt: config?.prompt ?? "", defaultPrompt: DEFAULT_PROMPT }))(),
);
ipcMain.handle("panel-set-prompt", (_event, text: unknown) =>
  panelHandler(async () => {
    if (!config) throw new Error("Not enrolled.");
    const prompt = normalizePrompt(typeof text === "string" ? text : "");
    if (prompt) config.prompt = prompt;
    else delete config.prompt;
    saveConfig(config);
    control?.setPrompt(prompt);
    return { prompt: config.prompt ?? "" };
  })(),
);

// ---------- IPC ----------

ipcMain.handle("prefill", () => prefillPayload());

ipcMain.handle("pick-folders", async () => {
  const result = await dialog.showOpenDialog({
    title: "Share folders with your agent",
    properties: ["openDirectory", "multiSelections"],
  });
  return result.filePaths;
});

ipcMain.handle("enroll", async (_event, payload: { broker: string; token: string; roots: string[] }) => {
  try {
    const broker = payload.broker.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(broker)) return { ok: false, error: "The broker URL should start with http:// or https://." };
    if (!payload.token.trim()) return { ok: false, error: "Paste the enrollment link or token you were sent." };
    const roots = payload.roots.map(normalizeRoot);
    if (roots.length === 0) return { ok: false, error: "Share at least one folder." };

    const creds = await enrollWithBroker(broker, payload.token.trim());
    config = {
      brokerUrl: broker,
      deviceId: creds.deviceId,
      deviceSecret: creds.deviceSecret,
      hostName: creds.hostName,
      roots,
      paused: false,
    };
    saveConfig(config);
    startDaemon();
    app.setLoginItemSettings({ openAtLogin: true });
    rebuildMenu();
    return { ok: true, hostName: creds.hostName };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle("open-external", (_event, url: string) => {
  if (typeof url === "string" && url.startsWith("https://")) void shell.openExternal(url);
});

ipcMain.handle("close-window", (event) => BrowserWindow.fromWebContents(event.sender)?.close());

/** The form is done: hand the new owner the guide, opened on the welcome note. */
ipcMain.handle("finish-onboarding", () => {
  showHelp(true);
  onboarding?.close();
});

ipcMain.handle("help-context", () => ({ hostName: config?.hostName ?? "", enrolled: !!config }));

// ---------- app lifecycle ----------

for (const scheme of ENROLL_SCHEMES) app.setAsDefaultProtocolClient(scheme);

app.on("window-all-closed", () => {
  // Menu-bar app: keep running with no windows.
});

/**
 * Squirrel.Mac swaps the bundle where it sits, which cannot work from the
 * read-only disk image and is fragile anywhere but Applications. Asked on every
 * launch outside it; launches are rare for an app that lives in the menu bar.
 * Returns true when the app is relaunching itself from the new location.
 */
async function offerMoveToApplications(): Promise<boolean> {
  if (!app.isPackaged || app.isInApplicationsFolder()) return false;
  const choice = await dialog.showMessageBox({
    type: "question",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
    message: "Move Understudy to the Applications folder?",
    detail: "It is running from somewhere else. Automatic updates are only reliable from Applications; it will reopen from there.",
  });
  if (choice.response !== 0) return false;
  try {
    return app.moveToApplicationsFolder();
  } catch (err) {
    logLocal({ kind: "updater", level: "error", message: `move to Applications failed: ${(err as Error).message}` });
    return false;
  }
}

void app.whenReady().then(async () => {
  app.dock?.hide();
  if (await offerMoveToApplications()) return;

  const icon = nativeImage.createFromPath(TRAY_ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Understudy");

  config = loadConfig();
  rebuildMenu();
  startUpdateChecks(rebuildMenu);

  if (config) {
    startDaemon();
  } else {
    showOnboarding();
  }
});
