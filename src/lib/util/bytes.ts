export function bytesToHex(bytes: Uint8Array, sep = ''): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0) out += sep;
    out += bytes[i].toString(16).padStart(2, '0').toUpperCase();
  }
  return out;
}

const textEncoder = new TextEncoder();
export function utf8Encode(text: string): Uint8Array {
  return textEncoder.encode(text);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

export function escapeHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += `\\x${bytes[i].toString(16).padStart(2, '0')}`;
  return out;
}

export function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return formatDateTime(iso).slice(0, 10);
}

export function excerpt(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function makeId(prefix: string, random = false): string {
  if (random) {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    return `${prefix}_${Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  return `${prefix}_${Date.now().toString(36)}`;
}

/** Stable JSON stringification: sorted object keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  // Tracks only the *current* path so shared references (the same superseded
  // array appearing under both op and version) serialise normally while true
  // cycles still throw.
  const stack = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Uint8Array) return { __bytes: bytesToHex(v) };
    if (stack.has(v)) throw new Error('canonicalJson: circular reference');
    stack.add(v);
    try {
      if (Array.isArray(v)) return v.map(walk);
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        if (obj[key] === undefined) continue;
        out[key] = walk(obj[key]);
      }
      return out;
    } finally {
      stack.delete(v);
    }
  };
  return JSON.stringify(walk(value));
}

/** Middle-truncated hash for dense UI tables. */
export function shortHash(hex: string, head = 10, tail = 6): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}
