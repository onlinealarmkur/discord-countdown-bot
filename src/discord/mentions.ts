import type { MessageMentionOptions } from "discord.js";
import type { StoredCountdown } from "../types.js";

export function allowedMentions(countdown: StoredCountdown): MessageMentionOptions {
  const user = /^<@(\d+)>$/.exec(countdown.mention)?.[1];
  const role = /^<@&(\d+)>$/.exec(countdown.mention)?.[1];
  return {
    parse: [],
    repliedUser: false,
    ...(user ? { users: [user] } : {}),
    ...(role ? { roles: [role] } : {}),
  };
}
