import { REST } from "discord.js";
import { loadRegistrationConfig } from "./config.js";
import { commandData } from "./discord/commands.js";
import { REGISTRATION_USAGE, clearGuildCommands, registerCommands, registrationMode } from "./discord/registration.js";

try {
  const mode = registrationMode(process.argv.slice(2));
  if (mode === "help") {
    console.log(REGISTRATION_USAGE);
  } else if (mode === "print") {
    console.log(JSON.stringify(commandData, null, 2));
  } else {
    const config = loadRegistrationConfig();
    const rest = new REST({ version: "10" }).setToken(config.token);
    console.log(mode === "clear-guild"
      ? await clearGuildCommands(rest, config)
      : await registerCommands(rest, config, mode === "global"));
  }
} catch (error) {
  // Configuration and registration errors name the problem, never a secret value.
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
