const {
    Client,
    GatewayIntentBits,
    Options,
    Partials,
    PermissionFlagsBits,
    SlashCommandBuilder,
    REST,
    Routes,
    ActivityType,
    Events,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { status: mcStatus, statusBedrock: mcStatusBedrock } = require('minecraft-server-util');
const { LavalinkManager } = require('lavalink-client');
const { getPreview: spotifyGetPreview, getTracks: spotifyGetTracks } =
    require('spotify-url-info')(fetch);

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
    console.error('Missing BOT_TOKEN environment variable.');
    process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || '/data';
const REACTION_ROLES_FILE = path.join(DATA_DIR, 'reaction_roles.json');
const MINECRAFT_WATCHES_FILE = path.join(DATA_DIR, 'minecraft_watches.json');
const MUSIC_VOLUMES_FILE = path.join(DATA_DIR, 'music_volumes.json');
const INTERNSHIP_SUBS_FILE = path.join(DATA_DIR, 'internship_subs.json');
const INTERNSHIP_SEEN_FILE = path.join(DATA_DIR, 'internship_seen.json');
const DEFAULT_MUSIC_VOLUME = 100;

const MINECRAFT_POLL_INTERVAL_MS = 15_000;
const MINECRAFT_PING_TIMEOUT_MS = 5_000;

const INTERNSHIP_README_URL =
    'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README-Off-Season.md';
const INTERNSHIP_SOURCE_URL =
    'https://github.com/SimplifyJobs/Summer2026-Internships/blob/dev/README-Off-Season.md';
const INTERNSHIP_POLL_INTERVAL_MS = 10 * 60 * 1000;
const INTERNSHIP_FIRST_POLL_DELAY_MS = 10_000;

const LAVALINK_HOST = process.env.LAVALINK_HOST || 'lavalink';
const LAVALINK_PORT = parseInt(process.env.LAVALINK_PORT || '2333', 10);
const LAVALINK_PASSWORD = process.env.LAVALINK_PASSWORD;
const MUSIC_ENABLED = Boolean(LAVALINK_PASSWORD);

const AMP_URL = process.env.AMP_URL;
const AMP_USERNAME = process.env.AMP_USERNAME;
const AMP_PASSWORD = process.env.AMP_PASSWORD;
const AMP_INSTANCE = process.env.AMP_INSTANCE; // instance name or GUID when using ADS
const AMP_SESSION_TTL_MS = 10 * 60 * 1000;
const AMP_STATE_NAMES = {
    '-1': 'Undefined',
    0: 'Stopped',
    5: 'PreStart',
    7: 'Configuring',
    10: 'Starting',
    20: 'Ready',
    30: 'Restarting',
    40: 'Stopping',
    45: 'PreparingForSleep',
    50: 'Sleeping',
    60: 'Waiting',
    70: 'Installing',
    75: 'Updating',
    80: 'AwaitingUserInput',
    100: 'Failed',
    200: 'Suspended',
    250: 'Maintenance',
    999: 'Indeterminate',
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.GuildMember, Partials.Channel],
    makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 50,
        PresenceManager: 0,
    }),
    sweepers: {
        ...Options.DefaultSweeperSettings,
        messages: { interval: 300, lifetime: 600 },
    },
});

let lavalink = null;
if (MUSIC_ENABLED) {
    lavalink = new LavalinkManager({
        nodes: [
            {
                authorization: LAVALINK_PASSWORD,
                host: LAVALINK_HOST,
                port: LAVALINK_PORT,
                id: 'main',
                retryAmount: 5,
                retryDelay: 5_000,
            },
        ],
        sendToShard: (guildId, payload) =>
            client.guilds.cache.get(guildId)?.shard?.send(payload),
        client: { id: 'pending', username: 'discord-mute-bot' },
        autoSkip: true,
        playerOptions: {
            defaultSearchPlatform: 'ytmsearch',
            onDisconnect: { autoReconnect: false, destroyPlayer: true },
            onEmptyQueue: { destroyAfterMs: 60_000 },
        },
    });

    client.on('raw', (d) => lavalink.sendRawData(d));

    lavalink.nodeManager.on('connect', (node) =>
        console.log(`[lavalink] connected to ${node.id}`)
    );
    lavalink.nodeManager.on('disconnect', (node, reason) =>
        console.log(`[lavalink] disconnected from ${node.id}: ${JSON.stringify(reason)}`)
    );
    lavalink.nodeManager.on('error', (node, err) =>
        console.error(`[lavalink] node ${node?.id} error:`, err?.message ?? err)
    );

    lavalink.on('trackStart', async (player) => {
        await renderNowPlaying(player).catch((e) =>
            console.error('[lavalink] renderNowPlaying failed:', e?.message ?? e)
        );
    });

    lavalink.on('queueEnd', async (player) => {
        await clearNowPlaying(player).catch(() => {});
        const channel = client.channels.cache.get(player.textChannelId);
        if (!channel) return;
        const msg = await channel.send('Queue ended.').catch(() => null);
        if (msg) setTimeout(() => msg.delete().catch(() => {}), 15_000);
    });

    lavalink.on('playerDestroy', async (player) => {
        await clearNowPlaying(player).catch(() => {});
    });

    lavalink.on('playerDisconnect', async (player) => {
        await clearNowPlaying(player).catch(() => {});
    });
}

// guildId -> { channelId, messageId }
const nowPlayingMessages = new Map();

const REPEAT_LABELS = { off: 'Loop: Off', track: 'Loop: Track', queue: 'Loop: Queue' };
const REPEAT_NEXT = { off: 'track', track: 'queue', queue: 'off' };
const SEEK_STEP_MS = 10_000;

function formatTrackTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function buildNowPlayingPayload(player) {
    const track = player.queue?.current;
    if (!track) return null;
    const info = track.info || {};
    const requester = track.requester || track.userData?.requester;
    const repeat = player.repeatMode || 'off';

    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: player.paused ? 'Paused' : 'Now Playing' })
        .setTitle(info.title || 'Unknown Track')
        .setURL(info.uri || null)
        .addFields(
            { name: 'Artist', value: info.author || 'Unknown', inline: true },
            {
                name: 'Duration',
                value: info.isStream ? 'LIVE' : formatTrackTime(info.duration ?? 0),
                inline: true,
            },
            { name: 'Volume', value: `${player.volume ?? 100}%`, inline: true }
        );

    const artwork = info.artworkUrl || info.thumbnail || info.image;
    if (artwork) embed.setThumbnail(artwork);

    const upcoming = player.queue?.tracks ?? [];
    if (upcoming.length) {
        const preview = upcoming
            .slice(0, 5)
            .map((t, i) => `\`${i + 1}.\` ${t.info?.title ?? 'Unknown'}`)
            .join('\n');
        const extra = upcoming.length > 5 ? `\n…and ${upcoming.length - 5} more` : '';
        embed.addFields({
            name: `Up Next (${upcoming.length})`,
            value: `${preview}${extra}`.slice(0, 1024),
        });
    }

    const footerBits = [];
    if (repeat !== 'off') footerBits.push(REPEAT_LABELS[repeat]);
    const requesterName = requester?.tag || requester?.username || requester?.globalName;
    if (requesterName) footerBits.push(`Requested by ${requesterName}`);
    if (footerBits.length) embed.setFooter({ text: footerBits.join(' • ') });

    const seekable = Boolean(info.isSeekable) && !info.isStream;
    const transport = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('music:back')
            .setEmoji('⏮️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled((player.queue?.previous?.length ?? 0) === 0),
        new ButtonBuilder()
            .setCustomId('music:rewind')
            .setEmoji('⏪')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!seekable),
        new ButtonBuilder()
            .setCustomId(player.paused ? 'music:resume' : 'music:pause')
            .setEmoji(player.paused ? '▶️' : '⏸️')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('music:forward')
            .setEmoji('⏩')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!seekable),
        new ButtonBuilder()
            .setCustomId('music:skip')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Secondary)
    );

    const queueRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('music:shuffle')
            .setEmoji('🔀')
            .setLabel('Shuffle')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(upcoming.length < 2),
        new ButtonBuilder()
            .setCustomId('music:loop')
            .setEmoji('🔁')
            .setLabel(REPEAT_LABELS[repeat] || 'Loop: Off')
            .setStyle(repeat === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('music:stop')
            .setEmoji('⏹️')
            .setLabel('Stop')
            .setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [transport, queueRow] };
}

async function renderNowPlaying(player) {
    const channel = client.channels.cache.get(player.textChannelId);
    if (!channel) return;
    const payload = buildNowPlayingPayload(player);
    if (!payload) return;

    const existing = nowPlayingMessages.get(player.guildId);
    if (existing) {
        if (existing.channelId === channel.id) {
            try {
                const msg = await channel.messages.fetch(existing.messageId);
                await msg.edit(payload);
                return;
            } catch {}
        } else {
            const oldChannel = client.channels.cache.get(existing.channelId);
            if (oldChannel) {
                try {
                    const old = await oldChannel.messages.fetch(existing.messageId);
                    await old.delete();
                } catch {}
            }
        }
    }
    try {
        const msg = await channel.send(payload);
        nowPlayingMessages.set(player.guildId, {
            channelId: channel.id,
            messageId: msg.id,
        });
    } catch (e) {
        console.error('[lavalink] failed to send now-playing message:', e?.message ?? e);
    }
}

