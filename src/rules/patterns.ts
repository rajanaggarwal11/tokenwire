/**
 * Text patterns shared by the security rules. The same families mcpcheck uses
 * for tool descriptions, applied here to what arrives in tool results and to
 * everything that reaches the model.
 */
export interface TextPattern {
  pattern: RegExp;
  why: string;
}

export const INSTRUCTION_PATTERNS: TextPattern[] = [
  {
    pattern:
      /\bignore\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|other|system)\s+(instructions?|prompts?|rules?|guidance|tools?)/i,
    why: "tells the model to ignore its instructions",
  },
  {
    pattern:
      /\b(do\s+not|don'?t|never)\s+(tell|inform|mention|reveal|show|warn|ask|notify)\b[^.]{0,60}\b(user|human|operator)\b/i,
    why: "asks the model to hide something from the user",
  },
  {
    pattern: /<\s*(system|assistant|instruction|hidden|im_start)\b[^>]*>|\[\s*(system|inst)\s*\]/i,
    why: "contains a fake role or instruction tag",
  },
  {
    pattern:
      /\b(you\s+must|you\s+should\s+always|always\s+(call|use|run|invoke|execute|send|include)|as\s+an?\s+ai\s+(assistant|model),?\s+you)\b/i,
    why: "contains an imperative directed at the model",
  },
  {
    pattern:
      /(?<!\b(?:not|never|don'?t|without|avoid|nor)\s+(?:\w+\s+){0,2})\b(send|forward|include|attach|pass|transmit|post|exfiltrate)\b[^.]{0,60}\b(api[\s_-]?keys?|tokens?|passwords?|secrets?|credentials?|\.env|ssh[\s_-]?keys?|private[\s_-]?keys?)\b/i,
    why: "asks for credentials to be sent along",
  },
];

// Built from code points on purpose: a raw U+2028 in source is a line
// terminator to the parser, and backslash-u escapes have been observed to
// arrive decoded.
const cp = (n: number): string => String.fromCodePoint(n);
const span = (from: number, to: number): string => `${cp(from)}-${cp(to)}`;
export const INVISIBLE = new RegExp(
  `[${span(0x200b, 0x200f)}${span(0x2028, 0x202e)}${span(0x2060, 0x2064)}${span(0x2066, 0x2069)}${cp(0xfeff)}]` +
    `|[${span(0xe0000, 0xe007f)}]`,
  "u",
);

export const SECRET_PATTERNS: {
  pattern: RegExp;
  what: string;
  /** What to remove when the secret is longer than what detecting it needs (a PEM block). */
  extent?: RegExp;
}[] = [
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, what: "an AWS access key id" },
  { pattern: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}\b/, what: "an sk- API key" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, what: "a GitHub token" },
  { pattern: /\bxox[abp]-[A-Za-z0-9-]{10,}\b/, what: "a Slack token" },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    what: "a private key",
    extent: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/, what: "a bearer token" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, what: "a Google API key" },
  {
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/i,
    what: "a database URL with a password",
  },
];

export function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

/** How a redacted secret reads in text that leaves the record. */
export const REDACTED = /\[redacted: [^\]]+\]/g;

/**
 * The text with everything `secret-in-context` would flag replaced by
 * `[redacted: <what>]`, and the secrets that were removed, in the order their
 * placeholders appear. Used wherever text leaves the local record, such as a snapshot
 * meant to be committed. Where two patterns overlap, the one that starts first wins.
 */
export function redact(text: string): { text: string; secrets: string[] } {
  const found: { start: number; end: number; what: string }[] = [];
  for (const { pattern, what, extent } of SECRET_PATTERNS) {
    if (!pattern.test(text)) continue;
    const re = extent ?? pattern;
    for (const m of text.matchAll(new RegExp(re.source, `${re.flags.replace("g", "")}g`)))
      if (m[0].length) found.push({ start: m.index, end: m.index + m[0].length, what });
  }
  if (!found.length) return { text, secrets: [] };
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let at = 0;
  const secrets: string[] = [];
  for (const f of found) {
    if (f.start < at) continue;
    out += `${text.slice(at, f.start)}[redacted: ${f.what}]`;
    secrets.push(text.slice(f.start, f.end));
    at = f.end;
  }
  return { text: out + text.slice(at), secrets };
}

export function redactSecrets(text: string): string {
  return redact(text).text;
}
