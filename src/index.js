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
  const existing = config.channels
    .map((entry) => entry.name)
    .filter((name) => findTextChannel(channels, name));

  if (existing.length > 0) {
    await editOriginal(env, interaction, {
      content:
        "⚠️ These channels already exist and /setup will **rewrite their permissions** " +
        "so only members with the matching role can see them:\n" +
        existing.map((name) => `- #${name}`).join("\n") +
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
  for (const entry of config.channels) {
    const role = await ensureRole(env, guildId, roles, roleNameFor(entry));
    const overwrites = [
      { id: guildId, type: 0, deny: PERM.VIEW }, // @everyone (its role id is the guild id)
      { id: role.id, type: 0, allow: PERM.VIEW },
      { id: env.DISCORD_APPLICATION_ID, type: 1, allow: PERM.VIEW },
    ];
    const channel = findTextChannel(channels, entry.name);
    if (!channel) {
      await api(env, "POST", `/guilds/${guildId}/channels`, {
        name: entry.name,
        type: CHANNEL_TEXT,
        parent_id: category.id,
        permission_overwrites: overwrites,
      });
      created.push(entry.name);
    } else {
      await api(env, "PATCH", `/channels/${channel.id}`, {
        permission_overwrites: overwrites,
      });
      updated.push(entry.name);
    }
  }

  const menuName = menuChannelName();
  if (!findTextChannel(channels, menuName)) {
    await api(env, "POST", `/guilds/${guildId}/channels`, {
      name: menuName,
      type: CHANNEL_TEXT,
      permission_overwrites: [
        { id: guildId, type: 0, deny: PERM.SEND_AND_REACT },
        { id: env.DISCORD_APPLICATION_ID, type: 1, allow: PERM.VIEW_AND_SEND },
      ],
    });
    created.push(menuName);
  }

  const summary = [];
  if (created.length) {
    summary.push("Created: " + created.map((n) => `#${n}`).join(", "));
  }
  if (updated.length) {
    summary.push("Updated permissions on: " + updated.map((n) => `#${n}`).join(", "));
  }
  if (!summary.length) {
    summary.push("Everything already exists, nothing to do.");
  }
  summary.push(`Now run **/post** to put the role menu in #${menuName}.`);
  return summary.join("\n");
}

// ---------- /post ----------

async function runPost(env, interaction) {
  const guildId = interaction.guild_id;
  const channels = await api(env, "GET", `/guilds/${guildId}/channels`);
  const menuChannel = findTextChannel(channels, menuChannelName());
  if (!menuChannel) {
    await editOriginal(env, interaction, {
      content: `I couldn't find #${menuChannelName()}. Run /setup first.`,
    });
    return;
  }

  const roles = await api(env, "GET", `/guilds/${guildId}/roles`);
  const buttons = [];
  const lines = [];
  // Discord allows at most 25 buttons per message (5 rows of 5)
  for (const entry of config.channels.slice(0, 25)) {
    const role = await ensureRole(env, guildId, roles, roleNameFor(entry));
    buttons.push({
      type: 2,
      style: 2,
      label: entry.label,
      emoji: entry.emoji ? { name: entry.emoji } : undefined,
      custom_id: `${ROLE_BUTTON_PREFIX}${role.id}`,
    });
    lines.push(`${entry.emoji ?? "•"} **${roleNameFor(entry)}** → #${entry.name}`);
  }

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  }
  const embed = {
    title: config.menu_title ?? "🌊 Pick your channels",
    description: `${config.menu_description ?? ""}\n\n${lines.join("\n")}`,
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

function roleNameFor(entry) {
  return entry.label ?? entry.name;
}

function findTextChannel(channels, name) {
  return channels.find((c) => c.type === CHANNEL_TEXT && c.name === name);
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
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new DiscordApiError(
      response.status,
      `${method} ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.status === 204 ? null : response.json();
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
