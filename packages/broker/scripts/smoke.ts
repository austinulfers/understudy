/**
 * Offline smoke test: exercises enrollment, device auth, the WS hub,
 * path containment, and redaction — everything except Slack itself.
 * Run with: pnpm --filter @workspace-agent/broker smoke
 */
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";

process.env.SLACK_BOT_TOKEN ||= "xoxb-smoke";
process.env.SLACK_APP_TOKEN ||= "xapp-smoke";
process.env.ADMIN_TOKEN ||= "smoke";
process.env.DB_PATH = path.join(os.tmpdir(), `wa-smoke-${Date.now()}.db`);

const { checkPath, extractToolPaths, redactSecrets } = await import("@workspace-agent/shared");
const db = await import("../src/db");
const { buildHttpApp } = await import("../src/http");
const { hub } = await import("../src/hub");

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

// --- redaction ---
check("redacts sk- keys", redactSecrets("key is sk-ant-abc123def456ghi789").text.includes("[redacted]"));
check("redacts PEM blocks", redactSecrets("-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----").text === "[redacted]");
check("leaves prose alone", redactSecrets("the retry logic lives in src/http.ts").hits === 0);

// --- path containment ---
const root = os.tmpdir();
check("allows path inside root", checkPath(path.join(root, "src/app.ts"), [root]).allowed);
check("denies path outside root", !checkPath("/etc/passwd", [root]).allowed);
check("denies .env inside root", !checkPath(path.join(root, ".env"), [root]).allowed);
check("denies .env.local inside root", !checkPath(path.join(root, ".env.local"), [root]).allowed);
check("denies .ssh segment", !checkPath(path.join(root, ".ssh/id_rsa"), [root]).allowed);
check("denies traversal escape", !checkPath(path.join(root, "../../etc/passwd"), [root]).allowed);
check("extracts absolute glob pattern", extractToolPaths("Glob", { pattern: "/etc/**" }).length > 0);
check("ignores relative glob pattern", extractToolPaths("Glob", { pattern: "src/**/*.ts" }).length === 0);

// --- enrollment tokens & device auth ---
const token = db.mintEnrollToken("smokehost", "U0SMOKE1");
const creds = db.redeemEnrollToken(token);
check("redeems a fresh token", creds !== null);
check("rejects token reuse", db.redeemEnrollToken(token) === null);
check("rejects a bogus token", db.redeemEnrollToken("nope") === null);
check("verifies device secret", !!creds && db.verifyDevice(creds.deviceId, creds.deviceSecret) !== null);
check("rejects a wrong secret", !!creds && db.verifyDevice(creds.deviceId, "wrong") === null);
check("owner is auto-ACL'd", !!creds && db.hasAcl(creds.deviceId, "U0SMOKE1"));
check("stranger has no ACL", !!creds && !db.hasAcl(creds.deviceId, "U0RANDO"));

// --- HTTP enroll + WS handshake + presence + revocation ---
const server = createServer(buildHttpApp());
hub.attach(server);
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const token2 = db.mintEnrollToken("smokehost2", "U0SMOKE2");
const res = await fetch(`${base}/api/enroll`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: token2 }),
});
check("HTTP enroll succeeds", res.ok);
const ws2 = (await res.json()) as { deviceId: string; deviceSecret: string; hostName: string };
check("enroll returns host name", ws2.hostName === "smokehost2");

const badRes = await fetch(`${base}/api/enroll`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "garbage" }),
});
check("HTTP enroll rejects bad token", badRes.status === 400);

const dashNoAuth = await fetch(`${base}/admin`);
check("dashboard requires auth", dashNoAuth.status === 401);
const dashAuth = await fetch(`${base}/admin`, {
  headers: { authorization: "Basic " + Buffer.from("admin:smoke").toString("base64") },
});
check("dashboard opens with admin token", dashAuth.ok);

