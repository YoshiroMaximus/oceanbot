# Oceanbot Privacy Policy

Effective date: July 16, 2026

Oceanbot is designed to store as little as possible. In short: **it has no
database and keeps no record of who you are or what you clicked.**

## What the bot processes

When you use a command or click a button, Discord sends the bot the data
it needs to respond: your user ID, your current roles, the server ID, and
which command or button you used. The bot uses this information only to
perform the action you asked for (for example, giving you a role) and
discards it as soon as the request finishes.

## What the bot stores

Nothing. Oceanbot has no database. The roles you gain or lose live in
Discord itself, exactly like roles assigned by a human moderator. The
bot's configuration (its list of opt-in channels) contains channel names
chosen by the server admin, not member data.

## Logs

The bot runs on Cloudflare Workers. Basic operational logs (such as
request timestamps and errors) may be retained briefly by Cloudflare for
debugging, subject to [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
Error logs do not intentionally include message content, and the bot never
reads regular chat messages at all; it only receives its own commands and
button clicks.

## What the bot shares or sells

Nothing, with no one. The bot communicates only with Discord's API.

## Data removal

Since nothing is stored, there is nothing to delete. Removing the bot from
a server (or removing your roles) leaves no data behind anywhere.

## Changes

This policy may be updated from time to time; the current version always
lives at this page.

## Contact

Questions: open an issue at
https://github.com/YoshiroMaximus/oceanbot/issues
