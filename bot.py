import asyncio
import time
import aiohttp
import discord
from discord.ext import commands

intents = discord.Intents.default()
intents.members = True
intents.voice_states = True
intents.reactions = True
bot = commands.Bot(command_prefix="!", intents=intents)

session = None
mute_end_times = {}
mute_start_times = {}
mute_handles = {}
vote_mute_messages = {}
russianroulette_cooldowns = {}
RUSSIAN_ROULETTE_COOLDOWN = 30
CUSTOM_EMOJI_ID = 1350401925237178378
CUSTOM_EMOJI_NAME = "customemoji"

def parse_duration(duration_str: str) -> int | None:
    try:
        if duration_str[-1].lower() == "m":
            return int(float(duration_str[:-1]) * 60)
        if duration_str[-1].lower() == "s":
            return int(float(duration_str[:-1]))
        return int(float(duration_str))
    except (ValueError, IndexError):
        return None

async def get_true_random_int(min_v: int, max_v: int) -> int:
    url = f"https://www.randomnumberapi.com/api/v1.0/random?min={min_v}&max={max_v}&count=1"
    async with session.get(url) as resp:
        return (await resp.json())[0]

async def _do_unmute(user_id: int, channel_id: int):
    channel = bot.get_channel(channel_id)
    if not channel:
        return
    guild = channel.guild
    member = guild.get_member(user_id)
    start = mute_start_times.pop(user_id, None)
    mute_end_times.pop(user_id, None)
    handle = mute_handles.pop(user_id, None)
    if handle:
        handle.cancel()
    if member and member.voice:
        try:
            await member.edit(mute=False)
            if start:
                total = int(time.time() - start)
                await channel.send(f"{member.display_name} was unmuted after {total} seconds.", delete_after=10)
        except discord.Forbidden:
            await channel.send("I lack permission to unmute.", delete_after=10)

async def add_mute(member: discord.Member, seconds: int, channel: discord.TextChannel):
    now = time.time()
    uid = member.id
    if uid in mute_handles:
        mute_handles[uid].cancel()
    prev_end = mute_end_times.get(uid, 0)
    if prev_end <= now:
        mute_start_times[uid] = now
    end = max(now, prev_end) + seconds
    mute_end_times[uid] = end
    if member.voice and not member.voice.mute:
        await member.edit(mute=True)
    mute_handles[uid] = bot.loop.call_later(
        end - now, lambda: asyncio.create_task(_do_unmute(uid, channel.id))
    )

@bot.event
async def on_ready():
    global session
    session = aiohttp.ClientSession()
    print(f"Logged in as {bot.user}")
    try:
        synced = await bot.tree.sync()
        print(f"Synced {len(synced)} commands.")
    except Exception as e:
        print("Error syncing commands:", e)
    total = sum(g.member_count for g in bot.guilds)
    await bot.change_presence(activity=discord.Game(name=f"with {total} members"))

@bot.event
async def on_reaction_add(reaction: discord.Reaction, user: discord.Member):
    if user.bot:
        return
    vm = vote_mute_messages.get(reaction.message.id)
    if not vm or getattr(reaction.emoji, "id", None) != CUSTOM_EMOJI_ID:
        return
    target = reaction.message.guild.get_member(vm["target_id"])
    if not target or not user.voice or user.voice.channel != target.voice.channel:
        return
    vm["votes"].add(user.id)
    members = [m for m in target.voice.channel.members if not m.bot and m.id != target.id]
    if len(vm["votes"] & {m.id for m in members}) >= len(members) // 2 + 1:
        await add_mute(target, vm["duration"], reaction.message.channel)
        await reaction.message.channel.send(
            f"{target.display_name} has been muted for {vm['duration']} seconds by vote!",
            delete_after=vm["duration"] + 5
        )
        vote_mute_messages.pop(reaction.message.id, None)

@bot.event
async def on_reaction_remove(reaction: discord.Reaction, user: discord.Member):
    if user.bot:
        return
    vm = vote_mute_messages.get(reaction.message.id)
    if vm and getattr(reaction.emoji, "id", None) == CUSTOM_EMOJI_ID:
        vm["votes"].discard(user.id)

