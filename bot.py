"""Oceanbot: click a button, get a channel.

Members click emoji buttons on a role-menu message to opt in/out of
channels. Each button toggles a role, and each opt-in channel is only
visible to members holding its role.

Admin commands:
  /setup  - create the roles and private channels listed in config.json
  /post   - post or refresh the role-menu message
"""

import json
import logging
import os
import re
from pathlib import Path

import discord
from discord import app_commands
from dotenv import load_dotenv

load_dotenv()

CONFIG_PATH = Path(__file__).parent / "config.json"
ROLE_BUTTON_PREFIX = "oceanbot:role:"

log = logging.getLogger("oceanbot")


def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def menu_channel_name(config: dict) -> str:
    return config.get("menu_channel", "roles-for-channels")


def existing_config_channels(guild: discord.Guild, config: dict) -> dict[str, discord.TextChannel]:
    """Map config channel names to the guild channels that already exist."""
    by_name = {channel.name: channel for channel in guild.text_channels}
    return {
        entry["name"]: by_name[entry["name"]]
        for entry in config["channels"]
        if entry["name"] in by_name
    }


class RoleButton(
    discord.ui.DynamicItem[discord.ui.Button],
    template=ROLE_BUTTON_PREFIX + r"(?P<role_id>[0-9]+)",
):
    """A button whose custom_id embeds the role it toggles.

    Because the role id lives in the custom_id, clicks keep working
    after restarts with no database.
    """

    def __init__(self, role_id: int, *, emoji: str | None = None, label: str | None = None):
        super().__init__(
            discord.ui.Button(
                style=discord.ButtonStyle.secondary,
                emoji=emoji,
                label=label,
                custom_id=f"{ROLE_BUTTON_PREFIX}{role_id}",
            )
        )
        self.role_id = role_id

    @classmethod
    async def from_custom_id(
        cls,
        interaction: discord.Interaction,
        item: discord.ui.Button,
        match: re.Match[str],
    ):
        return cls(int(match["role_id"]))

    async def callback(self, interaction: discord.Interaction) -> None:
        role = interaction.guild.get_role(self.role_id)
        if role is None:
            await interaction.response.send_message(
                "That role no longer exists. Ask an admin to re-run /setup and /post.",
                ephemeral=True,
            )
            return

        member = interaction.user
        try:
            if role in member.roles:
                await member.remove_roles(role, reason="Oceanbot role menu")
                message = f"👋 You left **{role.name}**."
            else:
                await member.add_roles(role, reason="Oceanbot role menu")
                message = f"🌊 You joined **{role.name}**! Check your channel list."
        except discord.Forbidden:
            message = (
                "I don't have permission to manage that role. "
                "An admin should move my role above the opt-in roles in Server Settings → Roles."
            )
        await interaction.response.send_message(message, ephemeral=True)


class Oceanbot(discord.Client):
    def __init__(self):
        super().__init__(intents=discord.Intents.default())
        self.tree = app_commands.CommandTree(self)
        self.tree.on_error = self.on_command_error

    async def setup_hook(self) -> None:
        self.add_dynamic_items(RoleButton)
        guild_id = os.getenv("GUILD_ID")
        if guild_id:
            guild = discord.Object(id=int(guild_id))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()

    async def on_ready(self) -> None:
        log.info("Logged in as %s (id %s)", self.user, self.user.id)

    async def on_command_error(
        self, interaction: discord.Interaction, error: app_commands.AppCommandError
    ) -> None:
        command = interaction.command.name if interaction.command else "unknown"
        log.exception("Command /%s failed", command, exc_info=error)
        message = "Something went wrong running that command. Check the bot's logs."
        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)


client = Oceanbot()


def role_name_for(entry: dict) -> str:
    return entry.get("label") or entry["name"]


async def ensure_role(guild: discord.Guild, name: str) -> discord.Role:
    role = discord.utils.get(guild.roles, name=name)
    if role is None:
        role = await guild.create_role(name=name, reason="Oceanbot setup")
    return role


async def apply_setup(guild: discord.Guild, config: dict) -> str:
    """Create/update the opt-in roles and channels. Returns a summary."""
    category_name = config.get("category", "Opt-in Channels")
    category = discord.utils.get(guild.categories, name=category_name)
    if category is None:
        category = await guild.create_category(category_name, reason="Oceanbot setup")

    existing = existing_config_channels(guild, config)
    created, updated = [], []
    for entry in config["channels"]:
        role = await ensure_role(guild, role_name_for(entry))
        overwrites = {
            guild.default_role: discord.PermissionOverwrite(view_channel=False),
            role: discord.PermissionOverwrite(view_channel=True),
            guild.me: discord.PermissionOverwrite(view_channel=True),
        }
        channel = existing.get(entry["name"])
        if channel is None:
            await guild.create_text_channel(
                entry["name"],
                category=category,
                overwrites=overwrites,
                reason="Oceanbot setup",
            )
            created.append(entry["name"])
        else:
            await channel.edit(overwrites=overwrites)
            updated.append(entry["name"])

    menu_name = menu_channel_name(config)
    if discord.utils.get(guild.text_channels, name=menu_name) is None:
        await guild.create_text_channel(
            menu_name,
            overwrites={
                guild.default_role: discord.PermissionOverwrite(
                    view_channel=True, send_messages=False, add_reactions=False
                ),
                guild.me: discord.PermissionOverwrite(view_channel=True, send_messages=True),
            },
            reason="Oceanbot setup",
        )
        created.append(menu_name)

    summary = []
    if created:
        summary.append("Created: " + ", ".join(f"#{name}" for name in created))
    if updated:
        summary.append("Updated permissions on: " + ", ".join(f"#{name}" for name in updated))
    if not summary:
        summary.append("Everything already exists, nothing to do.")
    summary.append(f"Now run **/post** to put the role menu in #{menu_name}.")
    return "\n".join(summary)


