/**
 * Oceanbot: click a button, get a channel.
 *
 * Runs on Cloudflare Workers using Discord's HTTP interactions. Discord
 * POSTs every slash command and button click here; the Worker verifies
 * the request signature, replies, and does slower work (Discord REST
 * calls) after a deferred response via ctx.waitUntil.
 *
 * Commands (registered by register.js):
 *   /setup - create the roles and private channels listed in config.json
 *   /post  - post or refresh the role-menu message
 *   /ip    - show the Minecraft server info from config.json
 */

import { Buffer } from "node:buffer";

import config from "../config.json";

const API = "https://discord.com/api/v10";
const ROLE_BUTTON_PREFIX = "oceanbot:role:";
const SETUP_CONFIRM_ID = "oceanbot:setup:confirm";
const SETUP_CANCEL_ID = "oceanbot:setup:cancel";

// https://discord.com/developers/docs/interactions/receiving-and-responding
const InteractionType = { PING: 1, COMMAND: 2, COMPONENT: 3 };
const Reply = {
  PONG: 1,
  MESSAGE: 4,
  DEFERRED_MESSAGE: 5,
  DEFERRED_UPDATE: 6,
  UPDATE_MESSAGE: 7,
};
const EPHEMERAL = 64;

// Permission bitfields, as strings because Discord's API wants them quoted
const PERM = {
  VIEW: "1024", // VIEW_CHANNEL
  VIEW_AND_SEND: "3072", // VIEW_CHANNEL + SEND_MESSAGES
  SEND_AND_REACT: "2112", // SEND_MESSAGES + ADD_REACTIONS
};
const CHANNEL_TEXT = 0;
const CHANNEL_CATEGORY = 4;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Oceanbot is running.");
    }

    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const body = await request.text();
    const valid =
      signature &&
      timestamp &&
      (await verifySignature(env.DISCORD_PUBLIC_KEY, signature, timestamp, body));
    if (!valid) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(body);
    return handleInteraction(interaction, env, ctx);
  },
};

function handleInteraction(interaction, env, ctx) {
  if (interaction.type === InteractionType.PING) {
    return json({ type: Reply.PONG });
  }

  if (interaction.type === InteractionType.COMMAND) {
    switch (interaction.data.name) {
      case "ip": {
        const ip = config.ip ?? {};
        return json({
          type: Reply.MESSAGE,
          data: {
            embeds: [
              {
                title: ip.title ?? "⛏️ Minecraft Server",
                description: ip.description ?? "",
                color: 0x57f287,
              },
            ],
          },
        });
      }
      case "setup":
        return deferEphemeral(ctx, env, interaction, runSetup(env, interaction));
      case "post":
        return deferEphemeral(ctx, env, interaction, runPost(env, interaction));
      case "stats":
        return deferEphemeral(ctx, env, interaction, runStats(env, interaction));
    }
  }

  if (interaction.type === InteractionType.COMPONENT) {
    const customId = interaction.data.custom_id;
    if (customId.startsWith(ROLE_BUTTON_PREFIX)) {
      return deferEphemeral(ctx, env, interaction, toggleRole(env, interaction));
    }
    if (customId === SETUP_CONFIRM_ID) {
      ctx.waitUntil(reported(env, interaction, applyAndReport(env, interaction)));
      return json({ type: Reply.DEFERRED_UPDATE });
    }
    if (customId === SETUP_CANCEL_ID) {
      return json({
        type: Reply.UPDATE_MESSAGE,
        data: { content: "Cancelled, nothing was changed.", components: [] },
      });
    }
  }

  return json({
    type: Reply.MESSAGE,
    data: { content: "I don't know that interaction.", flags: EPHEMERAL },
  });
}

// Failures in deferred work must reach the user, not vanish inside waitUntil
function reported(env, interaction, work) {
  return work.catch((err) => reportError(env, interaction, err));
}

function deferEphemeral(ctx, env, interaction, work) {
  ctx.waitUntil(reported(env, interaction, work));
  return json({ type: Reply.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });
}

// ---------- button click: toggle the role ----------

