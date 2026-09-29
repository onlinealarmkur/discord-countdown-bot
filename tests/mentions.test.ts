import { describe, expect, it } from "vitest";
import { allowedMentions } from "../src/discord/mentions.js";
import { countdown } from "./fixtures.js";

describe("allowedMentions", () => {
  it("allows only the explicit creator mention", () => {
    expect(allowedMentions(countdown())).toEqual({
      parse: [],
      repliedUser: false,
      users: ["123456789012345678"],
    });
  });

  it("allows only the explicit role mention", () => {
    expect(allowedMentions(countdown({ mention: "<@&987654321098765432>" }))).toEqual({
      parse: [],
      repliedUser: false,
      roles: ["987654321098765432"],
    });
  });

  it("does not parse malformed or injected mentions", () => {
    expect(allowedMentions(countdown({ mention: "@everyone <@123456789012345678>" }))).toEqual({
      parse: [],
      repliedUser: false,
    });
  });
});
