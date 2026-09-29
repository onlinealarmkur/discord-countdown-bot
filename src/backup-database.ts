import "dotenv/config";
import { backupDatabase } from "./backup.js";

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error("Usage: node dist/src/backup-database.js [destination-directory]");
  process.exitCode = 1;
} else {
  try {
    const { destination, bytes } = await backupDatabase(process.env.DATABASE_PATH?.trim() || "./data/countdowns.db", args[0]);
    console.log(`Backed up ${Math.ceil(bytes / 1024)} KiB to ${destination}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