async function toggleRole(env, interaction) {
  try {
    const roleId = interaction.data.custom_id.slice(ROLE_BUTTON_PREFIX.length);
    const guildId = interaction.guild_id;
    const userId = interaction.member.user.id;

    const roles = await api(env, "GET", `/guilds/${guildId}/roles`);
    const role = roles.find((r) => r.id === roleId);
    if (!role) {
      await editOriginal(env, interaction, {
        content: "That role no longer exists. Ask an admin to re-run /setup and /post.",
      });
      return;
    }

    let content;
    if (interaction.member.roles.includes(roleId)) {
      await api(env, "DELETE", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
      content = `👋 You left **${role.name}**.`;
    } else {
      await api(env, "PUT", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
      content = `🌊 You joined **${role.name}**! Check your channel list.`;
    }
    await editOriginal(env, interaction, { content });
  } catch (err) {
    if (err.status !== 403) throw err;
    await editOriginal(env, interaction, {
      content:
        "I don't have permission to manage that role. An admin should move my role " +
        "above the opt-in roles in Server Settings → Roles.",
    });
  }
}

// ---------- /setup ----------

async function runSetup(env, interaction) {
  const channels = await api(env, "GET", `/guilds/${interaction.guild_id}/channels`);
  const existing = roleEntries()
    .flatMap((entry) => entry.channels ?? [])
    .map((ref) => resolveChannel(channels, ref))
    .filter(Boolean);

  if (existing.length > 0) {
    await editOriginal(env, interaction, {
      content:
        "⚠️ These channels already exist and /setup will **rewrite their permissions** " +
        "so only members with the matching role can see them:\n" +
        [...new Set(existing.map((c) => c.id))].map((id) => `- <#${id}>`).join("\n") +
        "\n\nEverything else in config.json will just be created. Apply?",
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 4, label: "Apply changes", custom_id: SETUP_CONFIRM_ID },
            { type: 2, style: 2, label: "Cancel", custom_id: SETUP_CANCEL_ID },
          ],
        },
      ],
    });
    return;
  }

  await applyAndReport(env, interaction, channels);
}

async function applyAndReport(env, interaction, channels) {
  const summary = await applySetup(env, interaction.guild_id, channels);
  await editOriginal(env, interaction, { content: summary, components: [] });
}

async function applySetup(env, guildId, channels) {
  // The confirm button arrives as a later request, so it re-fetches
  channels = channels ?? (await api(env, "GET", `/guilds/${guildId}/channels`));
  const roles = await api(env, "GET", `/guilds/${guildId}/roles`);

  const categoryName = config.category ?? "Opt-in Channels";
  let category = channels.find((c) => c.type === CHANNEL_CATEGORY && c.name === categoryName);
  if (!category) {
    category = await api(env, "POST", `/guilds/${guildId}/channels`, {
      name: categoryName,
      type: CHANNEL_CATEGORY,
    });
  }

  const created = [];
  const updated = [];
  const newRoles = [];
  const missing = [];
  for (const entry of roleEntries()) {
    const before = roles.length;
    const role = await ensureRole(env, guildId, roles, entry.role);
    if (roles.length > before) {
      newRoles.push(entry.role);
    }
    const overwrites = [
      { id: guildId, type: 0, deny: PERM.VIEW }, // @everyone (its role id is the guild id)
      { id: role.id, type: 0, allow: PERM.VIEW },
      { id: env.DISCORD_APPLICATION_ID, type: 1, allow: PERM.VIEW },
    ];
    for (const ref of entry.channels ?? []) {
      const channel = resolveChannel(channels, ref);
      if (channel) {
        await api(env, "PATCH", `/channels/${channel.id}`, {
          permission_overwrites: overwrites,
        });
        updated.push(channel.id);
      } else if (SNOWFLAKE.test(ref)) {
        // An id references an existing channel; never create one from it
        missing.push(ref);
      } else {
        const newChannel = await api(env, "POST", `/guilds/${guildId}/channels`, {
          name: ref,
          type: CHANNEL_TEXT,
          parent_id: category.id,
          permission_overwrites: overwrites,
        });
        created.push(newChannel.id);
      }
    }
  }

  let menuChannel = resolveChannel(channels, menuChannelName());
  if (!menuChannel) {
    menuChannel = await api(env, "POST", `/guilds/${guildId}/channels`, {
      name: menuChannelName(),
      type: CHANNEL_TEXT,
      permission_overwrites: [
        { id: guildId, type: 0, deny: PERM.SEND_AND_REACT },
        { id: env.DISCORD_APPLICATION_ID, type: 1, allow: PERM.VIEW_AND_SEND },
      ],
    });
    created.push(menuChannel.id);
  }

  const summary = [];
  if (newRoles.length) {
    summary.push("Created roles: " + newRoles.map((n) => `**${n}**`).join(", "));
  }
  if (created.length) {
    summary.push("Created: " + created.map((id) => `<#${id}>`).join(", "));
  }
  if (updated.length) {
    summary.push("Updated permissions on: " + updated.map((id) => `<#${id}>`).join(", "));
  }
  if (missing.length) {
    summary.push(
      "⚠️ Couldn't find channels for these ids (check them in config.json): " +
        missing.join(", "),
    );
  }
  if (!summary.length) {
    summary.push("Everything already exists, nothing to do.");
  }
  summary.push(`Now run **/post** to put the role menu in <#${menuChannel.id}>.`);
  return summary.join("\n");
}

