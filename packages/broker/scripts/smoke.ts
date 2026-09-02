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
process.env.PEER_ASKS_PER_QUERY = "2";

const { checkPath, extractToolPaths, redactSecrets } = await import("@workspace-agent/shared");
const db = await import("../src/db");
const { buildHttpApp } = await import("../src/http");
const { hub } = await import("../src/hub");
const { runQuery } = await import("../src/router");

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
check("extracts a climbing relative glob pattern", extractToolPaths("Glob", { pattern: "../**/*.ts" }).length > 0);
check("resolves relative paths against the session root", checkPath("src/app.ts", [root], root).allowed);
check("denies a relative climb out of the session root", !checkPath("../outside.ts", [root], root).allowed);
check("denies a relative .env in the session root", !checkPath(".env", [root], root).allowed);

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


// --- agents asking agents ---

/** Resolves with the next frame on `socket` that `match` accepts. */
function nextFrame(socket: WebSocket, match: (m: any) => boolean, ms = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMsg);
      reject(new Error("timed out waiting for a frame"));
    }, ms);
    const onMsg = (raw: WebSocket.RawData): void => {
      const m = JSON.parse(raw.toString());
      if (!match(m)) return;
      clearTimeout(timer);
      socket.off("message", onMsg);
      resolve(m);
    };
    socket.on("message", onMsg);
  });
}

// Host A is smokehost2 (sock). Enroll and connect host B, and have both announce folders.
const tokenB = db.mintEnrollToken("peerhost", "U0PEER");
const credsB = db.redeemEnrollToken(tokenB)!;
const sockB = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
  headers: { "x-device-id": credsB.deviceId, "x-device-secret": credsB.deviceSecret },
});
await new Promise<void>((resolve, reject) => {
  sockB.on("open", resolve);
  sockB.on("error", reject);
});
sockB.send(JSON.stringify({ type: "presence", paused: false, folders: ["acme-api"] }));
sock.send(JSON.stringify({ type: "presence", paused: false, folders: ["web"] }));
await new Promise((r) => setTimeout(r, 100));
check("hub records announced folders", hub.foldersOf(credsB.deviceId).join() === "acme-api");
check("presence without folders still parses", hub.foldersOf(ws2.deviceId).join() === "web");

// The owner of host A may ask host B.
db.addAcl(credsB.deviceId, "U0SMOKE2", "U0PEER");

const posted: string[] = [];
const fakeSlack = {
  chat: {
    update: async ({ text }: { text: string }) => {
      posted.push(text);
      return {};
    },
    postMessage: async ({ text }: { text: string }) => {
      posted.push(text);
      return { ts: "1" };
    },
  },
} as unknown as import("@slack/web-api").WebClient;

const askA = (threadKey: string): void =>
  runQuery({
    client: fakeSlack,
    host: db.getHostById(ws2.deviceId)!,
    askerId: "U0SMOKE2",
    askerName: "Smoke",
    question: "who calls the api?",
    channel: "C1",
    placeholderTs: "1.0",
    threadKey,
  });

const queryA = nextFrame(sock, (m) => m.type === "query");
askA("smoke:peer");
const qA = await queryA;
check("query carries depth 0", qA.depth === 0 && qA.viaHost === null);
check(
  "query lists reachable peers with status and folders",
  qA.peers.some((p: any) => p.name === "peerhost" && p.online === true && p.paused === false && p.folders[0] === "acme-api"),
);
check("query does not list the answering host itself", !qA.peers.some((p: any) => p.name === "smokehost2"));
check("query carries the consultation cap", qA.peerAskLimit === 2);

// A consults B.
const queryB = nextFrame(sockB, (m) => m.type === "query");
sock.send(JSON.stringify({ type: "ask_peer", queryId: qA.queryId, requestId: "r1", hostName: "peerhost", question: "which endpoint serves /users?" }));
const qB = await queryB;
check("consultation reaches host B at depth 1, naming the asking host", qB.depth === 1 && qB.viaHost === "smokehost2");
check("consultation keeps the person as asker", qB.askerId === "U0SMOKE2" && qB.askerName === "Smoke");
check("consulted agent gets no peers and no tool", qB.peers.length === 0 && qB.peerAskLimit === 0);
check("consultation thread is bound to host B", db.getThread(`smoke:peer>${credsB.deviceId}`)?.host_id === credsB.deviceId);

