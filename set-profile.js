/**
 * Sets the bot's About Me text (shown when someone clicks its profile).
 * Run whenever you want to change it:
 *
 *   npm run profile
 *
 * Reads DISCORD_TOKEN from .env.
 */

const ABOUT_ME = [
  "⛏️ I'm playing on **mc.sn4k.org**!",
  "Latest Paper MC, every version supported.",
  "",
  "Use /ip for the address, and grab your channels in #roles-for-channels.",
].join("\n");

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  console.error("Set DISCORD_TOKEN in .env first.");
  process.exit(1);
}

const response = await fetch("https://discord.com/api/v10/applications/@me", {
  method: "PATCH",
  headers: {
    Authorization: `Bot ${DISCORD_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ description: ABOUT_ME }),
});

if (!response.ok) {
  console.error(`Failed (${response.status}):`, await response.text());
  process.exit(1);
}
console.log("Bot About Me updated:");
console.log(ABOUT_ME);
