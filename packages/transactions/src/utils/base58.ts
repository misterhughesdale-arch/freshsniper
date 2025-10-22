/**
 * Lightweight helpers for working with base58/base64 encoded data.
 *
 * These utilities are shared across the codebase so we avoid
 * re-implementing the encoding logic in every package that needs to
 * decode Yellowstone payloads. They intentionally avoid taking any
 * external dependency (like `bs58`) to keep cold start time minimal.
 */

/**
 * Attempts to decode a base64 string into a byte array. Returns `null`
 * if the value cannot be decoded (because it was not base64 encoded).
 */
export function safeBase64Decode(value: string): Uint8Array | null {
  try {
    const buffer = Buffer.from(value, "base64");
    if (buffer.length === 0) {
      return null;
    }
    return buffer;
  } catch (error) {
    return null;
  }
}

/**
 * Encodes a byte array as a base58 string using the canonical alphabet
 * employed by Solana (which matches Bitcoin's base58).
 */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }

  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];

  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let leadingZeroCount = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      leadingZeroCount += 1;
    } else {
      break;
    }
  }

  let result = "";
  for (let i = 0; i < leadingZeroCount; i += 1) {
    result += "1";
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    result += alphabet[digits[i]];
  }
  return result;
}

/**
 * Normalises any Yellowstone field that might contain a signature or
 * blockhash. The gRPC gateway returns these either as raw base58
 * strings, base64 strings or byte arrays. This helper unifies the
 * output and always returns a base58 string when possible.
 */
export function normalizeToBase58(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    const decoded = safeBase64Decode(value);
    if (decoded) {
      return encodeBase58(decoded);
    }
    return value;
  }

  if (value instanceof Uint8Array) {
    return encodeBase58(value);
  }

  if (Array.isArray(value)) {
    return encodeBase58(Uint8Array.from(value as number[]));
  }

  return null;
}