// B may not consult onward.
const onward = nextFrame(sockB, (m) => m.type === "peer_result" && m.requestId === "rB");
sockB.send(JSON.stringify({ type: "ask_peer", queryId: qB.queryId, requestId: "rB", hostName: "smokehost2", question: "?" }));
check("a consulted agent cannot consult onward", (await onward).ok === false);

// B answers; A receives it.
const resultA = nextFrame(sock, (m) => m.type === "peer_result" && m.requestId === "r1");
sockB.send(JSON.stringify({ type: "result", queryId: qB.queryId, ok: true, text: "GET /users lives in routes/users.ts", sessionId: "sess-b" }));
const rA = await resultA;
check("host A receives the peer answer", rA.ok === true && rA.hostName === "peerhost" && rA.text.includes("routes/users.ts"));
check("peer session id is remembered", db.getThread(`smoke:peer>${credsB.deviceId}`)?.sdk_session_id === "sess-b");

// Self-asks and unknown names are refused without dispatch.
const selfRes = nextFrame(sock, (m) => m.type === "peer_result" && m.requestId === "r2");
sock.send(JSON.stringify({ type: "ask_peer", queryId: qA.queryId, requestId: "r2", hostName: "smokehost2", question: "?" }));
check("an agent cannot ask itself", (await selfRes).ok === false);
const ghostRes = nextFrame(sock, (m) => m.type === "peer_result" && m.requestId === "r3");
sock.send(JSON.stringify({ type: "ask_peer", queryId: qA.queryId, requestId: "r3", hostName: "nobody", question: "?" }));
check("unknown agent names are refused", (await ghostRes).ok === false);

// A second consultation resumes B's session; a third exceeds the cap.
const queryB2 = nextFrame(sockB, (m) => m.type === "query");
sock.send(JSON.stringify({ type: "ask_peer", queryId: qA.queryId, requestId: "r4", hostName: "peerhost", question: "and auth?" }));
const qB2 = await queryB2;
check("second consultation resumes the peer session", qB2.resumeSessionId === "sess-b");
const resultA2 = nextFrame(sock, (m) => m.type === "peer_result" && m.requestId === "r4");
sockB.send(JSON.stringify({ type: "result", queryId: qB2.queryId, ok: true, text: "middleware/auth.ts" }));
await resultA2;
const capRes = nextFrame(sock, (m) => m.type === "peer_result" && m.requestId === "r5");
sock.send(JSON.stringify({ type: "ask_peer", queryId: qA.queryId, requestId: "r5", hostName: "peerhost", question: "more?" }));
const capped = await capRes;
check("consultations per question are capped", capped.ok === false && /consultation/.test(capped.error));

// A finishes: Slack credits the consulted agent, transcripts keep the audit trail on both sides.
sock.send(JSON.stringify({ type: "result", queryId: qA.queryId, ok: true, text: "routes/users.ts, per peerhost" }));
await new Promise((r) => setTimeout(r, 150));
check("final Slack message credits the consulted agent", posted.some((t) => t.includes("Consulted peerhost's agent")));
const parentTranscript = db.getTranscript("smoke:peer");
check(
  "parent transcript records question and answer of the consultation",
  parentTranscript.some((m) => m.role === "system" && m.content.includes("Asked peerhost's agent")) &&
    parentTranscript.some((m) => m.role === "system" && m.content.includes("peerhost's agent answered")),
);
const childTranscript = db.getTranscript(`smoke:peer>${credsB.deviceId}`);
check(
  "consultation transcript on host B shows who asked, the question, and the answer",
  childTranscript.some((m) => m.role === "system" && m.content.includes("on behalf of Smoke")) &&
    childTranscript.some((m) => m.role === "user") &&
    childTranscript.some((m) => m.role === "assistant"),
);
check("consultations count against host B's budget", db.usageToday(credsB.deviceId) === 2);