async function clearNowPlaying(player) {
    const ref = nowPlayingMessages.get(player.guildId);
    nowPlayingMessages.delete(player.guildId);
    if (!ref) return;
    const channel = client.channels.cache.get(ref.channelId);
    if (!channel) return;
    try {
        const msg = await channel.messages.fetch(ref.messageId);
        await msg.delete();
    } catch {}
}

const SPOTIFY_URL_RE = /^https?:\/\/(?:open\.spotify\.com|spotify\.link)\/.+/i;
const SPOTIFY_RESOLVE_BATCH = 5;

function isSpotifyUrl(s) {
    return SPOTIFY_URL_RE.test(s);
}

async function resolveSpotifyMeta(url) {
    const [preview, tracks] = await Promise.all([
        spotifyGetPreview(url),
        spotifyGetTracks(url),
    ]);
    return {
        type: preview?.type ?? 'track',
        name: preview?.title ?? 'Spotify',
        items: (tracks ?? [])
            .filter((t) => t?.name)
            .map((t) => ({
                title: t.name,
                artist: t.artist || '',
            })),
    };
}

async function resolveYoutubeForSpotify(player, item, requester) {
    const q = `${item.title} ${item.artist}`.trim();
    try {
        const res = await player.search({ query: q, source: 'ytmsearch' }, requester);
        return res?.tracks?.[0] ?? null;
    } catch (e) {
        console.error(`[spotify] ytmsearch failed for "${q}":`, e?.message ?? e);
        return null;
    }
}

async function queueSpotifyUrl(player, url, interaction) {
    let meta;
    try {
        meta = await resolveSpotifyMeta(url);
    } catch (e) {
        console.error('[spotify] resolve failed:', e?.message ?? e);
        await interaction.editReply(
            `Couldn't read that Spotify link: ${e.message || 'unknown error'}.`
        );
        return false;
    }
    if (!meta.items.length) {
        await interaction.editReply('No tracks found in that Spotify link.');
        return false;
    }

    const wasPlayingOrPaused = player.playing || player.paused;

    if (meta.type === 'track') {
        const track = await resolveYoutubeForSpotify(player, meta.items[0], interaction.user);
        if (!track) {
            await interaction.editReply(
                `Couldn't find **${meta.items[0].title}** on YouTube Music.`
            );
            return false;
        }
        await player.queue.add(track);
        await interaction.editReply(
            `Queued: **${meta.items[0].title}** — ${meta.items[0].artist || 'Unknown'} *(via YouTube Music)*`
        );
        if (!player.playing && !player.paused) await player.play();
        if (wasPlayingOrPaused) await renderNowPlaying(player).catch(() => {});
        return true;
    }

    await interaction.editReply(
        `Resolving **${meta.items.length}** tracks from **${meta.name}**…`
    );

    const queued = [];
    let failed = 0;
    for (let i = 0; i < meta.items.length; i += SPOTIFY_RESOLVE_BATCH) {
        const batch = meta.items.slice(i, i + SPOTIFY_RESOLVE_BATCH);
        const results = await Promise.all(
            batch.map((item) => resolveYoutubeForSpotify(player, item, interaction.user))
        );
        for (const t of results) {
            if (t) queued.push(t);
            else failed++;
        }
    }

    if (!queued.length) {
        await interaction.editReply(
            `Couldn't find any tracks from **${meta.name}** on YouTube Music.`
        );
        return false;
    }

    await player.queue.add(queued);
    if (!player.playing && !player.paused) await player.play();

    const summary = failed
        ? `Queued **${queued.length}** of ${meta.items.length} tracks from **${meta.name}** (${failed} not found) *(via YouTube Music)*.`
        : `Queued **${queued.length}** tracks from **${meta.name}** *(via YouTube Music)*.`;
    await interaction.editReply(summary);
    if (wasPlayingOrPaused) await renderNowPlaying(player).catch(() => {});
    return true;
}

// --- State ---
const muteEndTimes = new Map();
const muteStartTimes = new Map();
const muteTimers = new Map();
const voteMuteMessages = new Map();
const russianRouletteCooldowns = new Map();
const reactionRoles = new Map(); // messageId -> Map(emojiKey -> roleId)
const minecraftWatches = new Map(); // key -> { host, port, edition, channelId, roleId, lastStatus, pendingCount }
const musicVolumes = new Map(); // guildId -> volume (0-150)
const internshipSubs = new Set(); // user IDs subscribed to new-listing DMs
const internshipSeen = new Set(); // entry keys we've already announced
let internshipBaselined = false;

let ampSessionId = null;
let ampSessionExpiresAt = 0;
let ampResolvedInstanceId = null;
let ampInstanceSessionId = null;
let ampInstanceSessionExpiresAt = 0;
let ampInstanceSessionFor = null;

const RUSSIAN_ROULETTE_COOLDOWN = 30;
const CUSTOM_EMOJI_ID = '1350401925237178378';
const CUSTOM_EMOJI_NAME = 'customemoji';

// --- Helpers ---

function parseDuration(str) {
    const last = str.slice(-1).toLowerCase();
    const num = parseFloat(str.slice(0, -1));
    if (last === 'm' && !isNaN(num)) return Math.floor(num * 60);
    if (last === 's' && !isNaN(num)) return Math.floor(num);
    const full = parseFloat(str);
    return isNaN(full) ? null : Math.floor(full);
}

async function getTrueRandomInt(min, max) {
    const res = await fetch(
        `https://www.randomnumberapi.com/api/v1.0/random?min=${min}&max=${max}&count=1`
    );
    const data = await res.json();
    return data[0];
}

async function doUnmute(userId, channelId) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return;
    const member = channel.guild.members.cache.get(userId);
    const start = muteStartTimes.get(userId);
    muteStartTimes.delete(userId);
    muteEndTimes.delete(userId);
    const timer = muteTimers.get(userId);
    if (timer) clearTimeout(timer);
    muteTimers.delete(userId);
    if (member?.voice?.channel) {
        try {
            await member.voice.setMute(false);
            if (start) {
                const total = Math.floor(Date.now() / 1000 - start);
                const msg = await channel.send(
                    `${member.displayName} was unmuted after ${total} seconds.`
                );
                setTimeout(() => msg.delete().catch(() => {}), 10_000);
            }
        } catch {
            const msg = await channel.send('I lack permission to unmute.');
            setTimeout(() => msg.delete().catch(() => {}), 10_000);
        }
    }
}

async function addMute(member, seconds, channel) {
    const now = Date.now() / 1000;
    const uid = member.id;
    const existing = muteTimers.get(uid);
    if (existing) clearTimeout(existing);
    const prevEnd = muteEndTimes.get(uid) || 0;
    if (prevEnd <= now) muteStartTimes.set(uid, now);
    const end = Math.max(now, prevEnd) + seconds;
    muteEndTimes.set(uid, end);
    if (member.voice?.channel && !member.voice.serverMute) {
        await member.voice.setMute(true);
    }
    muteTimers.set(
        uid,
        setTimeout(() => doUnmute(uid, channel.id), (end - now) * 1000)
    );
}

function emojiKey(emoji) {
    return emoji.id ?? emoji.name;
}

function loadReactionRoles() {
    try {
        const raw = fs.readFileSync(REACTION_ROLES_FILE, 'utf8');
        const obj = JSON.parse(raw);
        for (const [messageId, emojiMap] of Object.entries(obj)) {
            reactionRoles.set(messageId, new Map(Object.entries(emojiMap)));
        }
        console.log(`Loaded reaction roles for ${reactionRoles.size} message(s).`);
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log('No reaction roles file found; starting fresh.');
        } else {
            console.error('Failed to load reaction roles:', e);
        }
    }
}

function saveReactionRoles() {
    const obj = {};
    for (const [messageId, emojiMap] of reactionRoles.entries()) {
        obj[messageId] = Object.fromEntries(emojiMap);
    }
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(REACTION_ROLES_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
        console.error('Failed to save reaction roles:', e);
    }
}

function minecraftWatchKey(host, port, edition) {
    return `${edition}:${host.toLowerCase()}:${port}`;
}

function loadMinecraftWatches() {
    try {
        const raw = fs.readFileSync(MINECRAFT_WATCHES_FILE, 'utf8');
        const arr = JSON.parse(raw);
        for (const w of arr) {
            minecraftWatches.set(minecraftWatchKey(w.host, w.port, w.edition), {
                host: w.host,
                port: w.port,
                edition: w.edition,
                channelId: w.channelId,
                roleId: w.roleId,
                lastStatus: null,
                pendingCount: 0,
                lastPlayers: new Set(),
                lastOnlineCount: 0,
            });
        }
        console.log(`Loaded ${minecraftWatches.size} Minecraft watch(es).`);
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log('No Minecraft watches file found; starting fresh.');
        } else {
            console.error('Failed to load Minecraft watches:', e);
        }
    }
}

