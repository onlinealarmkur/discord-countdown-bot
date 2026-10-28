import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { Client, Guild, GuildMember } from "discord.js";

/** A fresh permission snapshot for one autocomplete request or one DM delivery. */
export function createCountdownVisibilityCheck(
  client: Client,
  guildId: string,
  userId: string,
): (channelId: string) => Promise<boolean> {
  let identity: Promise<{ guild: Guild; member: GuildMember }> | undefined;
  const checks = new Map<string, Promise<boolean>>();

  return (channelId) => {
    const existing = checks.get(channelId);
    if (existing) return existing;
    const check = (async () => {
      identity ??= (async () => {
        const guild = await client.guilds.fetch(guildId);
        // GuildMembers is not enabled. Cached roles/membership cannot authorize
        // a background delivery after the recipient loses channel access.
        const member = await guild.members.fetch({ user: userId, force: true, cache: false });
        return { guild, member };
      })();
      const { guild, member } = await identity;
      // ChannelManager returns an existing cached object unchanged with
      // cache:false. Keep caching enabled so fresh overwrites patch that object.
      const channel = await guild.channels.fetch(channelId, { force: true });
      if (!channel || channel.guildId !== guildId) return false;

      // Thread permissions are inherited from their parent; do not let the
      // ThreadChannel's cached parent bypass a changed channel overwrite.
      const permissionChannel = channel.isThread()
        ? channel.parentId && await guild.channels.fetch(channel.parentId, { force: true })
        : channel;
      if (!permissionChannel || permissionChannel.guildId !== guildId) return false;
      const permissions = permissionChannel.permissionsFor(member);
      if (!permissions?.has(PermissionFlagsBits.ViewChannel)) return false;
      if (channel.type !== ChannelType.PrivateThread || permissions.has(PermissionFlagsBits.ManageThreads)) return true;
      return Boolean(await channel.members.fetch({ member: userId, force: true, cache: false }));
    })().catch(() => false);
    // Failed lookups suppress this read only; they do not erase a subscription.
    checks.set(channelId, check);
    return check;
  };
}
