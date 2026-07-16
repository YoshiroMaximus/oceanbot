/**
 * Registers Oceanbot's slash commands with Discord. Run once after
 * deploying (and again whenever the commands themselves change):
 *
 *   npm run register
 *
 * Reads DISCORD_TOKEN, DISCORD_APPLICATION_ID, and optional GUILD_ID
 * from .env. With GUILD_ID the commands appear in that server
 * instantly; without it they register globally (takes up to an hour).
 */

const MANAGE_GUILD = "32";
const GUILD_ONLY = [0];

const commands = [
  {
    name: "setup",
    description: "Create the opt-in roles and channels from config.json",
    default_member_permissions: MANAGE_GUILD,
    contexts: GUILD_ONLY,
  },
  {
    name: "post",
    description: "Post or refresh the role-menu message",
    default_member_permissions: MANAGE_GUILD,
    contexts: GUILD_ONLY,
  },
  {
    name: "ip",
    description: "Get the Minecraft server IP",
    contexts: GUILD_ONLY,
  },
];

const { DISCORD_TOKEN, DISCORD_APPLICATION_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID) {
  console.error("Set DISCORD_TOKEN and DISCORD_APPLICATION_ID in .env first.");
  process.exit(1);
}

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`;

const response = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${DISCORD_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  console.error(`Failed (${response.status}):`, await response.text());
  process.exit(1);
}
const registered = await response.json();
console.log(
  `Registered ${registered.length} commands${GUILD_ID ? ` in guild ${GUILD_ID}` : " globally"}:`,
  registered.map((c) => `/${c.name}`).join(", "),
);
