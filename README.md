# 🌊 Oceanbot

[![Built with JavaScript](https://cdn.jsdelivr.net/npm/@intergrav/devins-badges@3/assets/compact/built-with/javascript_vector.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Available on GitHub](https://cdn.jsdelivr.net/npm/@intergrav/devins-badges@3/assets/compact/available/github_vector.svg)](https://github.com/YoshiroMaximus/oceanbot)
![Join our Discord](https://cdn.jsdelivr.net/npm/@intergrav/devins-badges@3/assets/compact/social/discord-plural_vector.svg)

A Discord bot for opt-in channels. It posts a menu of emoji buttons in a
`#roles-for-channels` channel; clicking a button toggles a role that shows
or hides the matching channel.

Runs serverless on Cloudflare Workers (free tier is plenty): Discord sends
every command and button click to the Worker as an HTTP request, so there
is no server to keep online and nothing to restart.

## Commands

| Command  | Who      | What it does                                                          |
| -------- | -------- | --------------------------------------------------------------------- |
| `/setup` | Admins   | Creates the roles, private channels, and menu channel from `config.json`. Asks before touching existing channels. |
| `/post`  | Admins   | Posts the button menu, or updates it in place if it already exists.   |
| `/stats` | Everyone | Shows how many members picked each role. Needs **Server Members Intent** turned on (app's Bot tab in the Developer Portal). |
| `/ip`    | Everyone | Replies with the Minecraft server info from `config.json`.            |

## Setup

### 1. Create the bot on Discord

1. In the [Developer Portal](https://discord.com/developers/applications), click **New Application** and name it `oceanbot`.
2. On **General Information**, copy the **Application ID** and **Public Key**.
3. On the **Bot** tab, click **Reset Token** and copy the token.
4. **OAuth2 → URL Generator**: check the scopes `bot` + `applications.commands` and the permissions `Manage Roles`, `Manage Channels`, `Send Messages`, `Embed Links`, `Read Message History`. Open the generated link to invite the bot.
5. In **Server Settings → Roles**, drag the bot's role above the opt-in roles it will manage (near the top is easiest).

### 2. Configure

Everything user-facing lives in `config.json`. The menu is organized into
sections, and each entry is a role that members can give themselves:

```json
{
  "menu_channel": "roles-for-channels",
  "category": "Opt-in Channels",
  "menu_title": "🌊 Pick your roles",
  "menu_description": "Click a button below to add or remove a role.",
  "ip": {
    "title": "⛏️ Minecraft Server",
    "description": "**`mc.sn4k.org`**"
  },
  "sections": [
    {
      "title": "Channel",
      "roles": [
        {
          "role": "Fortnite",
          "emoji": "🔫",
          "channels": ["fortnite"],
          "description": "If you want access to fortnite channels"
        }
      ]
    },
    {
      "title": "Cosmetic",
      "roles": [
        { "role": "PC", "emoji": "🖥️", "description": "If you play on PC" }
      ]
    }
  ]
}
```

Per role entry:

- `role`: the role name (created by /setup if it doesn't exist, reused if it does)
- `emoji`: shown on the button; a normal emoji, or a custom server emoji
  written as `<:name:id>` (type the emoji in Discord with a `\` in front
  to get that form)
- `channels` (optional): private channels only this role can see. Each is
  either a name (created by /setup if missing) or the **id of an existing
  channel** like `"1241480962882273440"` (right-click the channel → Copy
  Channel ID, with Developer Mode on). Ids are safest for channels you
  already have: /setup will only update their permissions, never create
  or rename anything. Omit `channels` for notification or cosmetic roles.
- `description` (optional): shown next to the role in the menu message

`menu_channel` also accepts a name or an id. `/post` takes an optional
`channel` argument to post the menu somewhere specific.

At most 25 roles get buttons (Discord's per-message limit). `ip`
(optional) sets what `/ip` replies with.

### 3. Deploy to Cloudflare

```sh
npm install
npx wrangler login    # opens the browser, one time
```

Edit `wrangler.jsonc` and fill in `DISCORD_APPLICATION_ID` and
`DISCORD_PUBLIC_KEY` (from step 1). Then:

```sh
npx wrangler secret put DISCORD_TOKEN    # paste the bot token when prompted
npm run deploy
```

The deploy prints your Worker's URL, something like
`https://oceanbot.<your-subdomain>.workers.dev`. Back in the Developer
Portal, paste that URL into **General Information → Interactions Endpoint
URL** and save. Discord immediately sends a test request; if it saves,
everything is wired up.

### 4. Register the commands

```sh
cp .env.example .env    # fill in the token, application ID, and server ID
npm run register
```

### 5. In Discord

Run `/setup`, then `/post`. Done: members click buttons to join and leave
channels.

## Making changes later

- **Menu or /ip changes:** edit `config.json`, run `npm run deploy`
  (the config is bundled into the Worker), then re-run `/setup` and
  `/post`. The menu message updates in place, and `/setup` asks for
  confirmation before changing any channel that already exists.
- **Code changes:** `npm run deploy`.
- **Command changes** (names, descriptions, permissions): `npm run register`.

## Legal

- [Terms of Service](TERMS_OF_SERVICE.md)
- [Privacy Policy](PRIVACY_POLICY.md)

## Local development

`npm run dev` starts the Worker locally on `http://localhost:8787`.
Requests must carry a valid Discord signature, so the easiest full test is
deploying to a workers.dev URL and pointing a test Discord app at it.
