/**
 * Outbound secret redaction. Runs on the daemon before an answer leaves the
 * host machine, and again on the broker before anything is posted to Slack.
 * Deliberately aggressive: a false positive costs a garbled token in an
 * answer; a false negative posts a credential to Slack.
 */

const PATTERNS: RegExp[] = [
  // Private key blocks (PEM)
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // Anthropic / OpenAI style keys
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g,
  // AWS access key ids and secret assignments
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\baws_secret_access_key\s*[=:]\s*\S+/gi,
  // GitHub tokens
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Generic "password=..." / "secret=..." assignments in env/ini style lines
  /\b(?:password|passwd|secret|api_key|apikey|access_token|auth_token)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi,
];

export function redactSecrets(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, () => {
      hits += 1;
      return "[redacted]";
    });
  }
  return { text: out, hits };
}
