# 🌊 Oceanbot

A Discord bot that lets members opt in to channels by clicking emoji buttons.
It posts a menu in a `#roles-for-channels` channel; clicking a button toggles
a role that shows or hides the matching channel.

## 1. Create the bot on Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application** → name it `oceanbot`.
2. In the left sidebar, open **Bot** → click **Reset Token** → copy the token (you'll need it in step 3).
3. Open **Installation** (or **OAuth2 → URL Generator**) and build an invite link with:
   - **Scopes:** `bot`, `applications.commands`
   - **Bot permissions:** `Manage Roles`, `Manage Channels`, `Send Messages`, `Embed Links`
4. Open that link in your browser and add the bot to your server.
5. In your server: **Server Settings → Roles** — drag the bot's role **above** the opt-in roles it will manage (above where new roles get created, near the top is easiest).

## 2. Configure

Edit `config.json` to list your opt-in channels:

```json
{
  "menu_channel": "roles-for-channels",
  "category": "Opt-in Channels",
  "channels": [
    { "name": "gaming", "emoji": "🎮", "label": "Gaming" }
  ]
}
```

- `name` — the channel's name
- `emoji` + `label` — what the button looks like (the label is also used as the role name)
- Up to 25 channels per menu (Discord's button limit per message)

## 3. Run it

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then paste your token (and server ID) into .env
python bot.py
```

## 4. Set up your server

In Discord (you need Manage Server permission):

1. **/setup** — creates the roles, the private channels, and the `#roles-for-channels` menu channel from `config.json`.
2. **/post** — posts the role menu with the buttons.

That's it — members click a button to join a channel, click again to leave.
Buttons keep working across bot restarts (no database needed).

## Changing the menu later

Edit `config.json`, restart the bot, then run **/setup** and **/post** again.
Delete the old menu message so there's only one.
