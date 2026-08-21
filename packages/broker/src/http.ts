import express from "express";
import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config";
import {
  addAcl,
  getHostById,
  getHostByName,
  getThread,
  getTranscript,
  listAclsDetailed,
  listRecentThreadsForHost,
  mintEnrollToken,
  redeemEnrollToken,
  removeAcl,
  revokeHost,
  setDailyLimit,
  usageToday,
  verifyDevice,
  type HostRow,
} from "./db";
import { hub } from "./hub";
import { renderConversations, renderHome, renderToken, renderTranscript } from "./dashboard";
import { lookupDisplayName, searchWorkspaceUsers } from "./slack";

/** Host names that collide with bot DM commands. */
const RESERVED_HOST_NAMES = new Set(["allow", "deny", "revoke", "team", "help", "hosts", "agents", "reset", "ask"]);

export function buildHttpApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  // Mac app installers, if the admin drops them here (see the token page).
  app.use("/downloads", express.static("downloads"));

  // --- daemon-facing API (authenticated by token / device secret) ---

  app.post("/api/enroll", (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const creds = token ? redeemEnrollToken(token) : null;
    if (!creds) {
      res.status(400).json({ error: "invalid, expired, or already-used enrollment token" });
      return;
    }
    console.log(`[enroll] host "${creds.hostName}" enrolled as ${creds.deviceId}`);
    res.json({ ...creds, wsPath: "/ws" });
  });

  app.post("/api/unenroll", (req, res) => {
    const { deviceId, deviceSecret } = req.body ?? {};
    const host =
      typeof deviceId === "string" && typeof deviceSecret === "string"
        ? verifyDevice(deviceId, deviceSecret)
        : null;
    if (!host) {
      res.status(401).json({ error: "unknown device" });
      return;
    }
    revokeHost(host.id);
    hub.disconnect(host.id);
    console.log(`[enroll] host "${host.name}" unenrolled itself`);
    res.json({ ok: true });
  });

  // --- host-owner API (device-authenticated; used by the Mac app) ---

  const deviceAuth = (req: Request, res: Response, next: NextFunction): void => {
    const host = verifyDevice(
      String(req.headers["x-device-id"] ?? ""),
      String(req.headers["x-device-secret"] ?? ""),
    );
    if (!host) {
      res.status(401).json({ error: "unknown device" });
      return;
    }
    res.locals.host = host;
    next();
  };

  app.get("/api/host/overview", deviceAuth, async (req, res) => {
    const host = res.locals.host as HostRow;
    const acl = await Promise.all(
      listAclsDetailed(host.id).map(async (row) => ({
        slackUserId: row.slack_user_id,
        name: await lookupDisplayName(row.slack_user_id),
        grantedBy: row.granted_by,
        grantedAt: row.granted_at,
        isOwner: row.slack_user_id === host.owner_slack_id,
      })),
    );
    const conversations = await Promise.all(
      listRecentThreadsForHost(host.id).map(async (thread) => ({
        threadKey: thread.thread_key,
        startedBy: thread.created_by,
        startedByName: await lookupDisplayName(thread.created_by),
        lastActive: thread.last_active,
        messages: thread.messages,
      })),
    );
    res.json({
      hostName: host.name,
      online: hub.isOnline(host.id),
      dailyLimit: host.daily_limit,
      defaultDailyLimit: config.defaultDailyLimit,
      usageToday: usageToday(host.id),
      acl,
      conversations,
    });
  });

  app.post("/api/host/acl", deviceAuth, (req, res) => {
    const host = res.locals.host as HostRow;
    const action = String(req.body?.action ?? "");
    const userId = String(req.body?.slackUserId ?? "").trim();
    if (!/^[UW][A-Z0-9]{4,}$/.test(userId) || !["add", "remove"].includes(action)) {
      res.status(400).json({ error: "expected { action: add|remove, slackUserId: U… }" });
      return;
    }
    if (action === "remove" && userId === host.owner_slack_id) {
      res.status(400).json({ error: "You always keep access to your own agent." });
      return;
    }
    if (action === "add") addAcl(host.id, userId, host.owner_slack_id);
    else removeAcl(host.id, userId);
    res.json({ ok: true });
  });

  app.post("/api/host/limit", deviceAuth, (req, res) => {
    const host = res.locals.host as HostRow;
    const raw = req.body?.dailyLimit;
    const limit = raw === null ? null : Number(raw);
    if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 10000)) {
      res.status(400).json({ error: "dailyLimit must be null (team default) or an integer 0–10000" });
      return;
    }
    setDailyLimit(host.id, limit);
    res.json({ ok: true });
  });

  app.get("/api/host/users", deviceAuth, async (req, res) => {
    const query = String(req.query.q ?? "");
    if (query.trim().length < 2) {
      res.json({ users: [] });
      return;
    }
    try {
      res.json({ users: await searchWorkspaceUsers(query) });
    } catch {
      res.status(502).json({ error: "Slack user lookup failed" });
    }
  });

  app.get("/api/host/transcript", deviceAuth, async (req, res) => {
    const host = res.locals.host as HostRow;
    const threadKey = String(req.query.key ?? "");
    if (getThread(threadKey)?.host_id !== host.id) {
      res.status(404).json({ error: "no such conversation on this host" });
      return;
    }
    const messages = await Promise.all(
      getTranscript(threadKey).map(async (row) => ({
        role: row.role,
        asker: row.asker_slack_id,
        askerName: await lookupDisplayName(row.asker_slack_id),
        content: row.content,
        at: row.created_at,
      })),
    );
    res.json({ threadKey, messages });
  });

  // --- admin dashboard (HTTP basic auth, user "admin") ---

  const adminAuth = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    const expected = "Basic " + Buffer.from(`admin:${config.adminToken}`).toString("base64");
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.set("WWW-Authenticate", 'Basic realm="workspace-agent"').status(401).send("Auth required");
      return;
    }
    next();
  };

  const admin = express.Router();
  admin.use(adminAuth);

  admin.get("/", (_req, res) => {
    res.send(renderHome());
  });

  admin.post("/tokens", (req, res) => {
    const hostName = String(req.body?.host_name ?? "").trim();
    const ownerSlackId = String(req.body?.owner_slack_id ?? "").trim();
    if (!/^[\w.-]{2,32}$/.test(hostName) || !/^[UW][A-Z0-9]{4,}$/.test(ownerSlackId)) {
      res.status(400).send("Host name must be 2-32 word chars; owner must be a Slack user ID (U…).");
      return;
    }
    if (RESERVED_HOST_NAMES.has(hostName.toLowerCase())) {
      res.status(400).send(`"${hostName}" collides with a bot command — pick another host name.`);
      return;
    }
    if (getHostByName(hostName)) {
      res
        .status(400)
        .send(`An active host is already named "${hostName}" — revoke it first, or pick another name.`);
      return;
    }
    const token = mintEnrollToken(hostName, ownerSlackId);
    const publicUrl = `${req.protocol}://${req.get("host")}`;
    res.send(renderToken(hostName, token, publicUrl));
  });

  admin.post("/hosts/:id/revoke", (req, res) => {
    const host = getHostById(String(req.params.id));
    if (host) {
      revokeHost(host.id);
      hub.disconnect(host.id);
      console.log(`[admin] revoked host "${host.name}"`);
    }
    res.redirect("/admin");
  });

  admin.post("/hosts/:id/acl", (req, res) => {
    const userId = String(req.body?.slack_user_id ?? "").trim();
    if (/^[UW][A-Z0-9]{4,}$/.test(userId)) addAcl(String(req.params.id), userId, "admin");
    res.redirect("/admin");
  });

  admin.post("/hosts/:id/acl/remove", (req, res) => {
    removeAcl(String(req.params.id), String(req.body?.slack_user_id ?? ""));
    res.redirect("/admin");
  });

  admin.get("/conversations", (_req, res) => {
    res.send(renderConversations());
  });

  admin.get("/conversations/view", (req, res) => {
    res.send(renderTranscript(String(req.query.key ?? "")));
  });

  app.use("/admin", admin);
  app.get("/", (_req, res) => res.redirect("/admin"));

  return app;
}