function loadMusicVolumes() {
    try {
        const raw = fs.readFileSync(MUSIC_VOLUMES_FILE, 'utf8');
        const obj = JSON.parse(raw);
        for (const [guildId, volume] of Object.entries(obj)) {
            const v = Number(volume);
            if (Number.isFinite(v)) musicVolumes.set(guildId, v);
        }
        console.log(`Loaded music volumes for ${musicVolumes.size} guild(s).`);
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log('No music volumes file found; starting fresh.');
        } else {
            console.error('Failed to load music volumes:', e);
        }
    }
}

function saveMusicVolumes() {
    const obj = Object.fromEntries(musicVolumes);
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(MUSIC_VOLUMES_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
        console.error('Failed to save music volumes:', e);
    }
}

function setStoredVolume(guildId, level) {
    musicVolumes.set(guildId, level);
    saveMusicVolumes();
}

function saveMinecraftWatches() {
    const arr = [...minecraftWatches.values()].map((w) => ({
        host: w.host,
        port: w.port,
        edition: w.edition,
        channelId: w.channelId,
        roleId: w.roleId,
    }));
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(MINECRAFT_WATCHES_FILE, JSON.stringify(arr, null, 2));
    } catch (e) {
        console.error('Failed to save Minecraft watches:', e);
    }
}

function loadInternshipSubs() {
    try {
        const raw = fs.readFileSync(INTERNSHIP_SUBS_FILE, 'utf8');
        const arr = JSON.parse(raw);
        for (const id of arr) if (typeof id === 'string') internshipSubs.add(id);
        console.log(`Loaded ${internshipSubs.size} internship subscriber(s).`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error('Failed to load internship subs:', e);
    }
}

function saveInternshipSubs() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(INTERNSHIP_SUBS_FILE, JSON.stringify([...internshipSubs], null, 2));
    } catch (e) {
        console.error('Failed to save internship subs:', e);
    }
}

function loadInternshipSeen() {
    try {
        const raw = fs.readFileSync(INTERNSHIP_SEEN_FILE, 'utf8');
        const obj = JSON.parse(raw);
        if (Array.isArray(obj?.keys)) {
            for (const k of obj.keys) if (typeof k === 'string') internshipSeen.add(k);
            internshipBaselined = Boolean(obj.baselined) && internshipSeen.size > 0;
        }
        console.log(
            `Loaded ${internshipSeen.size} seen internship key(s); baselined=${internshipBaselined}.`
        );
    } catch (e) {
        if (e.code !== 'ENOENT') console.error('Failed to load internship seen:', e);
    }
}

function saveInternshipSeen() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(
            INTERNSHIP_SEEN_FILE,
            JSON.stringify({ baselined: internshipBaselined, keys: [...internshipSeen] }, null, 2)
        );
    } catch (e) {
        console.error('Failed to save internship seen:', e);
    }
}

function htmlCellToText(s, separator = ' ') {
    return s
        .replace(/<br\s*\/?>/gi, separator)
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseInternshipsMarkdown(md) {
    const entries = [];
    const sectionRe = /^##\s+(.+)$/gm;
    const sections = [];
    let last = null;
    let m;
    while ((m = sectionRe.exec(md)) !== null) {
        if (last) sections.push({ title: last.title, body: md.slice(last.idx, m.index) });
        last = { title: m[1].trim(), idx: m.index + m[0].length };
    }
    if (last) sections.push({ title: last.title, body: md.slice(last.idx) });

    for (const sec of sections) {
        if (!/Internship Roles/i.test(sec.title)) continue;
        const category = sec.title.replace(/[^\p{L}\p{N}& ,]/gu, '').replace(/Internship Roles/i, '').trim();

        let lastCompany = null;
        const trRe = /<tr>([\s\S]*?)<\/tr>/g;
        let tr;
        while ((tr = trRe.exec(sec.body)) !== null) {
            const trBody = tr[1];
            if (/<th[\s>]/i.test(trBody)) continue;
            const cells = [];
            const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
            let td;
            while ((td = tdRe.exec(trBody)) !== null) cells.push(td[1]);
            if (cells.length < 5) continue;

            const [companyCell, roleCell, locationCell, termsCell, applyCell] = cells;
            const companyText = htmlCellToText(companyCell);
            let company;
            if (/^↳/.test(companyText) || companyText === '') {
                company = lastCompany;
            } else {
                const a = companyCell.match(/<a[^>]*>([\s\S]*?)<\/a>/);
                company = htmlCellToText(a ? a[1] : companyCell);
                lastCompany = company;
            }
            if (!company) continue;

            const role = htmlCellToText(roleCell);
            const location = htmlCellToText(locationCell, ', ');
            const terms = htmlCellToText(termsCell);

            const urls = [];
            const aRe = /<a\s+href="([^"]+)"/gi;
            let am;
            while ((am = aRe.exec(applyCell)) !== null) urls.push(am[1]);
            const applyUrl = urls.find((u) => !/simplify\.jobs/i.test(u)) || urls[0] || null;
            const simplifyUrl = urls.find((u) => /simplify\.jobs/i.test(u)) || null;

            const closed = /🔒/.test(applyCell) || urls.length === 0;
            const key = `${(company || '').toLowerCase()}|${role.toLowerCase()}|${location.toLowerCase()}|${(applyUrl || '').toLowerCase()}`;

            entries.push({ key, company, role, location, terms, applyUrl, simplifyUrl, closed, category });
        }
    }
    return entries;
}

function buildInternshipEmbed(entry) {
    const embed = new EmbedBuilder()
        .setTitle(`${entry.company} — ${entry.role}`.slice(0, 256))
        .setColor(0x57f287)
        .setFooter({ text: 'SimplifyJobs Off-Season Internships' })
        .setTimestamp(new Date());
    if (entry.applyUrl) embed.setURL(entry.applyUrl);
    const fields = [];
    if (entry.location) fields.push({ name: 'Location', value: entry.location.slice(0, 1024), inline: true });
    if (entry.terms) fields.push({ name: 'Terms', value: entry.terms.slice(0, 1024), inline: true });
    if (entry.category) fields.push({ name: 'Category', value: entry.category.slice(0, 1024), inline: true });
    const links = [];
    if (entry.applyUrl) links.push(`[Apply](${entry.applyUrl})`);
    if (entry.simplifyUrl) links.push(`[Simplify](${entry.simplifyUrl})`);
    if (links.length) fields.push({ name: 'Links', value: links.join(' • '), inline: false });
    if (fields.length) embed.addFields(fields);
    if (entry.closed) embed.setDescription(':lock: Application appears to be closed.');
    return embed;
}

async function dmInternshipEntry(userId, entry) {
    try {
        const user = await client.users.fetch(userId);
        await user.send({ embeds: [buildInternshipEmbed(entry)] });
        return true;
    } catch (e) {
        console.error(`Failed to DM internship entry to ${userId}:`, e?.message ?? e);
        return false;
    }
}

async function pollInternships() {
    let md;
    try {
        const res = await fetch(INTERNSHIP_README_URL, {
            headers: { 'User-Agent': 'discord-mute-bot internship-watcher' },
        });
        if (!res.ok) {
            console.error(`[internships] fetch failed: ${res.status}`);
            return;
        }
        md = await res.text();
    } catch (e) {
        console.error('[internships] fetch error:', e?.message ?? e);
        return;
    }

    let entries;
    try {
        entries = parseInternshipsMarkdown(md);
    } catch (e) {
        console.error('[internships] parse error:', e?.message ?? e);
        return;
    }

    if (entries.length === 0) {
        console.warn('[internships] parsed 0 entries — skipping update.');
        return;
    }

    if (!internshipBaselined) {
        for (const e of entries) internshipSeen.add(e.key);
        internshipBaselined = true;
        saveInternshipSeen();
        console.log(`[internships] baseline established with ${entries.length} listing(s).`);
        return;
    }

    const newOnes = entries.filter((e) => !internshipSeen.has(e.key));
    if (newOnes.length === 0) return;

    console.log(`[internships] ${newOnes.length} new listing(s); subscribers: ${internshipSubs.size}.`);
    for (const entry of newOnes) internshipSeen.add(entry.key);
    saveInternshipSeen();

    if (internshipSubs.size === 0) return;
    const subscribers = [...internshipSubs];
    for (const entry of newOnes) {
        for (const userId of subscribers) {
            await dmInternshipEntry(userId, entry);
        }
    }
}

async function checkMinecraftServer(watch) {
    try {
        let players = [];
        let online = 0;
        if (watch.edition === 'bedrock') {
            const res = await mcStatusBedrock(watch.host, watch.port, { timeout: MINECRAFT_PING_TIMEOUT_MS });
            online = res?.players?.online ?? 0;
        } else {
            const res = await mcStatus(watch.host, watch.port, { timeout: MINECRAFT_PING_TIMEOUT_MS });
            online = res?.players?.online ?? 0;
            players = (res?.players?.sample ?? [])
                .map((p) => p?.name)
                .filter((n) => typeof n === 'string' && n.length > 0);
        }
        return { status: 'up', players, online };
    } catch {
        return { status: 'down', players: [], online: 0 };
    }
}

