import { describe, expect, it } from "vitest";
import {
  hasPermissionBits,
  toPermissionsBitField,
  PermissionsBitField,
  PermissionFlags,
} from "./permissions.js";

describe("toPermissionsBitField", () => {
  it("passes through PermissionsBitField instances", () => {
    const bf = new PermissionsBitField(7n);
    expect(toPermissionsBitField(bf)).toBe(bf);
  });

  it("normalizes bigint, number, string, and duck-typed bitfield objects", () => {
    expect(toPermissionsBitField(7n).bitfield).toBe(7n);
    expect(toPermissionsBitField(7).bitfield).toBe(7n);
    expect(toPermissionsBitField("7").bitfield).toBe(7n);
    expect(toPermissionsBitField({ bitfield: 7n }).bitfield).toBe(7n);
    expect(toPermissionsBitField({ bitfield: "7" }).bitfield).toBe(7n);
  });

  it("rejects invalid values", () => {
    expect(() => toPermissionsBitField(-1)).toThrow();
    expect(() => toPermissionsBitField(1.5)).toThrow();
    expect(() => toPermissionsBitField("   ")).toThrow();
    expect(() => toPermissionsBitField(undefined)).toThrow();
    expect(() => toPermissionsBitField(null)).toThrow();
  });
});

describe("hasPermissionBits", () => {
  it("checks required bits across mixed input types", () => {
    expect(hasPermissionBits(7n, 3n)).toBe(true);
    expect(hasPermissionBits("7", 1n)).toBe(true);
    expect(hasPermissionBits({ bitfield: 4n }, 2n)).toBe(false);
  });

  it("works with upstream PermissionFlags", () => {
    const admin = PermissionFlags.Administrator; // 8n
    const kick = PermissionFlags.KickMembers; // 2n
    const both = admin | kick;
    expect(hasPermissionBits(both, admin)).toBe(true);
    expect(hasPermissionBits(both, kick)).toBe(true);
    expect(hasPermissionBits(kick, admin)).toBe(false);
  });

  it("works with PermissionsBitField instances", () => {
    const bf = new PermissionsBitField(
      PermissionFlags.ManageChannels | PermissionFlags.ManageGuild,
    );
    expect(hasPermissionBits(bf, PermissionFlags.ManageChannels)).toBe(true);
    expect(hasPermissionBits(bf, PermissionFlags.BanMembers)).toBe(false);
  });
});
