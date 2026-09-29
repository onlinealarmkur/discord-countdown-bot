import "dotenv/config";
import { existsSync } from "node:fs";
import { CountdownDatabase } from "./database.js";

// Privacy requests:
//   npm run data:delete-user -- <discord-user-id> [--dry-run]
//   npm run data:delete-user -- --guild <discord-server-id> [--dry-run]
const usage = "Usage: npm run data:delete-user -- <discord-user-id> [--dry-run]\n" +
  "       npm run data:delete-user -- --guild <discord-server-id> [--dry-run]";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rest = args.filter((arg) => arg !== "--dry-run");
const byGuild = rest[0] === "--guild";
const id = byGuild ? rest[1] : rest[0];
const databasePath = process.env.DATABASE_PATH?.trim() || "./data/countdowns.db";
if (!id || !/^[1-9]\d{0,19}$/.test(id) || rest.length !== (byGuild ? 2 : 1) || args.length - rest.length > 1) {
  console.error(usage);
  process.exitCode = 1;
} else if (!existsSync(databasePath)) {
  console.error("DATABASE_PATH does not exist. Point it at the production database.");
  process.exitCode = 1;
} else {
  const database = new CountdownDatabase(databasePath);
  try {
    if (byGuild) {
      const countdowns = dryRun ? database.countGuildCountdowns(id) : database.deleteGuildData(id);
      console.log(`${dryRun ? "Would delete" : "Deleted"} ${countdowns} countdowns, with their milestones, subscriptions, and delivery records, for that server.`);
    } else {
      const { countdowns, subscriptions, pickers } = database.deleteUserData(id, dryRun);
      console.log(`${dryRun ? "Would delete" : "Deleted"} ${countdowns} created countdowns, ${subscriptions} reminder subscriptions, and ${pickers} open quick-button menus for that user.`);
    }
  } finally {
    database.close();
  }
}