// good credentials connect
const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
  headers: { "x-device-id": ws2.deviceId, "x-device-secret": ws2.deviceSecret },
});
await new Promise<void>((resolve, reject) => {
  sock.on("open", resolve);
  sock.on("error", reject);
});
await new Promise((r) => setTimeout(r, 100));
check("hub sees the daemon online", hub.isOnline(ws2.deviceId));

sock.send(JSON.stringify({ type: "presence", paused: true }));
await new Promise((r) => setTimeout(r, 100));
check("hub tracks paused state", hub.isPaused(ws2.deviceId));

// --- owner API (device-authenticated, used by the Mac app) ---
const auth = { "x-device-id": ws2.deviceId, "x-device-secret": ws2.deviceSecret };
const json = { ...auth, "content-type": "application/json" };

const badOverview = await fetch(`${base}/api/host/overview`, {
  headers: { "x-device-id": ws2.deviceId, "x-device-secret": "nope" },
});
check("owner API refuses bad creds", badOverview.status === 401);

const overviewRes = await fetch(`${base}/api/host/overview`, { headers: auth });
const overview = (await overviewRes.json()) as {
  hostName: string;
  acl: { isOwner: boolean }[];
  conversations: unknown[];
};
check("owner overview returns host", overviewRes.ok && overview.hostName === "smokehost2");
check("owner overview lists owner ACL", overview.acl.some((a) => a.isOwner));
check("owner overview has conversations array", Array.isArray(overview.conversations));

const aclAdd = await fetch(`${base}/api/host/acl`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ action: "add", slackUserId: "U0FRIEND9" }),
});
check("owner can grant access", aclAdd.ok && db.hasAcl(ws2.deviceId, "U0FRIEND9"));

const aclRemoveOwner = await fetch(`${base}/api/host/acl`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ action: "remove", slackUserId: "U0SMOKE2" }),
});
check("owner cannot remove themselves", aclRemoveOwner.status === 400);

const aclRemove = await fetch(`${base}/api/host/acl`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ action: "remove", slackUserId: "U0FRIEND9" }),
});
check("owner can revoke access", aclRemove.ok && !db.hasAcl(ws2.deviceId, "U0FRIEND9"));

const limitSet = await fetch(`${base}/api/host/limit`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ dailyLimit: 7 }),
});
check("owner sets own daily budget", limitSet.ok && db.getHostById(ws2.deviceId)?.daily_limit === 7);

const limitBad = await fetch(`${base}/api/host/limit`, {
  method: "POST",
  headers: json,
  body: JSON.stringify({ dailyLimit: -3 }),
});
check("negative budget refused", limitBad.status === 400);

// bad credentials are refused at upgrade
const badSock = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
  headers: { "x-device-id": ws2.deviceId, "x-device-secret": "wrong" },
});
const badRefused = await new Promise<boolean>((resolve) => {
  badSock.on("open", () => resolve(false));
  badSock.on("error", () => resolve(true));
});
check("bad WS credentials refused", badRefused);

// revocation severs the live socket
const closeCode = new Promise<number>((resolve) => sock.on("close", (code) => resolve(code)));
db.revokeHost(ws2.deviceId);
hub.disconnect(ws2.deviceId);
check("revoked socket closed with 4001", (await closeCode) === 4001);
check("hub sees the daemon offline", !hub.isOnline(ws2.deviceId));
check("dispatch to offline host returns null", hub.dispatch(ws2.deviceId, {
  threadKey: "t", question: "q", askerId: "U", askerName: "n", resumeSessionId: null,
}, { onStatus: () => {}, onPartial: () => {}, onResult: () => {} }) === null);

// re-enrollment under a previously used (now revoked) name must work
const token4 = db.mintEnrollToken("smokehost2", "U0SMOKE2");
check("re-enroll after revoke reuses the name", db.redeemEnrollToken(token4) !== null);
const token5 = db.mintEnrollToken("smokehost2", "U0SMOKE2");
check("second ACTIVE host with same name refused", db.redeemEnrollToken(token5) === null);

server.close();
console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
