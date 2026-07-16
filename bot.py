"""Oceanbot — click a button, get a channel.

Members click emoji buttons on a role-menu message to opt in/out of
channels. Each button toggles a role, and each opt-in channel is only
visible to members holding its role.

Admin commands:
  /setup  — create the roles and private channels listed in config.json
  /post   — post (or refresh) the role-menu message
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

log = logging.getLogger("oceanbot")


def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


class RoleButton(
    discord.ui.DynamicItem[discord.ui.Button],
    template=r"oceanbot:role:(?P<role_id>[0-9]+)",
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
                custom_id=f"oceanbot:role:{role_id}",
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
                "That role no longer exists — ask an admin to re-run /setup and /post.",
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


client = Oceanbot()


def role_name_for(entry: dict) -> str:
    return entry.get("label") or entry["name"]


async def ensure_role(guild: discord.Guild, name: str) -> discord.Role:
    role = discord.utils.get(guild.roles, name=name)
    if role is None:
        role = await guild.create_role(name=name, reason="Oceanbot setup")
    return role


@client.tree.command(description="Create the opt-in roles and channels from config.json")
@app_commands.default_permissions(manage_guild=True)
@app_commands.guild_only()
async def setup(interaction: discord.Interaction) -> None:
    await interaction.response.defer(ephemeral=True)
    config = load_config()
    guild = interaction.guild

    category_name = config.get("category", "Opt-in Channels")
    category = discord.utils.get(guild.categories, name=category_name)
    if category is None:
        category = await guild.create_category(category_name, reason="Oceanbot setup")

    created, existing = [], []
    for entry in config["channels"]:
        role = await ensure_role(guild, role_name_for(entry))
        overwrites = {
            guild.default_role: discord.PermissionOverwrite(view_channel=False),
            role: discord.PermissionOverwrite(view_channel=True),
            guild.me: discord.PermissionOverwrite(view_channel=True),
        }
        channel = discord.utils.get(guild.text_channels, name=entry["name"])
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
            existing.append(entry["name"])

    menu_channel_name = config.get("menu_channel", "roles-for-channels")
    menu_channel = discord.utils.get(guild.text_channels, name=menu_channel_name)
    if menu_channel is None:
        await guild.create_text_channel(
            menu_channel_name,
            overwrites={
                guild.default_role: discord.PermissionOverwrite(
                    view_channel=True, send_messages=False, add_reactions=False
                ),
                guild.me: discord.PermissionOverwrite(view_channel=True, send_messages=True),
            },
            reason="Oceanbot setup",
        )
        created.append(menu_channel_name)

    summary = []
    if created:
        summary.append("Created: " + ", ".join(f"#{name}" for name in created))
    if existing:
        summary.append("Updated permissions on: " + ", ".join(f"#{name}" for name in existing))
    summary.append(f"Now run **/post** to put the role menu in #{menu_channel_name}.")
    await interaction.followup.send("\n".join(summary), ephemeral=True)


@client.tree.command(description="Post the role-menu message with the channel buttons")
@app_commands.default_permissions(manage_guild=True)
@app_commands.guild_only()
async def post(interaction: discord.Interaction) -> None:
    await interaction.response.defer(ephemeral=True)
    config = load_config()
    guild = interaction.guild

    menu_channel_name = config.get("menu_channel", "roles-for-channels")
    menu_channel = discord.utils.get(guild.text_channels, name=menu_channel_name)
    if menu_channel is None:
        await interaction.followup.send(
            f"I couldn't find #{menu_channel_name} — run /setup first.", ephemeral=True
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
    await menu_channel.send(embed=embed, view=view)
    await interaction.followup.send(f"Role menu posted in {menu_channel.mention}!", ephemeral=True)


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