// Without access to B, neither the person nor their agent can reach it.
db.removeAcl(credsB.deviceId, "U0SMOKE2");
const queryA2 = nextFrame(sock, (m) => m.type === "query");
askA("smoke:peer2");
const qA2 = await queryA2;
check("peers list hides agents the asker can't reach", !qA2.peers.some((p: any) => p.name === "peerhost"));
const aclRes = nextFrame(sock, (m) => m.type === "peer_result" && m.requestId === "r6");
sock.send(JSON.stringify({ type: "ask_peer", queryId: qA2.queryId, requestId: "r6", hostName: "peerhost", question: "?" }));
const aclDenied = await aclRes;
check("consulting an agent the asker can't reach is refused", aclDenied.ok === false && /access/.test(aclDenied.error));
sock.send(JSON.stringify({ type: "result", queryId: qA2.queryId, ok: true, text: "done" }));

// Ending the question ends its consultations.
db.addAcl(credsB.deviceId, "U0SMOKE2", "U0PEER");
const queryA3 = nextFrame(sock, (m) => m.type === "query");
askA("smoke:peer3");
const qA3 = await queryA3;
const queryB3 = nextFrame(sockB, (m) => m.type === "query");
sock.send(JSON.stringify({ type: "ask_peer", queryId: qA3.queryId, requestId: "r7", hostName: "peerhost", question: "slow?" }));
const qB3 = await queryB3;
const cancelB = nextFrame(sockB, (m) => m.type === "cancel" && m.queryId === qB3.queryId);
hub.cancel(qA3.queryId, "smoke cancelled");
check("cancelling a question cancels its consultation", (await cancelB).type === "cancel");

// Owners can opt out of taking questions from other agents; on by default.
check("hosts take questions from agents by default", db.getHostById(credsB.deviceId)?.accept_peer_asks === 1);
const authB = { "x-device-id": credsB.deviceId, "x-device-secret": credsB.deviceSecret, "content-type": "application/json" };
const optOut = await fetch(`${base}/api/host/peers`, { method: "POST", headers: authB, body: JSON.stringify({ acceptPeerAsks: false }) });
check("owner can opt out of agent questions", optOut.ok && db.getHostById(credsB.deviceId)?.accept_peer_asks === 0);
const overviewB = (await (await fetch(`${base}/api/host/overview`, { headers: authB })).json()) as { acceptPeerAsks: boolean };
check("owner overview reports the setting", overviewB.acceptPeerAsks === false);
const badToggle = await fetch(`${base}/api/host/peers`, { method: "POST", headers: authB, body: JSON.stringify({ acceptPeerAsks: "no" }) });
check("non-boolean toggle refused", badToggle.status === 400);
const queryA4 = nextFrame(sock, (m) => m.type === "query");
askA("smoke:peer4");
const qA4 = await queryA4;
check("peers list marks an opted-out agent as not consultable", qA4.peers.some((p: any) => p.name === "peerhost" && p.consultable === false));
const optOutRes = nextFrame(sock, (m) => m.type === "peer_result" && m.requestId === "r8");
sock.send(JSON.stringify({ type: "ask_peer", queryId: qA4.queryId, requestId: "r8", hostName: "peerhost", question: "?" }));
const refusedOptOut = await optOutRes;
check("consulting an opted-out agent is refused", refusedOptOut.ok === false && /doesn't take questions/.test(refusedOptOut.error));
sock.send(JSON.stringify({ type: "result", queryId: qA4.queryId, ok: true, text: "done" }));
const optIn = await fetch(`${base}/api/host/peers`, { method: "POST", headers: authB, body: JSON.stringify({ acceptPeerAsks: true }) });
check("owner can opt back in", optIn.ok && db.getHostById(credsB.deviceId)?.accept_peer_asks === 1);
sockB.close();
await new Promise((r) => setTimeout(r, 100));

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
  depth: 0, viaHost: null, peers: [], peerAskLimit: 0,
}, { onStatus: () => {}, onPartial: () => {}, onResult: () => {} }) === null);

// re-enrollment under a previously used (now revoked) name must work
const token4 = db.mintEnrollToken("smokehost2", "U0SMOKE2");
check("re-enroll after revoke reuses the name", db.redeemEnrollToken(token4) !== null);
const token5 = db.mintEnrollToken("smokehost2", "U0SMOKE2");
check("second ACTIVE host with same name refused", db.redeemEnrollToken(token5) === null);

server.close();
console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
