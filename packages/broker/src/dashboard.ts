import { readdirSync as fsReaddir } from "node:fs";
import {
  getTranscript,
  listAcls,
  listHosts,
  listRecentThreads,
  usageToday,
  type HostRow,
} from "./db";
import { config } from "./config";
import { formatLastSeen } from "./format";
import { hub } from "./hub";

export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1b2428;background:#f6f8f8;line-height:1.5;overflow-wrap:break-word}
  h1,h2{font-weight:650} a{color:#0e7c86}
  /* Tables scroll inside their own box so narrow windows never clip the page. */
  .table-wrap{overflow-x:auto;background:#fff;border:1px solid #dde4e5;border-radius:8px}
  table{border-collapse:collapse;width:100%;font-size:.9rem}
  th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid #dde4e5;vertical-align:top}
  tbody tr:last-child td{border-bottom:none}
  th{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:#5b6a70;background:#f0f4f4;white-space:nowrap}
  .nowrap{white-space:nowrap}
  form.inline{display:inline}
  button,input{font-family:inherit;font-size:.85rem}
  input[type=text]{padding:.35rem .5rem;border:1px solid #b9c4c6;border-radius:5px;min-width:0}
  button{padding:.35rem .7rem;border:1px solid #0e7c86;background:#0e7c86;color:#fff;border-radius:5px;cursor:pointer;line-height:1.3}
  button:hover{filter:brightness(1.1)}
  button.danger{background:#a33;border-color:#a33}
  :focus-visible{outline:2px solid #0e7c86;outline-offset:2px}
  .fields{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
  .fields input[type=text]{flex:1 1 16rem}
  /* Each ACL entry keeps its remove button glued to its user ID. */
  .chip{display:inline-flex;align-items:center;gap:.3rem;white-space:nowrap;margin:0 .4rem .35rem 0}
  .chip button{padding:.05rem .35rem}
  .acl-add{display:flex;gap:.35rem;align-items:center;margin-top:.15rem}
  .pill{display:inline-block;padding:.1rem .5rem;border-radius:99px;font-size:.75rem;font-weight:600;white-space:nowrap}
  .on{background:#dcf2e6;color:#146c43}.off{background:#e8ebec;color:#5b6a70}.rev{background:#f7dede;color:#8a2020}.paused{background:#fdf0d5;color:#8a6100}
  .msg{background:#fff;border:1px solid #dde4e5;border-radius:8px;padding:.75rem 1rem;margin:.5rem 0}
  .msg.user{border-left:3px solid #0e7c86}.msg.assistant{border-left:3px solid #999}.msg.system{border-left:3px solid #a33}
  /* pre-wrap lives on the body only, so template indentation never leaks in. */
  .msg .body{white-space:pre-wrap;overflow-wrap:anywhere}
  .meta{font-size:.75rem;color:#5b6a70;margin-bottom:.25rem}
  code{background:#eef2f2;padding:.1em .35em;border-radius:4px;overflow-wrap:anywhere}
  code.cmd{display:block;padding:.5rem .65rem;border:1px solid #dde4e5;border-radius:6px;font-size:.85rem;white-space:pre-wrap}
  nav{margin-bottom:1.5rem}nav a{margin-right:1rem}
</style></head><body>
<nav><a href="/admin">Hosts</a><a href="/admin/conversations">Conversations</a></nav>
${body}
</body></html>`;
}

function statusPill(host: HostRow): string {
  if (host.status === "revoked") return `<span class="pill rev">revoked</span>`;
  if (hub.isOnline(host.id)) {
    return hub.isPaused(host.id)
      ? `<span class="pill paused">paused</span>`
      : `<span class="pill on">online</span>`;
  }
  return `<span class="pill off">offline · ${esc(formatLastSeen(host.last_seen))}</span>`;
}

export function renderHome(): string {
  const rows = listHosts()
    .map((h) => {
      const acls = listAcls(h.id)
        .map(
          (u) =>
            `<span class="chip"><code>${esc(u)}</code><form class="inline" method="post" action="/admin/hosts/${h.id}/acl/remove"><input type="hidden" name="slack_user_id" value="${esc(u)}"><button class="danger" title="Remove ${esc(u)}" aria-label="Remove ${esc(u)}">×</button></form></span>`,
        )
        .join("");
      const actions =
        h.status === "active"
          ? `<form class="inline" method="post" action="/admin/hosts/${h.id}/revoke" onsubmit="return confirm('Revoke ${esc(h.name)}? Their daemon is cut off immediately.')"><button class="danger">Revoke</button></form>`
          : "";
      const aclForm =
        h.status === "active"
          ? `<form class="acl-add" method="post" action="/admin/hosts/${h.id}/acl"><input type="text" name="slack_user_id" placeholder="U012ABCDEF" size="12"><button>Allow</button></form>`
          : "";
      const folders = hub.foldersOf(h.id);
      const covers = folders.length ? `<br><span class="meta">${esc(folders.join(", "))}</span>` : "";
      const noAgents = h.accept_peer_asks === 1 ? "" : `<br><span class="meta">not taking questions from agents</span>`;
      return `<tr>
        <td><strong>${esc(h.name)}</strong><br><span class="meta nowrap">owner ${esc(h.owner_slack_id)}</span>${covers}${noAgents}</td>
        <td>${statusPill(h)}</td>
        <td class="nowrap">${usageToday(h.id)} / ${h.daily_limit ?? config.defaultDailyLimit} today</td>
        <td>${acls || "<em>owner only</em>"}${aclForm}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join("");

  return page(
    "Workspace Agent — Hosts",
    `<h1>Hosts</h1>
    <div class="table-wrap"><table>
      <thead><tr><th>Host</th><th>Status</th><th>Usage</th><th>Who may ask (Slack user IDs)</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5"><em>No hosts enrolled yet.</em></td></tr>`}</tbody>
    </table></div>
    <h2>Enroll a new coworker</h2>
    <form class="fields" method="post" action="/admin/tokens">
      <input type="text" name="host_name" placeholder="host name, e.g. jane" required>
      <input type="text" name="owner_slack_id" placeholder="owner Slack ID, e.g. U012ABCDEF" required>
      <button>Mint one-time token</button>
    </form>
    <p class="meta">The token is shown once, expires in 24h, and enrolls exactly one machine.</p>`,
  );
}

export function renderToken(hostName: string, token: string, publicUrl: string): string {
  const appLink = `workspace-agent://enroll?broker=${encodeURIComponent(publicUrl)}&token=${encodeURIComponent(token)}`;
  const dmgs = listDownloads();
  const downloadLine = dmgs.length
    ? dmgs.map((f) => `<a href="/downloads/${encodeURIComponent(f)}">${esc(f)}</a>`).join(" · ")
    : `<em>no installer uploaded yet — build one with <code>pnpm app dist</code> and drop the DMG into <code>packages/broker/downloads/</code></em>`;
  return page(
    "Enrollment token",
    `<h1>Enroll ${esc(hostName)}</h1>
     <p>Send them these two things privately. The token expires in 24 hours and works once.</p>
     <h2>1 · Install the Mac app</h2>
     <p>${downloadLine}</p>
     <p class="meta">First launch on an unsigned build: right-click the app → Open.</p>
     <h2>2 · One-click enroll link</h2>
     <p>After installing, this link opens the app with everything filled in — they just pick folders:</p>
     <p><code class="cmd">${esc(appLink)}</code></p>
     <h2>Command line alternative</h2>
     <p><code class="cmd">pnpm daemon enroll --broker ${esc(publicUrl)} --token ${esc(token)} --root ~/code/your-repo</code></p>
     <p><a href="/admin">← back</a></p>`,
  );
}

function listDownloads(): string[] {
  try {
    return fsReaddir("downloads").filter((f) => f.endsWith(".dmg") || f.endsWith(".zip"));
  } catch {
    return [];
  }
}

export function renderConversations(): string {
  const rows = listRecentThreads()
    .map(
      (t) => `<tr>
        <td><a href="/admin/conversations/view?key=${encodeURIComponent(t.thread_key)}">${esc(t.thread_key)}</a></td>
        <td>${esc(t.host_name)}</td>
        <td>${esc(t.created_by)}</td>
        <td>${t.messages}</td>
        <td class="nowrap">${new Date(t.last_active).toLocaleString()}</td>
      </tr>`,
    )
    .join("");
  return page(
    "Conversations",
    `<h1>Conversations</h1>
     <div class="table-wrap"><table>
       <thead><tr><th>Thread</th><th>Host</th><th>Started by</th><th>Messages</th><th>Last active</th></tr></thead>
       <tbody>${rows || `<tr><td colspan="5"><em>Nothing yet.</em></td></tr>`}</tbody>
     </table></div>`,
  );
}

export function renderTranscript(threadKey: string): string {
  const messages = getTranscript(threadKey)
    .map(
      (m) =>
        `<div class="msg ${esc(m.role)}">` +
        `<div class="meta">${esc(m.role)} · ${esc(m.asker_slack_id)} · ${new Date(m.created_at).toLocaleString()}</div>` +
        `<div class="body">${esc(m.content)}</div>` +
        `</div>`,
    )
    .join("");
  return page(
    `Transcript ${threadKey}`,
    `<h1>Transcript</h1><p class="meta"><code>${esc(threadKey)}</code></p>${messages || "<p><em>Empty.</em></p>"}
     <p><a href="/admin/conversations">← back to conversations</a></p>`,
  );
}