// ---------- /post ----------

async function runPost(env, interaction) {
  const guildId = interaction.guild_id;
  const channels = await api(env, "GET", `/guilds/${guildId}/channels`);
  const chosenId = interaction.data.options?.find((o) => o.name === "channel")?.value;
  const menuChannel = chosenId
    ? channels.find((c) => c.id === chosenId)
    : resolveChannel(channels, menuChannelName());
  if (!menuChannel) {
    await editOriginal(env, interaction, {
      content: `I couldn't find #${menuChannelName()}. Run /setup first.`,
    });
    return;
  }

  const roles = await api(env, "GET", `/guilds/${guildId}/roles`);
  const buttons = [];
  const lines = [];
  for (const section of config.sections) {
    lines.push("", `**${section.title}:**`);
    for (const entry of section.roles) {
      const role = await ensureRole(env, guildId, roles, entry.role);
      // Discord allows at most 25 buttons per message (5 rows of 5)
      if (buttons.length < 25) {
        buttons.push({
          type: 2,
          style: 2,
          label: entry.role,
          emoji: parseEmoji(entry.emoji),
          custom_id: `${ROLE_BUTTON_PREFIX}${role.id}`,
        });
      }
      const dash = entry.description ? ` - ${entry.description}` : "";
      lines.push(`${entry.emoji ?? "•"} <@&${role.id}>${dash}`);
    }
  }

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  }
  const embed = {
    title: config.menu_title ?? "🌊 Pick your roles",
    description: `${config.menu_description ?? ""}\n${lines.join("\n")}`,
    color: 0x3498db,
  };

  const messages = await api(env, "GET", `/channels/${menuChannel.id}/messages?limit=50`);
  const existingMenu = messages.find(
    (m) => m.author.id === env.DISCORD_APPLICATION_ID && isRoleMenu(m),
  );

  const [method, path, verb] = existingMenu
    ? ["PATCH", `/channels/${menuChannel.id}/messages/${existingMenu.id}`, "Updated the role menu in"]
    : ["POST", `/channels/${menuChannel.id}/messages`, "Role menu posted in"];
  await api(env, method, path, { embeds: [embed], components: rows });
  await editOriginal(env, interaction, { content: `${verb} <#${menuChannel.id}>.` });
}

// ---------- /stats ----------

