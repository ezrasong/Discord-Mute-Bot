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

First, copy the project to your Unraid server:

```bash
scp -r . root@<UNRAID_IP>:/mnt/user/appdata/discord-mute-bot/
```

Then SSH in and build the Docker image:

```bash
ssh root@<UNRAID_IP>
cd /mnt/user/appdata/discord-mute-bot
docker build -t discord-mute-bot .
```

### Option A: Docker UI (shows in the Docker tab)

This uses the included XML template so the container shows up in Unraid's Docker tab with a proper icon and editable settings.

1. **Install the template** by copying it to Unraid's template directory:
   ```bash
   cp /mnt/user/appdata/discord-mute-bot/unraid-template.xml \
      /boot/config/plugins/dockerMan/templates-user/my-discord-mute-bot.xml
   ```

2. In the Unraid web UI, go to **Docker** tab and click **Add Container**.

3. At the top, click **Select a template** and choose **discord-mute-bot** from the dropdown.

4. The form auto-fills. All you need to do is paste your **Bot Token** into the token field.

5. Click **Apply**. The container will start and appear in the Docker tab with a Discord icon.

6. Click the container's icon in the Docker tab to access **Start**, **Stop**, **Logs**, and **Edit** options.

### Option B: Docker Compose (also shows in the Docker tab)

Unraid 7.2.3 has built-in Compose support, and compose stacks appear in the Docker tab.

1. **Edit the compose file** to add your token:
   ```bash
   cd /mnt/user/appdata/discord-mute-bot
   nano docker-compose.yml
   ```
   Replace `your_token_here` with your actual bot token.

2. **Add the stack in the Unraid UI:**
   - Go to the **Docker** tab
   - Click **Compose** at the top
   - Click **Add New Stack**
   - Set the name to `discord-mute-bot`
   - Set the compose path to `/mnt/user/appdata/discord-mute-bot/docker-compose.yml`
   - Click **Save** and then **Compose Up**

3. The stack will appear in the Docker tab. You can start/stop/view logs from the UI.

   Alternatively, from the terminal:
   ```bash
   cd /mnt/user/appdata/discord-mute-bot
   docker compose up -d
   ```

### Verifying it works

Check the logs either from the Docker tab (click the container icon > Logs) or via terminal:

```bash
docker logs discord-mute-bot
```

You should see:
```
Logged in as YourBot#1234
Synced 6 commands.
```

### Updating the bot

After making code changes:

```bash
cd /mnt/user/appdata/discord-mute-bot
docker build -t discord-mute-bot .
docker restart discord-mute-bot
```

Or with compose: `docker compose up -d --build`

### Auto-start on boot

Both methods auto-restart on reboot. The template uses `--restart=unless-stopped` and the compose file sets `restart: unless-stopped`.

## Resource Usage

The bot is configured to run lean:
- V8 heap capped at 64 MB
- Message cache limited to 50 per channel
- Presence cache disabled
- Old messages swept every 5 minutes
- Alpine-based Docker image (~50 MB)

Typical idle RAM usage: **~30-40 MB**.
