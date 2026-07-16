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
5. In your server: **Server Settings → Roles**, then drag the bot's role **above** the opt-in roles it will manage (above where new roles get created, near the top is easiest).

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

- `name`: the channel's name
- `emoji` + `label`: what the button looks like (the label is also used as the role name)
- Up to 25 channels per menu (Discord's button limit per message)

The optional `ip` section sets the title and text that **/ip** replies with.

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

1. **/setup**: creates the roles, the private channels, and the `#roles-for-channels` menu channel from `config.json`.
2. **/post**: posts the role menu with the buttons.

That's it. Members click a button to join a channel, click again to leave.
Buttons keep working across bot restarts (no database needed).

## Hosting on Unraid (24/7)

1. Copy this whole folder to your Unraid server, e.g. into `appdata`:
   over SMB to `\\TOWER\appdata\oceanbot`, or with
   `scp -r oceanbot root@TOWER:/mnt/user/appdata/`.
2. Make sure the folder contains a `.env` with your `DISCORD_TOKEN`
   (and `GUILD_ID`). Copy `.env.example` if you haven't made one.
3. Open the Unraid web terminal (the `>_` icon, top right) and run:

   ```sh
   cd /mnt/user/appdata/oceanbot
   docker compose up -d --build
   ```

That's it. `restart: unless-stopped` means the bot survives crashes and
server reboots. Useful commands, all from that same folder:

- `docker logs -f oceanbot` to watch the logs
- `docker compose up -d --build` again after changing `bot.py`
- `docker restart oceanbot` after changing `config.json` (it's mounted
  into the container, no rebuild needed)
- `docker compose down` to stop it

The container also shows up in Unraid's **Docker** tab, where you can
start/stop it and read logs from the web UI.

## Changing the menu later

Edit `config.json`, then run **/setup** and **/post** again. No restart needed:
the config is re-read on every command, and **/post** updates the existing menu
message in place. If **/setup** would change permissions on channels that
already exist, it asks you to confirm first.