async function runStats(env, interaction) {
  const guildId = interaction.guild_id;
  const roles = await api(env, "GET", `/guilds/${guildId}/roles`);

  // Count each role across all members (paginated, 1000 per page)
  const counts = new Map();
  let after = "0";
  let total = 0;
  while (true) {
    let page;
    try {
      page = await api(env, "GET", `/guilds/${guildId}/members?limit=1000&after=${after}`);
    } catch (err) {
      if (err.status === 403) {
        await editOriginal(env, interaction, {
          content:
            "I'm not allowed to list members yet. In the Developer Portal, open the " +
            "app's **Bot** tab and turn on **Server Members Intent**, then try again.",
        });
        return;
      }
      throw err;
    }
    total += page.length;
    for (const member of page) {
      for (const roleId of member.roles) {
        counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
      }
    }
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }

  const lines = [];
  for (const section of config.sections) {
    lines.push("", `**${section.title}:**`);
    for (const entry of section.roles) {
      const role = roles.find((r) => r.name === entry.role);
      const count = role ? (counts.get(role.id) ?? 0) : 0;
      lines.push(`${entry.emoji ?? "•"} ${role ? `<@&${role.id}>` : `**${entry.role}**`}: ${count}`);
    }
  }

  await editOriginal(env, interaction, {
    embeds: [
      {
        title: "📊 Role picks",
        description: `Out of **${total}** members:\n${lines.join("\n")}`,
        color: 0x3498db,
      },
    ],
  });
}

// The role menu is the only bot message carrying oceanbot role buttons
function isRoleMenu(message) {
  return (message.components ?? []).some((row) =>
    (row.components ?? []).some((c) => (c.custom_id ?? "").startsWith(ROLE_BUTTON_PREFIX)),
  );
}

// ---------- shared helpers ----------

function json(payload) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

function menuChannelName() {
  return config.menu_channel ?? "roles-for-channels";
}

function roleEntries() {
  return config.sections.flatMap((section) => section.roles);
}

// Accepts a unicode emoji ("🎮") or a custom server emoji ("<:popcat:123456>")
function parseEmoji(emoji) {
  if (!emoji) return undefined;
  const custom = emoji.match(/^<(a?):(\w+):([0-9]+)>$/);
  if (custom) {
    return { name: custom[2], id: custom[3], animated: custom[1] === "a" };
  }
  return { name: emoji };
}

const SNOWFLAKE = /^[0-9]{17,20}$/;

// A channel reference in config.json is either a name ("fortnite") or an id.
// Ids match any channel type (text, voice, category); names match text only.
function resolveChannel(channels, ref) {
  if (SNOWFLAKE.test(ref)) {
    return channels.find((c) => c.id === ref);
  }
  return channels.find((c) => c.type === CHANNEL_TEXT && c.name === ref);
}

async function ensureRole(env, guildId, roles, name) {
  let role = roles.find((r) => r.name === name);
  if (!role) {
    role = await api(env, "POST", `/guilds/${guildId}/roles`, { name });
    roles.push(role);
  }
  return role;
}

class DiscordApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(env, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${env.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429 && attempt < 2) {
      const data = await response.json().catch(() => ({}));
      const waitMs = Math.min((data.retry_after ?? 1) * 1000, 10_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!response.ok) {
      throw new DiscordApiError(
        response.status,
        `${method} ${path} failed: ${response.status} ${await response.text()}`,
      );
    }
    return response.status === 204 ? null : response.json();
  }
}

// Edit the deferred ephemeral reply (or the message the button lives on)
async function editOriginal(env, interaction, payload) {
  const response = await fetch(
    `${API}/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    console.error("editOriginal failed", response.status, await response.text());
  }
}

async function reportError(env, interaction, err) {
  console.error("interaction failed", err);
  await editOriginal(env, interaction, {
    content: "Something went wrong running that command. Check the Worker's logs.",
    components: [],
  });
}

// The public key never changes, so import it once per isolate, not per request
const encoder = new TextEncoder();
let cachedKey;
let cachedKeyHex;

async function verifySignature(publicKey, signature, timestamp, body) {
  try {
    if (cachedKeyHex !== publicKey) {
      cachedKey = await crypto.subtle.importKey(
        "raw",
        Buffer.from(publicKey, "hex"),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      cachedKeyHex = publicKey;
    }
    return await crypto.subtle.verify(
      "Ed25519",
      cachedKey,
      Buffer.from(signature, "hex"),
      encoder.encode(timestamp + body),
    );
  } catch {
    return false;
  }
}
