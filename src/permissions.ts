/**
 * Permission utilities for openclaw-fluxer.
 *
 * Uses `PermissionsBitField` and `PermissionFlags` from `@fluxerjs/core`
 * (re-exported from `@fluxerjs/util`). All permission math is bigint-native
 * as of FluxerJS v1.2.3+.
 */

import { PermissionsBitField, PermissionFlags } from "@fluxerjs/core";

export { PermissionsBitField, PermissionFlags };

// ---------------------------------------------------------------------------
// Normalize heterogeneous permission inputs into a PermissionsBitField
// ---------------------------------------------------------------------------

export type PermissionLike =
  | bigint
  | number
  | string
  | PermissionsBitField
  | { bitfield?: bigint | number | string | null | undefined }
  | null
  | undefined;

/**
 * Coerce any permission-like value into a `PermissionsBitField`.
 *
 * Accepts:
 * - `bigint` / `number` / numeric `string` (raw bits)
 * - An existing `PermissionsBitField`
 * - An object with a `.bitfield` property (duck-typed BitField)
 *
 * Throws on invalid / empty input.
 */
export function toPermissionsBitField(value: PermissionLike): PermissionsBitField {
  if (value instanceof PermissionsBitField) return value;

  if (typeof value === "bigint") return new PermissionsBitField(value);

  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error("Permission bits number must be a non-negative integer");
    }
    return new PermissionsBitField(BigInt(value));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Permission bits string cannot be empty");
    return new PermissionsBitField(BigInt(trimmed));
  }

  if (value && typeof value === "object" && "bitfield" in value) {
    return toPermissionsBitField(value.bitfield);
  }

  throw new Error("Unsupported permission bitfield value");
}

/**
 * Check whether `subject` has all bits in `required`.
 */
export function hasPermissionBits(
  subject: PermissionLike,
  required: PermissionLike,
): boolean {
  return toPermissionsBitField(subject).has(toPermissionsBitField(required).bitfield);
}
