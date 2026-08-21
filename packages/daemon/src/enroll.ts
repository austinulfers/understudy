import type { DaemonConfig } from "./config";

export interface EnrollCredentials {
  deviceId: string;
  deviceSecret: string;
  hostName: string;
}

/** Redeem a one-time token with the broker. Throws with a friendly message. */
export async function enrollWithBroker(brokerUrl: string, token: string): Promise<EnrollCredentials> {
  const base = brokerUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/api/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    throw new Error(`Could not reach the broker at ${base} — check the URL and that the broker is up. (${(err as Error).message})`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  return (await res.json()) as EnrollCredentials;
}

/** Best-effort revocation with the broker. Returns whether it acknowledged. */
export async function unenrollFromBroker(config: DaemonConfig): Promise<boolean> {
  const res = await fetch(`${config.brokerUrl}/api/unenroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: config.deviceId, deviceSecret: config.deviceSecret }),
  }).catch(() => null);
  return res?.ok ?? false;
}
