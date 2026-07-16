# 🌊 Oceanbot

A Discord bot for opt-in channels. It posts a menu of emoji buttons in a
`#roles-for-channels` channel; clicking a button toggles a role that shows
or hides the matching channel. No database, and buttons keep working across
restarts.

## Commands

| Command  | Who         | What it does                                                         |
| -------- | ----------- | -------------------------------------------------------------------- |
| `/setup` | Admins      | Creates the roles, private channels, and menu channel from `config.json`. Asks before touching existing channels. |
| `/post`  | Admins      | Posts the button menu, or updates it in place if it already exists.  |
| `/ip`    | Everyone    | Replies with the Minecraft server info from `config.json`.           |

## Setup

### 1. Create the bot on Discord

1. In the [Developer Portal](https://discord.com/developers/applications), click **New Application** and name it `oceanbot`.
2. **Bot** tab → **Reset Token** → copy the token.
3. **OAuth2 → URL Generator**: check the scopes `bot` + `applications.commands` and the permissions `Manage Roles`, `Manage Channels`, `Send Messages`, `Embed Links`. Open the generated link to invite the bot.
4. In **Server Settings → Roles**, drag the bot's role above the opt-in roles it will manage (near the top is easiest).

### 2. Configure

Everything user-facing lives in `config.json`:

```json
{
  "menu_channel": "roles-for-channels",
  "category": "Opt-in Channels",
  "menu_title": "🌊 Pick your channels",
  "menu_description": "Click a button to join (or leave) a channel.",
  "ip": {
    "title": "⛏️ Minecraft Server",
    "description": "**`mc.sn4k.org`**"
  },
  "channels": [
    { "name": "gaming", "emoji": "🎮", "label": "Gaming" }
  ]
}
```

- `channels`: one entry per opt-in channel. `name` is the channel,
  `emoji` + `label` are the button (the label doubles as the role name).
  Up to 25 per menu (Discord's button limit).
- `menu_channel`: where the menu gets posted.
- `ip` (optional): the title and text `/ip` replies with.

### 3. Run it

**On Unraid (recommended).** Every push to `main` publishes
`ghcr.io/yoshiromaximus/oceanbot:latest`, so the server never needs the
source code:

1. Copy `config.json` to `/mnt/user/appdata/oceanbot/config.json`
   (over SMB: `\\TOWER\appdata\oceanbot\`).
2. **Docker** tab → **Add Container**:
   - **Repository:** `ghcr.io/yoshiromaximus/oceanbot:latest`
   - **Variable** `DISCORD_TOKEN`: your bot token
   - **Variable** `GUILD_ID`: your server ID (makes commands sync instantly)
   - **Path**: host `/mnt/user/appdata/oceanbot/config.json` → container `/app/config.json`
3. **Apply**. The bot starts and auto-starts with the server from then on.

**Locally (for development):**

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # paste your token and server ID in
python bot.py
```

There's also a `docker-compose.yml` if you want to build the image from
source instead of pulling it: `docker compose up -d --build`.

### 4. In Discord

Run `/setup`, then `/post`. Done: members click buttons to join and leave
channels.

## Making changes later

- **Menu changes:** edit `config.json`, restart the container, then re-run
  `/setup` and `/post`. The menu message updates in place, and `/setup`
  asks for confirmation before changing any channel that already exists.
- **Code changes:** push to `main`, wait for the
  [build action](https://github.com/YoshiroMaximus/oceanbot/actions) to go
  green, then hit **force update** on the container in Unraid's Docker tab
  (or let the Auto Update plugin handle it).