class ConfirmSetupView(discord.ui.View):
    """Asks for confirmation before /setup touches existing channels."""

    def __init__(self, config: dict):
        super().__init__(timeout=120)
        self.config = config

    @discord.ui.button(label="Apply changes", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        self.stop()
        await interaction.response.defer()
        summary = await apply_setup(interaction.guild, self.config)
        await interaction.edit_original_response(content=summary, view=None)

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        self.stop()
        await interaction.response.edit_message(
            content="Cancelled, nothing was changed.", view=None
        )


@client.tree.command(description="Create the opt-in roles and channels from config.json")
@app_commands.default_permissions(manage_guild=True)
@app_commands.guild_only()
async def setup(interaction: discord.Interaction) -> None:
    await interaction.response.defer(ephemeral=True)
    config = load_config()
    guild = interaction.guild

    existing = existing_config_channels(guild, config)
    if existing:
        warning = (
            "⚠️ These channels already exist and /setup will **rewrite their permissions** "
            "so only members with the matching role can see them:\n"
            + "\n".join(f"- #{name}" for name in existing)
            + "\n\nEverything else in config.json will just be created. Apply?"
        )
        await interaction.followup.send(warning, view=ConfirmSetupView(config), ephemeral=True)
        return

    summary = await apply_setup(guild, config)
    await interaction.followup.send(summary, ephemeral=True)


@client.tree.command(description="Get the Minecraft server IP")
async def ip(interaction: discord.Interaction) -> None:
    ip_config = load_config().get("ip", {})
    embed = discord.Embed(
        title=ip_config.get("title", "⛏️ Minecraft Server"),
        description=ip_config.get("description", ""),
        color=discord.Color.green(),
    )
    await interaction.response.send_message(embed=embed)


def is_role_menu(message: discord.Message) -> bool:
    """The role menu is the only bot message carrying oceanbot role buttons."""
    return any(
        (getattr(child, "custom_id", None) or "").startswith(ROLE_BUTTON_PREFIX)
        for row in message.components
        for child in getattr(row, "children", [])
    )


async def find_menu_message(
    channel: discord.TextChannel, bot_id: int
) -> discord.Message | None:
    async for message in channel.history(limit=50):
        if message.author.id == bot_id and is_role_menu(message):
            return message
    return None


@client.tree.command(description="Post or refresh the role-menu message")
@app_commands.default_permissions(manage_guild=True)
@app_commands.guild_only()
async def post(interaction: discord.Interaction) -> None:
    await interaction.response.defer(ephemeral=True)
    config = load_config()
    guild = interaction.guild

    menu_name = menu_channel_name(config)
    menu_channel = discord.utils.get(guild.text_channels, name=menu_name)
    if menu_channel is None:
        await interaction.followup.send(
            f"I couldn't find #{menu_name}. Run /setup first.", ephemeral=True
        )
        return

    view = discord.ui.View(timeout=None)
    lines = []
    for entry in config["channels"][:25]:  # Discord allows at most 25 buttons per message
        role = await ensure_role(guild, role_name_for(entry))
        view.add_item(RoleButton(role.id, emoji=entry.get("emoji"), label=entry.get("label")))
        lines.append(f"{entry.get('emoji', '•')} **{role_name_for(entry)}** → #{entry['name']}")

    embed = discord.Embed(
        title=config.get("menu_title", "🌊 Pick your channels"),
        description=config.get("menu_description", "") + "\n\n" + "\n".join(lines),
        color=discord.Color.blue(),
    )

    existing_menu = await find_menu_message(menu_channel, guild.me.id)
    if existing_menu is not None:
        await existing_menu.edit(embed=embed, view=view)
        verb = "Updated the role menu in"
    else:
        await menu_channel.send(embed=embed, view=view)
        verb = "Role menu posted in"
    await interaction.followup.send(f"{verb} {menu_channel.mention}.", ephemeral=True)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    token = os.getenv("DISCORD_TOKEN")
    if not token:
        raise SystemExit(
            "DISCORD_TOKEN is not set. Copy .env.example to .env and paste your bot token in."
        )
    client.run(token)


if __name__ == "__main__":
    main()
