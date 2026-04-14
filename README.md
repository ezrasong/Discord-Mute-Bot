# Discord Mute Bot

Discord bot for muting people with slash commands, vote-muting, russian roulette, and reaction roles.

## Commands

| Command | Description |
|---|---|
| `/mute <user> <duration>` | Mute a user (e.g. `30s`, `2m`). Requires Mute Members permission. |
| `/unmute <user>` | Unmute a user immediately. Requires Mute Members permission. |
| `/votemute <user> <duration>` | Start a vote to mute someone in your voice channel. |
| `/russianroulette` | Randomly mutes someone in your voice channel for 10-60s. 30s cooldown. |
| `/reactionrole <channel> <message_id> <emoji> <role>` | Set up a reaction role on a message. Requires Manage Roles. |
| `/removereactionrole <message_id> <emoji>` | Remove a reaction role. Requires Manage Roles. |

## Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application and add a bot
3. Under **Bot**, enable these **Privileged Gateway Intents**:
   - Server Members Intent
   - Message Content Intent (not strictly required, but recommended)
4. Under **OAuth2 > URL Generator**, select:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Manage Roles`, `Mute Members`, `Send Messages`, `Add Reactions`, `Read Message History`
5. Use the generated URL to invite the bot to your server
6. Copy the bot token from the **Bot** page -- you'll need it below

## Running Locally

Requires Node.js 18+.

```bash
npm install
BOT_TOKEN=your_token_here npm start
```

## Deploying on Unraid 7.2.3

### Option A: Docker Compose (recommended)

Unraid 7.2.3 has built-in Docker Compose support.

1. **Copy the project** to your Unraid server, for example:
   ```bash
   scp -r . root@<UNRAID_IP>:/mnt/user/appdata/discord-mute-bot/
   ```

2. **SSH into Unraid** and edit the compose file to add your token:
   ```bash
   ssh root@<UNRAID_IP>
   cd /mnt/user/appdata/discord-mute-bot
   nano docker-compose.yml
   ```
   Replace `your_token_here` with your actual bot token.

3. **Start the container:**
   ```bash
   docker compose up -d --build
   ```

4. **Verify it's running:**
   ```bash
   docker compose logs -f
   ```
   You should see `Logged in as YourBot#1234` and `Synced 6 commands.`

To stop: `docker compose down`
To update after code changes: `docker compose up -d --build`

### Option B: Unraid Docker UI

1. Open a terminal on Unraid and build the image:
   ```bash
   cd /mnt/user/appdata/discord-mute-bot
   docker build -t discord-mute-bot .
   ```

2. In the Unraid web UI, go to **Docker > Add Container** and fill in:
   - **Name:** `discord-mute-bot`
   - **Repository:** `discord-mute-bot`
   - **Network Type:** `bridge`
   - Click **Add another Path, Port, Variable, Label or Device**, then:
     - **Config Type:** Variable
     - **Key:** `BOT_TOKEN`
     - **Value:** your bot token
   - Click **Apply**

3. The container should start automatically. Check the logs in the Docker tab to confirm.

### Auto-start on boot

Both methods auto-restart the container on reboot (`restart: unless-stopped` is set in the compose file / Unraid enables this by default for Docker containers).

## Resource Usage

The bot is configured to run lean:
- V8 heap capped at 64 MB
- Message cache limited to 50 per channel
- Presence cache disabled
- Old messages swept every 5 minutes
- Alpine-based Docker image (~50 MB)

Typical idle RAM usage: **~30-40 MB**.
