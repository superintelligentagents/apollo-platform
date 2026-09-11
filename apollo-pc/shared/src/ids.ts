// Deterministic record ids: re-importing the same export must reproduce the
// same ids so inclusion/edit decisions and task references survive, and
// dedupe is a Map.set. crypto.subtle is async and awkward mid-parse-loop;
// two cyrb53 runs with different seeds give 106 bits — collision-safe at
// personal-archive scale.

function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function h128(input: string): string {
  return cyrb53(input, 1).toString(36) + cyrb53(input, 2).toString(36);
}

export function recordId(sourceDetail: string, nativeKey: string): string {
  return `${sourceDetail}-${h128(nativeKey)}`;
}

export function shortId(length = 10): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function randomUuid(random: { randomUUID?: () => string; getRandomValues(array: Uint8Array): Uint8Array } = crypto): string {
  if (typeof random.randomUUID === "function") return random.randomUUID();
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
