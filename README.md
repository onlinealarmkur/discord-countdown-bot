# Countdown Bot

Countdowns and reminders for your Discord server.

![Countdown Bot icon](assets/countdown-bot-icon.png)

## Features

- Start a countdown with a duration or an exact date and timezone.
- Use shared cards with pause, resume, add-one-minute, and cancel controls. Scheduled events keep their fixed deadline.
- Subscribe to direct reminders and choose custom milestones.
- Add an optional Beep, Bell, or Urgent chime in a voice channel.
- Restore countdowns after restarts using SQLite.
- Open the same deadline as an [online countdown](https://onlinealarmkur.com/countdown/en/).

## Commands

| Command | Example |
| --- | --- |
| `/countdown` | Opens the alert picker and quick duration choices |
| `/countdown when:5 minutes label:Break` | Starts a five-minute countdown |
| `/countdown when:1h30m label:Game night` | Starts a countdown from a compact duration |
| `/countdown when:2027-01-01 00:00 timezone:Europe/Madrid label:New Year` | Counts down to a scheduled event |
| `/countdowns` | Lists active countdowns |
| `/countdown-manage` | Manages countdowns when the original card is unavailable |
| `/countdown-help` | Shows help and examples |

Durations range from five seconds to 365 days. Exact dates use `YYYY-MM-DD HH:mm` or `YYYY-MM-DDTHH:mm` and can be up to five calendar years away. Dates require a time. The timezone defaults to `DEFAULT_TIMEZONE` (UTC); ambiguous or nonexistent daylight-saving times are rejected.

Text notifications are the default. Optional voice chimes use the creator's voice channel at creation. Milestones are automatic, or set `remind_before:7d,1d,1h,10m` for custom reminders. Members can select **Remind me** for direct notifications.

## Setup

Use Node.js 24.21.0 or later. With nvm installed, run `nvm install` and `nvm use` to select the version in [.nvmrc](.nvmrc).

1. Create your own application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable Guild Install with the `bot` and `applications.commands` scopes. Request View Channels, Send Messages, Send Messages in Threads, Embed Links, and Read Message History. Add Connect and Speak for voice alerts.
3. Keep privileged intents and Require OAuth2 Code Grant off, and leave the Interactions Endpoint URL unset. This bot connects through Discord's Gateway.
4. Invite the application to your test server.

Install dependencies and create the local configuration:

```bash
npm ci --ignore-scripts
test -f .env || install -m 600 .env.example .env
```

Edit `.env`: set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` (Application ID), and `DISCORD_GUILD_ID` (test server ID). Enable Developer Mode in Discord to copy the server ID. Keep the token private.

```bash
npm run doctor
npm run commands:register
npm start
```

Wait for the ready message, then try `/countdown when:10s` in the test server. Keep one bot process running against the database. Use `npm run dev` instead of `npm start` for development.

[.env.example](.env.example) documents the timezone, persistent database path, public links, active-countdown limits, and per-member creation limits. Set capacity limits for your own host and workload; they are not delivery guarantees.

## Operations

After testing, clear `DISCORD_GUILD_ID` and run `npm run commands:register -- --global` to register commands globally. To remove duplicate test-server commands afterward, temporarily supply that server ID and run `npm run commands:register -- --clear-guild`.

| Command | Purpose |
| --- | --- |
| `npm run verify` | Typecheck, automated tests, build, and offline diagnostics |
| `npm run commands:print` | Print command definitions without contacting Discord |
| `npm run db:backup` | Create an integrity-checked SQLite backup |
| `npm run data:delete-user -- <user-id> --dry-run` | Preview deletion of a user's stored data |
| `npm run capacity:benchmark` | Measure local scheduler and database capacity |

Remove `--dry-run` to apply a data deletion; use `--guild <server-id>` instead of the user ID for a server. Stop the bot while applying deletions, then restart it. Database backups can run while the bot is running.

Automated verification needs no Discord credentials. Confirm command responses, completion messages, direct reminders, and voice playback separately in your test server.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Use your own application and test server.

## License

This Discord bot's source code and accompanying documentation are licensed under the [MIT License](LICENSE). Created by [Online Alarm Kur](https://onlinealarmkur.com/en/), which offers an online alarm clock, timer, stopwatch, and more.

The separate onlinealarmkur.com website, including its code and content, remains proprietary and is not covered by this license. Images in `assets/`, logos, icons, and other brand assets are excluded from the MIT License; rights remain with their respective owners. No trademark rights are granted.