async function pollMinecraftServers() {
    for (const watch of minecraftWatches.values()) {
        const label = `${watch.host}:${watch.port}`;
        const result = await checkMinecraftServer(watch);
        const current = result.status;
        console.log(`[mc-watch] ${label} poll=${current} last=${watch.lastStatus} online=${result.online}`);

        const channel = client.channels.cache.get(watch.channelId);

        if (watch.lastStatus === null) {
            watch.lastStatus = current;
            watch.lastPlayers = new Set(result.players);
            watch.lastOnlineCount = result.online;
            continue;
        }

        if (current !== watch.lastStatus) {
            watch.lastStatus = current;
            watch.lastPlayers = new Set(result.players);
            watch.lastOnlineCount = result.online;

            if (!channel) {
                console.error(`[mc-watch] Announcement channel ${watch.channelId} not found for ${label}.`);
                continue;
            }
            const content = current === 'up'
                ? `**${label}** is back **online**.`
                : `**${label}** has gone **offline**.`;
            console.log(`[mc-watch] Announcing ${current} for ${label} in channel ${watch.channelId}`);
            await channel.send({
                content,
                allowedMentions: { parse: [] },
            }).catch((e) => console.error(`[mc-watch] Failed to send announcement for ${label}:`, e));
            continue;
        }

        if (current !== 'up') continue;
        if (!channel) continue;

        const prevPlayers = watch.lastPlayers ?? new Set();
        const currPlayers = new Set(result.players);

        if (watch.edition !== 'bedrock' && (prevPlayers.size > 0 || currPlayers.size > 0)) {
            const joined = [...currPlayers].filter((n) => !prevPlayers.has(n));
            const left = [...prevPlayers].filter((n) => !currPlayers.has(n));
            for (const name of joined) {
                await channel.send({
                    content: `**${name}** joined **${label}**.`,
                    allowedMentions: { parse: [] },
                }).catch((e) => console.error(`[mc-watch] join announce failed:`, e));
            }
            for (const name of left) {
                await channel.send({
                    content: `**${name}** left **${label}**.`,
                    allowedMentions: { parse: [] },
                }).catch((e) => console.error(`[mc-watch] leave announce failed:`, e));
            }
        } else if (watch.edition === 'bedrock') {
            const delta = result.online - (watch.lastOnlineCount ?? 0);
            if (delta > 0) {
                await channel.send({
                    content: `**${label}**: ${delta} player${delta === 1 ? '' : 's'} joined (now ${result.online} online).`,
                    allowedMentions: { parse: [] },
                }).catch((e) => console.error(`[mc-watch] bedrock join announce failed:`, e));
            } else if (delta < 0) {
                const n = -delta;
                await channel.send({
                    content: `**${label}**: ${n} player${n === 1 ? '' : 's'} left (now ${result.online} online).`,
                    allowedMentions: { parse: [] },
                }).catch((e) => console.error(`[mc-watch] bedrock leave announce failed:`, e));
            }
        }

        watch.lastPlayers = currPlayers;
        watch.lastOnlineCount = result.online;
    }
}

function ampConfigured() {
    return Boolean(AMP_URL && AMP_USERNAME && AMP_PASSWORD);
}