@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return
    await bot.process_commands(message)

@bot.tree.command(name="mute", description="Mute a user for a given duration.")
async def mute_cmd(interaction: discord.Interaction, user: discord.Member, duration: str):
    if not interaction.user.guild_permissions.mute_members:
        return await interaction.response.send_message("Insufficient permissions.", ephemeral=True)
    if not user.voice:
        return await interaction.response.send_message(f"{user.display_name} is not in voice.", ephemeral=True)
    secs = parse_duration(duration)
    if secs is None:
        return await interaction.response.send_message("Invalid duration format.", ephemeral=True)
    await add_mute(user, secs, interaction.channel)
    await interaction.response.send_message(f"Muted {user.display_name} for {secs}s.", delete_after=10)

@bot.tree.command(name="unmute", description="Unmute a user immediately.")
async def unmute_cmd(interaction: discord.Interaction, user: discord.Member):
    if not interaction.user.guild_permissions.mute_members:
        return await interaction.response.send_message("Insufficient permissions.", ephemeral=True)
    if not user.voice:
        return await interaction.response.send_message(f"{user.display_name} is not in voice.", ephemeral=True)
    uid = user.id
    if handle := mute_handles.pop(uid, None):
        handle.cancel()
    mute_end_times.pop(uid, None)
    mute_start_times.pop(uid, None)
    try:
        await user.edit(mute=False)
        await interaction.response.send_message(f"{user.display_name} has been unmuted.", delete_after=10)
    except discord.Forbidden:
        await interaction.response.send_message("I cannot unmute that user.", ephemeral=True)

@bot.tree.command(name="votemute", description="Start a vote-mute for a user.")
async def votemute_cmd(interaction: discord.Interaction, user: discord.Member, duration: str):
    if not user.voice:
        return await interaction.response.send_message(f"{user.display_name} is not in voice.", ephemeral=True)
    secs = parse_duration(duration)
    if secs is None:
        return await interaction.response.send_message("Invalid duration format.", ephemeral=True)
    emoji = discord.PartialEmoji(name=CUSTOM_EMOJI_NAME, id=CUSTOM_EMOJI_ID)
    vote_msg = await interaction.channel.send(
        f"Vote to mute {user.mention} for {secs}s! React with <:{CUSTOM_EMOJI_NAME}:{CUSTOM_EMOJI_ID}>"
    )
    await vote_msg.add_reaction(emoji)
    vote_mute_messages[vote_msg.id] = {"target_id": user.id, "duration": secs, "votes": set()}
    await interaction.response.send_message("Vote started!", ephemeral=True)

@bot.tree.command(name="russianroulette", description="Randomly mute someone in your voice channel.")
async def russianroulette_cmd(interaction: discord.Interaction):
    uid = interaction.user.id
    now_ts = time.time()
    if now_ts - russianroulette_cooldowns.get(uid, 0) < RUSSIAN_ROULETTE_COOLDOWN:
        rem = int(RUSSIAN_ROULETTE_COOLDOWN - (now_ts - russianroulette_cooldowns[uid]))
        return await interaction.response.send_message(f"On cooldown: {rem}s left.", ephemeral=True)
    russianroulette_cooldowns[uid] = now_ts
    vc = interaction.user.voice and interaction.user.voice.channel
    if not vc:
        return await interaction.response.send_message("Join a voice channel first.", ephemeral=True)
    members = [m for m in vc.members if not m.bot]
    if not members:
        return await interaction.response.send_message("No eligible members found.", ephemeral=True)
    idx = await get_true_random_int(0, len(members) - 1)
    target = members[idx]
    dur = await get_true_random_int(10, 60)
    await add_mute(target, dur, interaction.channel)
    await interaction.response.send_message(
        f"Russian Roulette! {target.mention} muted for {dur}s.", delete_after=dur + 5
    )

bot.run("YOUR_BOT_TOKEN")