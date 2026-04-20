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
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { status: mcStatus, statusBedrock: mcStatusBedrock } = require('minecraft-server-util');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
    console.error('Missing BOT_TOKEN environment variable.');
    process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || '/data';
const REACTION_ROLES_FILE = path.join(DATA_DIR, 'reaction_roles.json');
const MINECRAFT_WATCHES_FILE = path.join(DATA_DIR, 'minecraft_watches.json');

const MINECRAFT_POLL_INTERVAL_MS = 15_000;
const MINECRAFT_PING_TIMEOUT_MS = 5_000;

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

// --- State ---
const muteEndTimes = new Map();
const muteStartTimes = new Map();
const muteTimers = new Map();
const voteMuteMessages = new Map();
const russianRouletteCooldowns = new Map();
const reactionRoles = new Map(); // messageId -> Map(emojiKey -> roleId)
const minecraftWatches = new Map(); // key -> { host, port, edition, channelId, roleId, lastStatus, pendingCount }

let ampSessionId = null;
let ampSessionExpiresAt = 0;
let ampResolvedInstanceId = null;

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

async function checkMinecraftServer(watch) {
    try {
        if (watch.edition === 'bedrock') {
            await mcStatusBedrock(watch.host, watch.port, { timeout: MINECRAFT_PING_TIMEOUT_MS });
        } else {
            await mcStatus(watch.host, watch.port, { timeout: MINECRAFT_PING_TIMEOUT_MS });
        }
        return 'up';
    } catch {
        return 'down';
    }
}

async function pollMinecraftServers() {
    for (const watch of minecraftWatches.values()) {
        const label = `${watch.host}:${watch.port}`;
        const current = await checkMinecraftServer(watch);
        console.log(`[mc-watch] ${label} poll=${current} last=${watch.lastStatus}`);

        if (watch.lastStatus === null) {
            watch.lastStatus = current;
            continue;
        }
        if (current === watch.lastStatus) continue;

        watch.lastStatus = current;

        const channel = client.channels.cache.get(watch.channelId);
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

async function ampCall(endpoint, body = {}) {
    const instanceId = await ampResolveInstance();
    const routed = instanceId ? `ADSModule/Servers/${instanceId}/API/${endpoint}` : endpoint;
    return ampCallRaw(routed, body);
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
];

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
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

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
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
            return interaction.reply({
                content: 'You need Manage Server permission.',
                flags: MessageFlags.Ephemeral,
            });
        if (!ampConfigured())
            return interaction.reply({
                content: 'AMP is not configured. Set `AMP_URL`, `AMP_USERNAME`, and `AMP_PASSWORD` env vars.',
                flags: MessageFlags.Ephemeral,
            });

        const sub = interaction.options.getSubcommand();
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
client.login(TOKEN);
