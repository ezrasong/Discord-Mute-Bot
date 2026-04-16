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
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
    console.error('Missing BOT_TOKEN environment variable.');
    process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || '/data';
const REACTION_ROLES_FILE = path.join(DATA_DIR, 'reaction_roles.json');

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
];

// --- Events ---

client.once('ready', async () => {
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
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    // ---- /mute ----
    if (commandName === 'mute') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.MuteMembers))
            return interaction.reply({ content: 'Insufficient permissions.', ephemeral: true });
        const target = interaction.options.getMember('user');
        if (!target?.voice?.channel)
            return interaction.reply({
                content: `${target?.displayName ?? 'User'} is not in voice.`,
                ephemeral: true,
            });
        const secs = parseDuration(interaction.options.getString('duration'));
        if (secs === null)
            return interaction.reply({ content: 'Invalid duration format.', ephemeral: true });
        await interaction.deferReply();
        await addMute(target, secs, interaction.channel);
        const msg = await interaction.followUp(`Muted ${target.displayName} for ${secs}s.`);
        setTimeout(() => msg.delete().catch(() => {}), 10_000);
    }

    // ---- /unmute ----
    else if (commandName === 'unmute') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.MuteMembers))
            return interaction.reply({ content: 'Insufficient permissions.', ephemeral: true });
        const target = interaction.options.getMember('user');
        if (!target?.voice?.channel)
            return interaction.reply({
                content: `${target?.displayName ?? 'User'} is not in voice.`,
                ephemeral: true,
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
            await interaction.reply({ content: 'I cannot unmute that user.', ephemeral: true });
        }
    }

    // ---- /votemute ----
    else if (commandName === 'votemute') {
        const target = interaction.options.getMember('user');
        if (!target?.voice?.channel)
            return interaction.reply({
                content: `${target?.displayName ?? 'User'} is not in voice.`,
                ephemeral: true,
            });
        const secs = parseDuration(interaction.options.getString('duration'));
        if (secs === null)
            return interaction.reply({ content: 'Invalid duration format.', ephemeral: true });
        await interaction.reply({ content: 'Vote started!', ephemeral: true });
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
            return interaction.reply({ content: `On cooldown: ${rem}s left.`, ephemeral: true });
        }
        russianRouletteCooldowns.set(uid, now);
        const vc = interaction.member?.voice?.channel;
        if (!vc)
            return interaction.reply({
                content: 'Join a voice channel first.',
                ephemeral: true,
            });
        const members = vc.members.filter((m) => !m.user.bot);
        if (members.size === 0)
            return interaction.reply({
                content: 'No eligible members found.',
                ephemeral: true,
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
                ephemeral: true,
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
                ephemeral: true,
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
                ephemeral: true,
            });
        }

        await interaction.reply({
            content: `Reaction role set! Reacting with ${emojiStr} grants ${role}.`,
            ephemeral: true,
        });
    }

    // ---- /rolepanel ----
    else if (commandName === 'rolepanel') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles))
            return interaction.reply({
                content: 'You need Manage Roles permission.',
                ephemeral: true,
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
                ephemeral: true,
            });

        const lines = pairs.map((p) => `${p.emojiStr} — ${p.role}`);
        const body = `**${title}**\n\n${lines.join('\n')}`;

        await interaction.deferReply({ ephemeral: true });
        const panelMsg = await interaction.channel.send(body);

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
            ephemeral: true,
        });
    }

    // ---- /removereactionrole ----
    else if (commandName === 'removereactionrole') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles))
            return interaction.reply({
                content: 'You need Manage Roles permission.',
                ephemeral: true,
            });
        const messageId = interaction.options.getString('message_id');
        const emojiStr = interaction.options.getString('emoji');
        const rr = reactionRoles.get(messageId);
        if (!rr)
            return interaction.reply({
                content: 'No reaction roles on that message.',
                ephemeral: true,
            });
        const customMatch = emojiStr.match(/<a?:(\w+):(\d+)>/);
        const key = customMatch ? customMatch[2] : emojiStr;
        if (!rr.has(key))
            return interaction.reply({
                content: 'That emoji has no reaction role on that message.',
                ephemeral: true,
            });
        rr.delete(key);
        if (rr.size === 0) reactionRoles.delete(messageId);
        saveReactionRoles();
        await interaction.reply({ content: 'Reaction role removed.', ephemeral: true });
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
client.login(TOKEN);
