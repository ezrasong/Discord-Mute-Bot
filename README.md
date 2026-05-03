# Discord Bot

Self-hosted Discord bot with slash commands for muting / vote-muting / russian roulette, reaction roles, Minecraft server watching + AMP control, music playback (YouTube, SoundCloud, Spotify metadata, etc) via Lavalink, and DM alerts for new SimplifyJobs off-season internship listings. Runs lean — bot itself is ~30-40 MB RAM, audio work is offloaded to a separate Lavalink container.

## Commands

### Moderation & fun
| Command | Description |
|---|---|
| `/mute <user> <duration>` | Mute a user (e.g. `30s`, `2m`). Requires Mute Members permission. |
| `/unmute <user>` | Unmute a user immediately. Requires Mute Members permission. |
| `/votemute <user> <duration>` | Start a vote to mute someone in your voice channel. |
| `/russianroulette` | Randomly mutes someone in your voice channel for 10-60s. 30s cooldown. |
| `/reactionrole <channel> <message_id> <emoji> <role>` | Set up a reaction role on a message. Requires Manage Roles. |
| `/rolepanel <title> <emoji1> <role1> ...` | Send a panel message with up to 4 emoji/role pairs. Requires Manage Roles. |
| `/removereactionrole <message_id> <emoji>` | Remove a reaction role. Requires Manage Roles. |

### Minecraft
| Command | Description |
|---|---|
| `/minecraftwatch add <host> <channel> <role> [port] [edition]` | Watch a Minecraft server and announce up/down + join/leave events. Requires Manage Server. |
| `/minecraftwatch remove <host> [port] [edition]` | Stop watching a server. |
| `/minecraftwatch list` | List watched servers. |
| `/mcserver start\|stop\|restart` | Control the configured AMP-managed Minecraft server. Requires a role named **minecraft** (case-insensitive). |
| `/mcserver status` | Read-only AMP status check. Open to anyone. |

### Internships
Subscribers get a DM whenever a new listing is added to the [SimplifyJobs Off-Season Internships](https://github.com/SimplifyJobs/Summer2026-Internships/blob/dev/README-Off-Season.md) README. The bot polls every 10 minutes; the first poll seeds a baseline so existing listings don't flood your DMs.

| Command | Description |
|---|---|
| `/internships subscribe` | Get DMed when new internships are posted. The bot sends a confirmation DM, so DMs from server members must be enabled. |
| `/internships unsubscribe` | Stop receiving internship DMs. |
| `/internships status` | Show whether you're subscribed and how many listings are being tracked. |

### Music (only registered when Lavalink is configured)
| Command | Description |
|---|---|
| `/play <query>` | Play a song from a URL or search query. Joins your voice channel. |
| `/skip` | Skip the current song. |
| `/stop` | Stop playback and clear the queue. |
| `/queue` | Show the song queue. |
| `/nowplaying` | Show the currently playing track. |
| `/pause` / `/resume` | Pause or resume playback. |
| `/volume <level>` | Set playback volume (0-150). |

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

## Music (Lavalink) setup

Music commands are powered by [Lavalink v4](https://github.com/lavalink-devs/Lavalink), which runs as a separate container next to the bot. The bot only sends commands over WebSocket — all the audio decoding, Opus encoding, and voice gateway work happens inside the JVM, so it stays out of Node's event loop and YouTube anti-bot breakage is patched upstream by the [youtube-source plugin](https://github.com/lavalink-devs/youtube-source) maintainers (just bump the version in `lavalink/application.yml` when needed).

If you used the included `docker-compose.yml`, Lavalink is already wired up. Just make sure these env vars are set on the bot container:

| Variable | Default | Description |
|---|---|---|
| `LAVALINK_HOST` | `lavalink` | Hostname of the Lavalink server (Compose service name when colocated). |
| `LAVALINK_PORT` | `2333` | Port Lavalink listens on. |
| `LAVALINK_PASSWORD` | _(unset)_ | Must match the `password` in `lavalink/application.yml`. **Music commands are only registered when this is set.** |

### Optional: Spotify links

The bundled config only resolves direct URLs from YouTube/SoundCloud/Bandcamp/Twitch/Vimeo and YouTube search queries. To play Spotify URLs (which the Spotify API doesn't allow streaming directly), add the [LavaSrc plugin](https://github.com/topi314/LavaSrc) to `lavalink/application.yml` with your Spotify client ID/secret — it resolves Spotify tracks to YouTube and plays them transparently.

## Resource Usage

The bot is configured to run lean:
- V8 heap capped at 64 MB
- Message cache limited to 50 per channel
- Presence cache disabled
- Old messages swept every 5 minutes
- Alpine-based Docker image (~50 MB)

Typical idle RAM usage for the bot: **~30-40 MB**.

When music is enabled, audio work runs inside the Lavalink container (~256 MB JVM heap by default in the included compose file). Per concurrent stream Lavalink uses roughly 30-80 MB extra and a few percent of one CPU core.