async function ampLogin() {
    const res = await fetch(`${AMP_URL.replace(/\/$/, '')}/API/Core/Login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            username: AMP_USERNAME,
            password: AMP_PASSWORD,
            token: '',
            rememberMe: false,
        }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`AMP login HTTP ${res.status}: ${raw.slice(0, 200)}`);
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error(`AMP login returned non-JSON (wrong URL?): ${raw.slice(0, 200)}`);
    }
    if (!data.sessionID) {
        const reason = data.resultReason || (data.success === false ? 'credentials rejected' : JSON.stringify(data));
        throw new Error(`AMP login rejected: ${reason}`);
    }
    ampSessionId = data.sessionID;
    ampSessionExpiresAt = Date.now() + AMP_SESSION_TTL_MS;
}

async function ampCallRaw(endpoint, body = {}) {
    if (!ampConfigured()) throw new Error('AMP is not configured (set AMP_URL, AMP_USERNAME, AMP_PASSWORD).');
    if (!ampSessionId || Date.now() > ampSessionExpiresAt) await ampLogin();

    const url = `${AMP_URL.replace(/\/$/, '')}/API/${endpoint}`;
    const send = () => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ SESSIONID: ampSessionId, ...body }),
    });

    console.log(`[amp] -> ${endpoint}`);
    let res = await send();
    if (res.status === 401 || res.status === 403) {
        console.log(`[amp] ${endpoint} ${res.status}, re-authenticating`);
        await ampLogin();
        res = await send();
    }
    const text = await res.text();
    console.log(`[amp] <- ${endpoint} ${res.status} ${text.slice(0, 300)}`);
    if (!res.ok) throw new Error(`AMP ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
}

async function ampResolveInstance() {
    if (!AMP_INSTANCE) return null;
    if (ampResolvedInstanceId) return ampResolvedInstanceId;

    const data = await ampCallRaw('ADSModule/GetInstances');
    const targets = Array.isArray(data) ? data : (data.result ?? data.Result ?? []);
    const q = AMP_INSTANCE.toLowerCase();

    for (const target of targets) {
        const available = target.AvailableInstances ?? target.availableInstances ?? [];
        for (const inst of available) {
            const id = inst.InstanceID ?? inst.instanceID ?? inst.ID;
            const names = [id, inst.InstanceName, inst.FriendlyName, inst.instanceName, inst.friendlyName]
                .filter(Boolean)
                .map((s) => String(s).toLowerCase());
            if (names.includes(q) || (id && id.toLowerCase().startsWith(q))) {
                ampResolvedInstanceId = id;
                console.log(`Resolved AMP instance "${AMP_INSTANCE}" -> ${id}`);
                return id;
            }
        }
    }
    throw new Error(`AMP instance "${AMP_INSTANCE}" not found in ADS.`);
}

async function ampInstanceLogin(instanceId) {
    // Logs in on the instance (via ADS proxy) and stores the instance-scoped session.
    const loginPath = `ADSModule/Servers/${instanceId}/API/Core/Login`;
    const data = await ampCallRaw(loginPath, {
        username: AMP_USERNAME,
        password: AMP_PASSWORD,
        token: '',
        rememberMe: false,
    });
    if (!data.sessionID) {
        const reason = data.resultReason || (data.success === false ? 'credentials rejected on instance' : JSON.stringify(data).slice(0, 200));
        throw new Error(`AMP instance login rejected: ${reason}`);
    }
    ampInstanceSessionId = data.sessionID;
    ampInstanceSessionExpiresAt = Date.now() + AMP_SESSION_TTL_MS;
    ampInstanceSessionFor = instanceId;
    console.log(`[amp] instance session established for ${instanceId}`);
}

async function ampCall(endpoint, body = {}) {
    const instanceId = await ampResolveInstance();
    if (!instanceId) {
        return ampCallRaw(endpoint, body);
    }

    if (
        !ampInstanceSessionId ||
        ampInstanceSessionFor !== instanceId ||
        Date.now() > ampInstanceSessionExpiresAt
    ) {
        await ampInstanceLogin(instanceId);
    }

    const url = `${AMP_URL.replace(/\/$/, '')}/API/ADSModule/Servers/${instanceId}/API/${endpoint}`;
    const send = (sid) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ SESSIONID: sid, ...body }),
    });

    console.log(`[amp] -> ADSModule/Servers/${instanceId}/API/${endpoint}`);
    let res = await send(ampInstanceSessionId);
    if (res.status === 401 || res.status === 403) {
        console.log(`[amp] instance session stale, re-login`);
        await ampInstanceLogin(instanceId);
        res = await send(ampInstanceSessionId);
    }
    const text = await res.text();
    console.log(`[amp] <- ADSModule/Servers/${instanceId}/API/${endpoint} ${res.status} ${text.slice(0, 300)}`);
    if (!res.ok) throw new Error(`AMP ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
}

// --- Slash command definitions ---

const commands = [
    new SlashCommandBuilder()
        .setName('mute')
        .setDescription('Mute a user for a given duration.')
        .addUserOption((o) =>
            o.setName('user').setDescription('User to mute').setRequired(true)
        )
        .addStringOption((o) =>
            o.setName('duration').setDescription('Duration (e.g. 30s, 2m)').setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('unmute')
        .setDescription('Unmute a user immediately.')
        .addUserOption((o) =>
            o.setName('user').setDescription('User to unmute').setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('votemute')
        .setDescription('Start a vote-mute for a user.')
        .addUserOption((o) =>
            o.setName('user').setDescription('User to mute').setRequired(true)
        )
        .addStringOption((o) =>
            o.setName('duration').setDescription('Duration (e.g. 30s, 2m)').setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('russianroulette')
        .setDescription('Randomly mute someone in your voice channel.'),
    new SlashCommandBuilder()
        .setName('reactionrole')
        .setDescription('Set up a reaction role on a message.')
        .addChannelOption((o) =>
            o.setName('channel').setDescription('Channel the message is in').setRequired(true)
        )
        .addStringOption((o) =>
            o.setName('message_id').setDescription('The message ID').setRequired(true)
        )
        .addStringOption((o) =>
            o.setName('emoji').setDescription('Emoji to react with').setRequired(true)
        )
        .addRoleOption((o) =>
            o.setName('role').setDescription('Role to assign').setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('rolepanel')
        .setDescription('Send a reaction role panel message.')
        .addStringOption((o) =>
            o.setName('title').setDescription('Panel title').setRequired(true)
        )
        .addStringOption((o) =>
            o.setName('emoji1').setDescription('First emoji').setRequired(true)
        )
        .addRoleOption((o) =>
            o.setName('role1').setDescription('First role').setRequired(true)
        )
        .addStringOption((o) =>
            o.setName('emoji2').setDescription('Second emoji').setRequired(false)
        )
        .addRoleOption((o) =>
            o.setName('role2').setDescription('Second role').setRequired(false)
        )
        .addStringOption((o) =>
            o.setName('emoji3').setDescription('Third emoji').setRequired(false)
        )
        .addRoleOption((o) =>
            o.setName('role3').setDescription('Third role').setRequired(false)
        )
        .addStringOption((o) =>
            o.setName('emoji4').setDescription('Fourth emoji').setRequired(false)
        )
        .addRoleOption((o) =>
            o.setName('role4').setDescription('Fourth role').setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('removereactionrole')
        .setDescription('Remove a reaction role from a message.')
        .addStringOption((o) =>
            o.setName('message_id').setDescription('The message ID').setRequired(true)
        )
        .addStringOption((o) =>
            o.setName('emoji').setDescription('Emoji to remove').setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('minecraftwatch')
        .setDescription('Watch a Minecraft server and announce when it goes up or down.')
        .addSubcommand((sc) =>
            sc
                .setName('add')
                .setDescription('Start watching a Minecraft server.')
                .addStringOption((o) =>
                    o.setName('host').setDescription('Server host/IP').setRequired(true)
                )
                .addChannelOption((o) =>
                    o.setName('channel').setDescription('Channel for announcements').setRequired(true)
                )
                .addRoleOption((o) =>
                    o.setName('role').setDescription('Role to ping on status change').setRequired(true)
                )
                .addIntegerOption((o) =>
                    o.setName('port').setDescription('Port (default 25565 Java, 19132 Bedrock)')
                )
                .addStringOption((o) =>
                    o
                        .setName('edition')
                        .setDescription('Java or Bedrock (default Java)')
                        .addChoices(
                            { name: 'java', value: 'java' },
                            { name: 'bedrock', value: 'bedrock' }
                        )
                )
        )
        .addSubcommand((sc) =>
            sc
                .setName('remove')
                .setDescription('Stop watching a Minecraft server.')
                .addStringOption((o) =>
                    o.setName('host').setDescription('Server host/IP').setRequired(true)
                )
                .addIntegerOption((o) =>
                    o.setName('port').setDescription('Port (default matches edition)')
                )
                .addStringOption((o) =>
                    o
                        .setName('edition')
                        .setDescription('Java or Bedrock (default Java)')
                        .addChoices(
                            { name: 'java', value: 'java' },
                            { name: 'bedrock', value: 'bedrock' }
                        )
                )
        )
        .addSubcommand((sc) =>
            sc.setName('list').setDescription('List watched servers.')
        ),
    new SlashCommandBuilder()
        .setName('mcserver')
        .setDescription('Control the configured AMP Minecraft server.')
        .addSubcommand((sc) => sc.setName('start').setDescription('Start the server.'))
        .addSubcommand((sc) => sc.setName('stop').setDescription('Stop the server.'))
        .addSubcommand((sc) => sc.setName('restart').setDescription('Restart the server.'))
        .addSubcommand((sc) => sc.setName('status').setDescription('Check AMP-reported status.')),
    new SlashCommandBuilder()
        .setName('internships')
        .setDescription('Subscribe to DMs about new SimplifyJobs off-season internship listings.')
        .addSubcommand((sc) =>
            sc.setName('subscribe').setDescription('Get DMed when new internships are posted.')
        )
        .addSubcommand((sc) =>
            sc.setName('unsubscribe').setDescription('Stop receiving internship DMs.')
        )
        .addSubcommand((sc) =>
            sc.setName('status').setDescription('Show your subscription status.')
        ),
];

if (MUSIC_ENABLED) {
    commands.push(
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Play a song from a URL or search query (YouTube, SoundCloud, Spotify, etc).')
            .addStringOption((o) =>
                o.setName('query').setDescription('URL or search query').setRequired(true)
            ),
        new SlashCommandBuilder().setName('skip').setDescription('Skip the current song.'),
        new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue.'),
        new SlashCommandBuilder().setName('queue').setDescription('Show the song queue.'),
        new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing song.'),
        new SlashCommandBuilder().setName('pause').setDescription('Pause playback.'),
        new SlashCommandBuilder().setName('resume').setDescription('Resume playback.'),
        new SlashCommandBuilder()
            .setName('volume')
            .setDescription('Set playback volume (0-150).')
            .addIntegerOption((o) =>
                o
                    .setName('level')
                    .setDescription('Volume level (0-150)')
                    .setRequired(true)
                    .setMinValue(0)
                    .setMaxValue(150)
            ),
        new SlashCommandBuilder()
            .setName('shuffle')
            .setDescription('Shuffle the upcoming queue.'),
        new SlashCommandBuilder()
            .setName('loop')
            .setDescription('Set repeat mode for the player.')
            .addStringOption((o) =>
                o
                    .setName('mode')
                    .setDescription('Repeat mode')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Off', value: 'off' },
                        { name: 'Track', value: 'track' },
                        { name: 'Queue', value: 'queue' }
                    )
            ),
        new SlashCommandBuilder()
            .setName('remove')
            .setDescription('Remove a track from the queue.')
            .addIntegerOption((o) =>
                o
                    .setName('position')
                    .setDescription('Queue position (1 = next up)')
                    .setRequired(true)
                    .setMinValue(1)
            ),
        new SlashCommandBuilder()
            .setName('clear')
            .setDescription('Clear the upcoming queue (keeps the current track).'),
        new SlashCommandBuilder()
            .setName('seek')
            .setDescription('Seek to a position in the current track.')
            .addIntegerOption((o) =>
                o
                    .setName('seconds')
                    .setDescription('Position in seconds from the start')
                    .setRequired(true)
                    .setMinValue(0)
            )
    );
}

const MUSIC_COMMANDS = new Set([
    'play',
    'skip',
    'stop',
    'queue',
    'nowplaying',
    'pause',
    'resume',
    'volume',
    'shuffle',
    'loop',
    'remove',
    'clear',
    'seek',
]);

async function handleMusicCommand(interaction) {
    const { commandName } = interaction;

    if (commandName === 'play') {
        const vc = interaction.member?.voice?.channel;
        if (!vc) {
            return interaction.reply({
                content: 'Join a voice channel first.',
                flags: MessageFlags.Ephemeral,
            });
        }
        const me = interaction.guild.members.me;
        const perms = vc.permissionsFor(me);
        if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
            return interaction.reply({
                content: 'I need Connect and Speak permission in your voice channel.',
                flags: MessageFlags.Ephemeral,
            });
        }
        const query = interaction.options.getString('query').trim();
        await interaction.deferReply();

        let player = lavalink.getPlayer(interaction.guildId);
        if (!player) {
            player = lavalink.createPlayer({
                guildId: interaction.guildId,
                voiceChannelId: vc.id,
                textChannelId: interaction.channelId,
                selfDeaf: true,
                volume: musicVolumes.get(interaction.guildId) ?? DEFAULT_MUSIC_VOLUME,
            });
        }
        if (!player.connected) await player.connect();

        if (isSpotifyUrl(query)) {
            await queueSpotifyUrl(player, query, interaction);
            return;
        }

        const isUrl = /^https?:\/\//i.test(query);
        const searchOptions = isUrl ? { query } : { query, source: 'ytmsearch' };

        let res;
        try {
            res = await player.search(searchOptions, interaction.user);
        } catch (e) {
            console.error('[lavalink] search failed:', e);
            return interaction.editReply(`Search failed: ${e.message}`);
        }

        if (!res || !res.tracks?.length) {
            return interaction.editReply('No results found.');
        }

        const wasPlayingOrPaused = player.playing || player.paused;
        if (res.loadType === 'playlist') {
            await player.queue.add(res.tracks);
            await interaction.editReply(
                `Queued **${res.tracks.length}** tracks from **${res.playlist?.name ?? 'playlist'}**.`
            );
        } else {
            await player.queue.add(res.tracks[0]);
            await interaction.editReply(`Queued: **${res.tracks[0].info.title}**`);
        }

        if (!player.playing && !player.paused) await player.play();
        if (wasPlayingOrPaused) {
            await renderNowPlaying(player).catch(() => {});
        }
        return;
    }

    const player = lavalink.getPlayer(interaction.guildId);
    if (!player) {
        return interaction.reply({
            content: 'Nothing is playing.',
            flags: MessageFlags.Ephemeral,
        });
    }

    if (commandName === 'skip') {
        if (!player.queue.current) {
            return interaction.reply({ content: 'Nothing to skip.', flags: MessageFlags.Ephemeral });
        }
        await player.skip();
        return interaction.reply({ content: 'Skipped.', flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'stop') {
        await player.destroy();
        return interaction.reply('Stopped playback and cleared the queue.');
    }

    if (commandName === 'queue') {
        const current = player.queue.current;
        const upcoming = player.queue.tracks.slice(0, 10);
        const lines = [];
        lines.push(current ? `**Now playing:** ${current.info.title}` : 'Nothing playing.');
        if (player.repeatMode && player.repeatMode !== 'off') {
            lines.push(`*Repeat:* \`${player.repeatMode}\``);
        }
        if (upcoming.length) {
            lines.push('', '**Up next:**');
            upcoming.forEach((t, i) => lines.push(`${i + 1}. ${t.info.title}`));
            if (player.queue.tracks.length > 10) {
                lines.push(`...and ${player.queue.tracks.length - 10} more.`);
            }
        }
        return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'nowplaying') {
        const t = player.queue.current;
        if (!t) {
            return interaction.reply({ content: 'Nothing playing.', flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({
            content: `**${t.info.title}** — ${t.info.author}\n${t.info.uri}`,
            flags: MessageFlags.Ephemeral,
        });
    }

    if (commandName === 'pause') {
        if (player.paused) {
            return interaction.reply({ content: 'Already paused.', flags: MessageFlags.Ephemeral });
        }
        await player.pause();
        await renderNowPlaying(player).catch(() => {});
        return interaction.reply({ content: 'Paused.', flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'resume') {
        if (!player.paused) {
            return interaction.reply({ content: 'Not paused.', flags: MessageFlags.Ephemeral });
        }
        await player.resume();
        await renderNowPlaying(player).catch(() => {});
        return interaction.reply({ content: 'Resumed.', flags: MessageFlags.Ephemeral });
    }

    if (commandName === 'volume') {
        const level = interaction.options.getInteger('level');
        await player.setVolume(level);
        setStoredVolume(interaction.guildId, level);
        await renderNowPlaying(player).catch(() => {});
        return interaction.reply({
            content: `Volume set to **${level}**.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    if (commandName === 'shuffle') {
        if (player.queue.tracks.length < 2) {
            return interaction.reply({
                content: 'Need at least 2 tracks in the queue to shuffle.',
                flags: MessageFlags.Ephemeral,
            });
        }
        await player.queue.shuffle();
        await renderNowPlaying(player).catch(() => {});
        return interaction.reply(`Shuffled **${player.queue.tracks.length}** tracks.`);
    }

    if (commandName === 'loop') {
        const mode = interaction.options.getString('mode');
        await player.setRepeatMode(mode);
        await renderNowPlaying(player).catch(() => {});
        return interaction.reply(`Repeat mode set to \`${mode}\`.`);
    }

    if (commandName === 'remove') {
        const position = interaction.options.getInteger('position');
        if (position > player.queue.tracks.length) {
            return interaction.reply({
                content: `Queue only has ${player.queue.tracks.length} track(s).`,
                flags: MessageFlags.Ephemeral,
            });
        }
        const idx = position - 1;
        const removed = player.queue.tracks[idx];
        await player.queue.remove(idx);
        await renderNowPlaying(player).catch(() => {});
        return interaction.reply(`Removed: **${removed.info.title}**`);
    }

    if (commandName === 'clear') {
        const count = player.queue.tracks.length;
        if (!count) {
            return interaction.reply({
                content: 'Queue is already empty.',
                flags: MessageFlags.Ephemeral,
            });
        }
        await player.queue.splice(0, count);
        await renderNowPlaying(player).catch(() => {});
        return interaction.reply(`Cleared **${count}** track(s) from the queue.`);
    }

    if (commandName === 'seek') {
        const current = player.queue.current;
        if (!current) {
            return interaction.reply({
                content: 'Nothing playing to seek.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (!current.info.isSeekable) {
            return interaction.reply({
                content: 'This track is not seekable (e.g. a livestream).',
                flags: MessageFlags.Ephemeral,
            });
        }
        const seconds = interaction.options.getInteger('seconds');
        const ms = seconds * 1000;
        if (ms > current.info.duration) {
            return interaction.reply({
                content: `Position is past track duration (${Math.floor(current.info.duration / 1000)}s).`,
                flags: MessageFlags.Ephemeral,
            });
        }
        await player.seek(ms);
        return interaction.reply({
            content: `Seeked to **${seconds}s**.`,
            flags: MessageFlags.Ephemeral,
        });
    }
}

// --- Events ---

client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);
    try {
        const rest = new REST().setToken(TOKEN);
        const synced = await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands.map((c) => c.toJSON()) }
        );
        console.log(`Synced ${synced.length} commands.`);
    } catch (e) {
        console.error('Error syncing commands:', e);
    }
    const total = client.guilds.cache.reduce((sum, g) => sum + (g.memberCount ?? 0), 0);
    client.user.setActivity(`with ${total} members`, { type: ActivityType.Playing });

    setTimeout(pollMinecraftServers, 5_000);
    setInterval(pollMinecraftServers, MINECRAFT_POLL_INTERVAL_MS);

    setTimeout(pollInternships, INTERNSHIP_FIRST_POLL_DELAY_MS);
    setInterval(pollInternships, INTERNSHIP_POLL_INTERVAL_MS);

    if (MUSIC_ENABLED) {
        try {
            await lavalink.init({ id: client.user.id, username: client.user.username });
            console.log('[lavalink] manager initialized');
        } catch (e) {
            console.error('[lavalink] init failed:', e?.message ?? e);
        }
    }
});

async function handleMusicButton(interaction) {
    if (!MUSIC_ENABLED) {
        return interaction.reply({
            content: 'Music is not enabled.',
            flags: MessageFlags.Ephemeral,
        });
    }
    const player = lavalink.getPlayer(interaction.guildId);
    if (!player) {
        return interaction.reply({
            content: 'Nothing is playing.',
            flags: MessageFlags.Ephemeral,
        });
    }
    const memberVc = interaction.member?.voice?.channelId;
    if (!memberVc || memberVc !== player.voiceChannelId) {
        return interaction.reply({
            content: 'Join the bot\'s voice channel to control playback.',
            flags: MessageFlags.Ephemeral,
        });
    }

    const action = interaction.customId.split(':')[1];
    const current = player.queue?.current;

    try {
        switch (action) {
            case 'pause':
                if (!player.paused) await player.pause();
                break;
            case 'resume':
                if (player.paused) await player.resume();
                break;
            case 'skip':
                if (current) await player.skip();
                break;
            case 'back': {
                const prev = await player.queue.shiftPrevious().catch(() => null);
                if (!prev) {
                    return interaction.reply({
                        content: 'No previous track.',
                        flags: MessageFlags.Ephemeral,
                    });
                }
                if (current) {
                    await player.queue.add(current, 0);
                }
                await player.play({ clientTrack: prev });
                break;
            }
            case 'rewind': {
                if (!current?.info?.isSeekable) {
                    return interaction.reply({
                        content: 'This track is not seekable.',
                        flags: MessageFlags.Ephemeral,
                    });
                }
                const target = Math.max(0, (player.position ?? 0) - SEEK_STEP_MS);
                await player.seek(target);
                break;
            }
            case 'forward': {
                if (!current?.info?.isSeekable) {
                    return interaction.reply({
                        content: 'This track is not seekable.',
                        flags: MessageFlags.Ephemeral,
                    });
                }
                const duration = current.info.duration ?? 0;
                const target = (player.position ?? 0) + SEEK_STEP_MS;
                if (target >= duration) {
                    await player.skip();
                } else {
                    await player.seek(target);
                }
                break;
            }
            case 'shuffle':
                if ((player.queue?.tracks?.length ?? 0) < 2) {
                    return interaction.reply({
                        content: 'Need at least 2 tracks to shuffle.',
                        flags: MessageFlags.Ephemeral,
                    });
                }
                await player.queue.shuffle();
                break;
            case 'loop': {
                const next = REPEAT_NEXT[player.repeatMode || 'off'] || 'off';
                await player.setRepeatMode(next);
                break;
            }
            case 'stop':
                await clearNowPlaying(player);
                await player.destroy();
                return interaction.reply({
                    content: 'Stopped playback and cleared the queue.',
                    flags: MessageFlags.Ephemeral,
                });
            default:
                return interaction.reply({
                    content: 'Unknown action.',
                    flags: MessageFlags.Ephemeral,
                });
        }
    } catch (e) {
        console.error(`[lavalink] button ${action} failed:`, e?.message ?? e);
        return interaction.reply({
            content: `Error: ${e.message}`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const payload = buildNowPlayingPayload(player);
    if (payload) {
        try {
            await interaction.update(payload);
            nowPlayingMessages.set(player.guildId, {
                channelId: interaction.channelId,
                messageId: interaction.message.id,
            });
            return;
        } catch {}
    }
    if (!interaction.replied && !interaction.deferred) {
        await interaction.deferUpdate().catch(() => {});
    }
}

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith('music:')) {
        try {
            return await handleMusicButton(interaction);
        } catch (e) {
            console.error('[lavalink] music button failed:', e);
            if (!interaction.replied && !interaction.deferred) {
                return interaction
                    .reply({ content: `Error: ${e.message}`, flags: MessageFlags.Ephemeral })
                    .catch(() => {});
            }
        }
        return;
    }
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    // ---- music commands ----
    if (MUSIC_ENABLED && MUSIC_COMMANDS.has(commandName)) {
        try {
            return await handleMusicCommand(interaction);
        } catch (e) {
            console.error(`[lavalink] /${commandName} failed:`, e);
            const msg = `Error: ${e.message}`;
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(msg).catch(() => {});
            }
            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }

    // ---- /mute ----
    if (commandName === 'mute') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.MuteMembers))
            return interaction.reply({ content: 'Insufficient permissions.', flags: MessageFlags.Ephemeral });
        const target = interaction.options.getMember('user');
        if (!target?.voice?.channel)
            return interaction.reply({
                content: `${target?.displayName ?? 'User'} is not in voice.`,
                flags: MessageFlags.Ephemeral,
            });
        const secs = parseDuration(interaction.options.getString('duration'));
        if (secs === null)
            return interaction.reply({ content: 'Invalid duration format.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply();
        await addMute(target, secs, interaction.channel);
        const msg = await interaction.followUp(`Muted ${target.displayName} for ${secs}s.`);
        setTimeout(() => msg.delete().catch(() => {}), 10_000);
    }

    // ---- /unmute ----
    else if (commandName === 'unmute') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.MuteMembers))
            return interaction.reply({ content: 'Insufficient permissions.', flags: MessageFlags.Ephemeral });
        const target = interaction.options.getMember('user');
        if (!target?.voice?.channel)
            return interaction.reply({
                content: `${target?.displayName ?? 'User'} is not in voice.`,
                flags: MessageFlags.Ephemeral,
            });
        const timer = muteTimers.get(target.id);
        if (timer) clearTimeout(timer);
        muteTimers.delete(target.id);
        muteEndTimes.delete(target.id);
        muteStartTimes.delete(target.id);
        try {
            await target.voice.setMute(false);
            const msg = await interaction.reply({
                content: `${target.displayName} has been unmuted.`,
                fetchReply: true,
            });
            setTimeout(() => msg.delete().catch(() => {}), 10_000);
        } catch {
            await interaction.reply({ content: 'I cannot unmute that user.', flags: MessageFlags.Ephemeral });
        }
    }

    // ---- /votemute ----
    else if (commandName === 'votemute') {
        const target = interaction.options.getMember('user');
        if (!target?.voice?.channel)
            return interaction.reply({
                content: `${target?.displayName ?? 'User'} is not in voice.`,
                flags: MessageFlags.Ephemeral,
            });
        const secs = parseDuration(interaction.options.getString('duration'));
        if (secs === null)
            return interaction.reply({ content: 'Invalid duration format.', flags: MessageFlags.Ephemeral });
        await interaction.reply({ content: 'Vote started!', flags: MessageFlags.Ephemeral });
        const voteMsg = await interaction.channel.send(
            `Vote to mute ${target} for ${secs}s! React with <:${CUSTOM_EMOJI_NAME}:${CUSTOM_EMOJI_ID}>`
        );
        await voteMsg.react(`${CUSTOM_EMOJI_NAME}:${CUSTOM_EMOJI_ID}`);
        voteMuteMessages.set(voteMsg.id, {
            targetId: target.id,
            duration: secs,
            votes: new Set(),
        });
    }

    // ---- /russianroulette ----
    else if (commandName === 'russianroulette') {
        const uid = interaction.user.id;
        const now = Date.now() / 1000;
        const lastUsed = russianRouletteCooldowns.get(uid) ?? 0;
        if (now - lastUsed < RUSSIAN_ROULETTE_COOLDOWN) {
            const rem = Math.ceil(RUSSIAN_ROULETTE_COOLDOWN - (now - lastUsed));
            return interaction.reply({ content: `On cooldown: ${rem}s left.`, flags: MessageFlags.Ephemeral });
        }
        russianRouletteCooldowns.set(uid, now);
        const vc = interaction.member?.voice?.channel;
        if (!vc)
            return interaction.reply({
                content: 'Join a voice channel first.',
                flags: MessageFlags.Ephemeral,
            });
        const members = vc.members.filter((m) => !m.user.bot);
        if (members.size === 0)
            return interaction.reply({
                content: 'No eligible members found.',
                flags: MessageFlags.Ephemeral,
            });
        await interaction.deferReply();
        const arr = [...members.values()];
        const idx = await getTrueRandomInt(0, arr.length - 1);
        const target = arr[idx];
        const dur = await getTrueRandomInt(10, 60);
        await addMute(target, dur, interaction.channel);
        const msg = await interaction.followUp(
            `Russian Roulette! ${target} muted for ${dur}s.`
        );
        setTimeout(() => msg.delete().catch(() => {}), (dur + 5) * 1000);
    }

    // ---- /reactionrole ----
    else if (commandName === 'reactionrole') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles))
            return interaction.reply({
                content: 'You need Manage Roles permission.',
                flags: MessageFlags.Ephemeral,
            });
        const channel = interaction.options.getChannel('channel');
        const messageId = interaction.options.getString('message_id');
        const emojiStr = interaction.options.getString('emoji');
        const role = interaction.options.getRole('role');

        let msg;
        try {
            msg = await channel.messages.fetch(messageId);
        } catch {
            return interaction.reply({
                content: 'Message not found in that channel.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const customMatch = emojiStr.match(/<a?:(\w+):(\d+)>/);
        const reactEmoji = customMatch
            ? `${customMatch[1]}:${customMatch[2]}`
            : emojiStr;
        const key = customMatch ? customMatch[2] : emojiStr;

        if (!reactionRoles.has(messageId))
            reactionRoles.set(messageId, new Map());
        reactionRoles.get(messageId).set(key, role.id);
        saveReactionRoles();

        try {
            await msg.react(reactEmoji);
        } catch {
            return interaction.reply({
                content: 'Failed to react. Check the emoji is valid and I have access.',
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.reply({
            content: `Reaction role set! Reacting with ${emojiStr} grants ${role}.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    // ---- /rolepanel ----
    else if (commandName === 'rolepanel') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles))
            return interaction.reply({
                content: 'You need Manage Roles permission.',
                flags: MessageFlags.Ephemeral,
            });

        const title = interaction.options.getString('title');
        const pairs = [];
        for (let i = 1; i <= 4; i++) {
            const emojiStr = interaction.options.getString(`emoji${i}`);
            const role = interaction.options.getRole(`role${i}`);
            if (emojiStr && role) pairs.push({ emojiStr, role });
        }
        if (pairs.length === 0)
            return interaction.reply({
                content: 'Provide at least one emoji and role pair.',
                flags: MessageFlags.Ephemeral,
            });

        const lines = pairs.map((p) => `${p.emojiStr} — ${p.role.name}`);
        const body = `**${title}**\n\n${lines.join('\n')}`;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const panelMsg = await interaction.channel.send({ content: body, allowedMentions: { parse: [] } });

        if (!reactionRoles.has(panelMsg.id))
            reactionRoles.set(panelMsg.id, new Map());
        const rr = reactionRoles.get(panelMsg.id);

        for (const p of pairs) {
            const customMatch = p.emojiStr.match(/<a?:(\w+):(\d+)>/);
            const reactEmoji = customMatch
                ? `${customMatch[1]}:${customMatch[2]}`
                : p.emojiStr;
            const key = customMatch ? customMatch[2] : p.emojiStr;
            rr.set(key, p.role.id);
            await panelMsg.react(reactEmoji).catch(() => {});
        }
        saveReactionRoles();

        await interaction.followUp({
            content: 'Role panel sent!',
            flags: MessageFlags.Ephemeral,
        });
    }

    // ---- /minecraftwatch ----
    else if (commandName === 'minecraftwatch') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
            return interaction.reply({
                content: 'You need Manage Server permission.',
                flags: MessageFlags.Ephemeral,
            });
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const host = interaction.options.getString('host').trim();
            const edition = interaction.options.getString('edition') ?? 'java';
            const port =
                interaction.options.getInteger('port') ??
                (edition === 'bedrock' ? 19132 : 25565);
            const channel = interaction.options.getChannel('channel');
            const role = interaction.options.getRole('role');
            const key = minecraftWatchKey(host, port, edition);
            minecraftWatches.set(key, {
                host,
                port,
                edition,
                channelId: channel.id,
                roleId: role.id,
                lastStatus: null,
                pendingCount: 0,
                lastPlayers: new Set(),
                lastOnlineCount: 0,
            });
            saveMinecraftWatches();
            return interaction.reply({
                content: `Watching \`${host}:${port}\` (${edition}). Announcements in ${channel} pinging ${role}.`,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }

        if (sub === 'remove') {
            const host = interaction.options.getString('host').trim();
            const edition = interaction.options.getString('edition') ?? 'java';
            const port =
                interaction.options.getInteger('port') ??
                (edition === 'bedrock' ? 19132 : 25565);
            const key = minecraftWatchKey(host, port, edition);
            if (!minecraftWatches.has(key))
                return interaction.reply({
                    content: 'No matching watch found.',
                    flags: MessageFlags.Ephemeral,
                });
            minecraftWatches.delete(key);
            saveMinecraftWatches();
            return interaction.reply({
                content: `Stopped watching \`${host}:${port}\` (${edition}).`,
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === 'list') {
            if (minecraftWatches.size === 0)
                return interaction.reply({
                    content: 'No servers are being watched.',
                    flags: MessageFlags.Ephemeral,
                });
            const lines = [...minecraftWatches.values()].map((w) => {
                const s = w.lastStatus ?? 'unknown';
                return `• \`${w.host}:${w.port}\` (${w.edition}) → <#${w.channelId}>, pings <@&${w.roleId}> — ${s}`;
            });
            return interaction.reply({
                content: lines.join('\n'),
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }
    }

    // ---- /mcserver ----
    else if (commandName === 'mcserver') {
        const sub = interaction.options.getSubcommand();
        if (sub !== 'status') {
            const hasMinecraftRole = interaction.member.roles.cache.some(
                (r) => r.name.toLowerCase() === 'minecraft'
            );
            if (!hasMinecraftRole)
                return interaction.reply({
                    content: 'You need the **minecraft** role to use this command.',
                    flags: MessageFlags.Ephemeral,
                });
        }
        if (!ampConfigured())
            return interaction.reply({
                content: 'AMP is not configured. Set `AMP_URL`, `AMP_USERNAME`, and `AMP_PASSWORD` env vars.',
                flags: MessageFlags.Ephemeral,
            });

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const endpointMap = {
            start: 'Core/Start',
            stop: 'Core/Stop',
            restart: 'Core/Restart',
            status: 'Core/GetStatus',
        };
        const endpoint = endpointMap[sub];

        try {
            const result = await ampCall(endpoint);
            if (sub === 'status') {
                const stateCode = result?.State;
                const stateName = AMP_STATE_NAMES[stateCode] ?? `Unknown (${stateCode})`;
                const players = result?.Metrics?.['Active Users'];
                const playerStr = players
                    ? ` — players: ${players.RawValue}/${players.MaxValue}`
                    : '';
                return interaction.editReply(`AMP status: **${stateName}**${playerStr}`);
            }
            return interaction.editReply(
                `Sent \`${sub}\` to AMP. It may take a moment to take effect.`
            );
        } catch (e) {
            console.error(`AMP ${sub} failed:`, e);
            return interaction.editReply(`AMP request failed: ${e.message}`);
        }
    }

    // ---- /internships ----
    else if (commandName === 'internships') {
        const sub = interaction.options.getSubcommand();
        const userId = interaction.user.id;
        if (sub === 'subscribe') {
            if (internshipSubs.has(userId))
                return interaction.reply({
                    content: 'You are already subscribed to internship DMs.',
                    flags: MessageFlags.Ephemeral,
                });
            try {
                const user = await client.users.fetch(userId);
                await user.send(
                    `:white_check_mark: You're subscribed to new SimplifyJobs off-season internship listings. I'll DM you here when new ones are posted. Use \`/internships unsubscribe\` to stop.\nSource: <${INTERNSHIP_SOURCE_URL}>`
                );
            } catch {
                return interaction.reply({
                    content:
                        "I couldn't DM you — please enable DMs from server members and try again.",
                    flags: MessageFlags.Ephemeral,
                });
            }
            internshipSubs.add(userId);
            saveInternshipSubs();
            return interaction.reply({
                content: 'Subscribed! Check your DMs for confirmation.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (sub === 'unsubscribe') {
            if (!internshipSubs.has(userId))
                return interaction.reply({
                    content: 'You are not subscribed.',
                    flags: MessageFlags.Ephemeral,
                });
            internshipSubs.delete(userId);
            saveInternshipSubs();
            return interaction.reply({
                content: 'Unsubscribed. You will no longer get internship DMs.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (sub === 'status') {
            const subscribed = internshipSubs.has(userId);
            return interaction.reply({
                content: subscribed
                    ? `You are subscribed. Tracking ${internshipSeen.size} listing(s).`
                    : 'You are not subscribed. Use `/internships subscribe` to start.',
                flags: MessageFlags.Ephemeral,
            });
        }
    }

    // ---- /removereactionrole ----
    else if (commandName === 'removereactionrole') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles))
            return interaction.reply({
                content: 'You need Manage Roles permission.',
                flags: MessageFlags.Ephemeral,
            });
        const messageId = interaction.options.getString('message_id');
        const emojiStr = interaction.options.getString('emoji');
        const rr = reactionRoles.get(messageId);
        if (!rr)
            return interaction.reply({
                content: 'No reaction roles on that message.',
                flags: MessageFlags.Ephemeral,
            });
        const customMatch = emojiStr.match(/<a?:(\w+):(\d+)>/);
        const key = customMatch ? customMatch[2] : emojiStr;
        if (!rr.has(key))
            return interaction.reply({
                content: 'That emoji has no reaction role on that message.',
                flags: MessageFlags.Ephemeral,
            });
        rr.delete(key);
        if (rr.size === 0) reactionRoles.delete(messageId);
        saveReactionRoles();
        await interaction.reply({ content: 'Reaction role removed.', flags: MessageFlags.Ephemeral });
    }
});

// --- Reaction handlers ---

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => {});
    if (reaction.message.partial) await reaction.message.fetch().catch(() => {});

    console.log(`[ReactionAdd] emoji=${reaction.emoji.name}(${reaction.emoji.id}) msgId=${reaction.message.id} user=${user.tag}`);

    // Vote mute
    const vm = voteMuteMessages.get(reaction.message.id);
    if (vm && reaction.emoji.id === CUSTOM_EMOJI_ID) {
        const guild = reaction.message.guild;
        const target = guild.members.cache.get(vm.targetId);
        const voter = guild.members.cache.get(user.id);
        if (
            !target?.voice?.channel ||
            !voter?.voice?.channel ||
            voter.voice.channelId !== target.voice.channelId
        )
            return;
        vm.votes.add(user.id);
        const channelMembers = target.voice.channel.members.filter(
            (m) => !m.user.bot && m.id !== target.id
        );
        const needed = Math.floor(channelMembers.size / 2) + 1;
        const valid = [...vm.votes].filter((id) => channelMembers.has(id)).length;
        if (valid >= needed) {
            await addMute(target, vm.duration, reaction.message.channel);
            const msg = await reaction.message.channel.send(
                `${target.displayName} has been muted for ${vm.duration} seconds by vote!`
            );
            setTimeout(() => msg.delete().catch(() => {}), (vm.duration + 5) * 1000);
            voteMuteMessages.delete(reaction.message.id);
        }
        return;
    }

    // Reaction roles
    const rr = reactionRoles.get(reaction.message.id);
    if (!rr) {
        console.log(`[ReactionAdd] No reaction roles found for message ${reaction.message.id}. Known messages: [${[...reactionRoles.keys()].join(', ')}]`);
        return;
    }
    const key = reaction.emoji.id ?? reaction.emoji.name;
    const roleId = rr.get(key);
    if (!roleId) {
        console.log(`[ReactionAdd] No role for key "${key}" on message ${reaction.message.id}. Known keys: [${[...rr.keys()].join(', ')}]`);
        return;
    }
    const guild = reaction.message.guild;
    if (!guild) {
        console.log(`[ReactionAdd] No guild found on message`);
        return;
    }
    const member =
        guild.members.cache.get(user.id) ??
        (await guild.members.fetch(user.id).catch(() => null));
    const role = guild.roles.cache.get(roleId);
    if (member && role) {
        console.log(`[ReactionAdd] Adding role "${role.name}" to ${member.user?.tag ?? member.id}`);
        await member.roles.add(role).catch((err) => {
            console.error(
                `Failed to add role "${role.name}" (${role.id}) to ${member.user?.tag ?? member.id} in guild ${guild.name}:`,
                err.message
            );
        });
    } else if (!role) {
        console.error(`Reaction role refers to missing role ${roleId} on message ${reaction.message.id}.`);
    } else if (!member) {
        console.error(`[ReactionAdd] Could not resolve member ${user.id}`);
    }
});

client.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => {});
    if (reaction.message.partial) await reaction.message.fetch().catch(() => {});

    // Vote mute
    const vm = voteMuteMessages.get(reaction.message.id);
    if (vm && reaction.emoji.id === CUSTOM_EMOJI_ID) {
        vm.votes.delete(user.id);
        return;
    }

    // Reaction roles
    const rr = reactionRoles.get(reaction.message.id);
    if (!rr) return;
    const key = reaction.emoji.id ?? reaction.emoji.name;
    const roleId = rr.get(key);
    if (!roleId) return;
    const guild = reaction.message.guild;
    if (!guild) return;
    const member =
        guild.members.cache.get(user.id) ??
        (await guild.members.fetch(user.id).catch(() => null));
    const role = guild.roles.cache.get(roleId);
    if (member && role) {
        await member.roles.remove(role).catch((err) => {
            console.error(
                `Failed to remove role "${role.name}" (${role.id}) from ${member.user?.tag ?? member.id} in guild ${guild.name}:`,
                err.message
            );
        });
    }
});

process.on('SIGTERM', () => { client.destroy(); process.exit(0); });
process.on('SIGINT', () => { client.destroy(); process.exit(0); });

loadReactionRoles();
loadMinecraftWatches();
loadMusicVolumes();
loadInternshipSubs();
loadInternshipSeen();
client.login(TOKEN);
