import asyncio
import datetime
import math
import time

import aiohttp
import discord
from discord.ext import commands
from discord import app_commands

# --- Bot Setup ---
intents = discord.Intents.default()
intents.members = True
intents.voice_states = True
intents.reactions = True

bot = commands.Bot(command_prefix=None, intents=intents)

# --- Global Variables ---
# Vote mute: { message_id: { "target": discord.Member, "votes": set(user_ids), "duration": int } }
vote_mute_messages = {}

# Russian Roulette cooldown: { user_id: last_used_timestamp }
russianroulette_cooldowns = {}
RUSSIAN_ROULETTE_COOLDOWN = 30

# Mute timers and start times: { user_id: expiration_timestamp } and { user_id: start_timestamp }
mute_end_times = {}
mute_start_times = {}
mute_tasks = {}

# Last time a message was sent by specific users: { user_id: datetime }
last_sent = {}

# Custom emoji details (for votemute command)
CUSTOM_EMOJI_ID = 1350401925237178378
CUSTOM_EMOJI_NAME = "customemoji"

# --- Helper Functions ---
def has_mute_permission(interaction: discord.Interaction) -> bool:
    """Check if the invoking user has permission to mute members."""
    return interaction.user.guild_permissions.mute_members

def parse_duration(duration_str: str) -> int:
    """
    Convert a duration string (e.g., '30s', '1m') to seconds.
    If no unit is provided, the value is assumed to be in seconds.
    """
    try:
        if duration_str[-1].lower() == "m":
            return int(float(duration_str[:-1]) * 60)
        elif duration_str[-1].lower() == "s":
            return int(float(duration_str[:-1]))
        else:
            return int(float(duration_str))
    except ValueError:
        return None

async def unmute_after(user: discord.Member, channel: discord.TextChannel):
    """
    Wait until the mute should expire, then unmute the user.
    Displays how long the user was muted.
    """
    sleep_time = mute_end_times[user.id] - time.time()
    if sleep_time > 0:
        await asyncio.sleep(sleep_time)
    try:
        if user.voice is not None:
            await user.edit(mute=False)
            # Calculate total mute duration.
            total_muted = time.time() - mute_start_times.get(user.id, time.time())
            await channel.send(
                f"{user.display_name} has been unmuted after being muted for {int(total_muted)} seconds.",
                delete_after=10,
            )
    except discord.Forbidden:
        await channel.send("I do not have permission to unmute that user.", delete_after=10)
    except Exception as e:
        await channel.send(f"An error occurred while unmuting {user.display_name}: {e}", delete_after=10)
    mute_end_times.pop(user.id, None)
    mute_start_times.pop(user.id, None)
    mute_tasks.pop(user.id, None)

async def add_mute(user: discord.Member, additional_duration: int, channel: discord.TextChannel):
    """
    Mute a user (if not already muted) and stack additional duration.
    Records the start time for calculating the total mute duration.
    """
    current_time = time.time()
    if user.id in mute_end_times and mute_end_times[user.id] > current_time:
        mute_end_times[user.id] += additional_duration
        if user.id in mute_tasks:
            mute_tasks[user.id].cancel()
        mute_tasks[user.id] = asyncio.create_task(unmute_after(user, channel))
    else:
        mute_end_times[user.id] = current_time + additional_duration
        mute_start_times[user.id] = current_time  # Record when the mute started
        await user.edit(mute=True)
        mute_tasks[user.id] = asyncio.create_task(unmute_after(user, channel))

async def get_true_random_int(min_value: int, max_value: int) -> int:
    """
    Get a truly random integer using the ANU Quantum Random Numbers API.
    The API returns a JSON array with one element.
    """
    url = f"https://www.randomnumberapi.com/api/v1.0/random?min={min_value}&max={max_value}&count=1"
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as response:
            data = await response.json()
            return data[0]

# --- Bot Events ---
@bot.event
async def on_ready():
    print(f"Logged in as {bot.user}!")
    try:
        synced = await bot.tree.sync()
        print(f"Synced {len(synced)} command(s).")
    except Exception as e:
        print("Error syncing commands:", e)
    
    # Update presence with total member count across guilds.
    total_members = sum(guild.member_count for guild in bot.guilds)
    await bot.change_presence(activity=discord.Game(name=f"with {total_members}"))

@bot.event
async def on_reaction_add(reaction: discord.Reaction, user: discord.Member):
    if user.bot:
        return

    message_id = reaction.message.id
    if message_id not in vote_mute_messages:
        return

    # Process only the specific custom emoji.
    if not (hasattr(reaction.emoji, "id") and reaction.emoji.id == CUSTOM_EMOJI_ID):
        return

    vote_data = vote_mute_messages[message_id]
    target = vote_data["target"]

    # Only count votes from users in the same voice channel as the target.
    if user.voice is None or user.voice.channel != target.voice.channel:
        return

    vote_data["votes"].add(user.id)

    # Determine eligible voters: non-bot members in the target's voice channel (excluding the target).
    channel_members = [member for member in target.voice.channel.members if not member.bot and member.id != target.id]
    total_voters = len(channel_members)
    majority = math.floor(total_voters / 2) + 1

    valid_votes = sum(1 for voter_id in vote_data["votes"] if any(member.id == voter_id for member in channel_members))
    if valid_votes >= majority:
        duration_seconds = vote_data["duration"]
        try:
            await add_mute(target, duration_seconds, reaction.message.channel)
            await reaction.message.channel.send(
                f"{target.display_name} has been muted for {duration_seconds} seconds by majority vote!",
                delete_after=duration_seconds + 5,
            )
            vote_mute_messages.pop(message_id, None)
        except discord.Forbidden:
            await reaction.message.channel.send("I do not have permission to mute that user.", delete_after=15)
        except Exception as e:
            await reaction.message.channel.send(f"An error occurred: {e}", delete_after=15)

@bot.event
async def on_reaction_remove(reaction: discord.Reaction, user: discord.Member):
    if user.bot:
        return

    message_id = reaction.message.id
    if message_id in vote_mute_messages:
        if hasattr(reaction.emoji, "id") and reaction.emoji.id == CUSTOM_EMOJI_ID:
            vote_mute_messages[message_id]["votes"].discard(user.id)

# --- Bot Commands ---
@bot.tree.command(
    name="mute",
    description="Mute a user in a voice channel immediately. (Requires proper permissions)"
)
async def mute(interaction: discord.Interaction, user: discord.Member):
    if not has_mute_permission(interaction):
        await interaction.response.send_message("You do not have permission to use this command.", ephemeral=True)
        return

    if user.voice is None:
        await interaction.response.send_message(f"{user.display_name} is not in a voice channel.", ephemeral=True)
        return

    try:
        await user.edit(mute=True)
        await interaction.response.send_message(f"{user.display_name} has been muted.", delete_after=15)
    except discord.Forbidden:
        await interaction.response.send_message("I do not have permission to mute that user.", ephemeral=True)
    except Exception as e:
        await interaction.response.send_message(f"An error occurred: {e}", ephemeral=True)

@bot.tree.command(
    name="unmute",
    description="Unmute a user in a voice channel. (Requires proper permissions)"
)
async def unmute(interaction: discord.Interaction, user: discord.Member):
    if not has_mute_permission(interaction):
        await interaction.response.send_message("You do not have permission to use this command.", ephemeral=True)
        return

    if user.voice is None:
        await interaction.response.send_message(f"{user.display_name} is not in a voice channel.", ephemeral=True)
        return

    try:
        mute_end_times.pop(user.id, None)
        mute_start_times.pop(user.id, None)
        if user.id in mute_tasks:
            mute_tasks[user.id].cancel()
            mute_tasks.pop(user.id, None)
        await user.edit(mute=False)
        await interaction.response.send_message(f"{user.display_name} has been unmuted.", delete_after=10)
    except discord.Forbidden:
        await interaction.response.send_message("I do not have permission to unmute that user.", ephemeral=True)
    except Exception as e:
        await interaction.response.send_message(f"An error occurred: {e}", ephemeral=True)

@bot.tree.command(
    name="votemute",
    description="Vote to mute a user for a duration (e.g., 30s, 1m) by voice majority."
)
async def votemute(interaction: discord.Interaction, user: discord.Member, duration: str):
    if user.voice is None:
        await interaction.response.send_message(f"{user.display_name} is not in a voice channel.", ephemeral=True)
        return

    duration_seconds = parse_duration(duration)
    if duration_seconds is None:
        await interaction.response.send_message(
            "Invalid duration format. Use e.g., 30s for 30 seconds or 1m for 1 minute.",
            ephemeral=True,
        )
        return

    custom_emoji = discord.PartialEmoji(name=CUSTOM_EMOJI_NAME, id=CUSTOM_EMOJI_ID, animated=False)
    emoji_str = f"<:{custom_emoji.name}:{custom_emoji.id}>"
    
    vote_message = await interaction.channel.send(
        f"Vote to mute {user.mention} for {duration_seconds} seconds! React with {emoji_str} to vote. "
        "A majority of eligible members in the call is required.",
        delete_after=60,
    )
    await vote_message.add_reaction(custom_emoji)
    vote_mute_messages[vote_message.id] = {"target": user, "votes": set(), "duration": duration_seconds}
    await interaction.response.send_message("Vote started!", ephemeral=True)

@bot.tree.command(
    name="russianroulette",
    description="Play Russian Roulette: randomly mutes someone in your voice channel for a random duration!"
)
async def russianroulette(interaction: discord.Interaction):
    now = time.time()
    last_used = russianroulette_cooldowns.get(interaction.user.id, 0)
    if now - last_used < RUSSIAN_ROULETTE_COOLDOWN:
        remaining = int(RUSSIAN_ROULETTE_COOLDOWN - (now - last_used))
        await interaction.response.send_message(
            f"You're on cooldown for Russian Roulette. Please wait {remaining} more second(s).",
            ephemeral=True,
        )
        return

    russianroulette_cooldowns[interaction.user.id] = now

    if interaction.user.voice is None or interaction.user.voice.channel is None:
        await interaction.response.send_message("You need to be in a voice channel to play Russian Roulette.", ephemeral=True)
        return

    voice_channel = interaction.user.voice.channel
    eligible_members = [member for member in voice_channel.members if not member.bot]
    if not eligible_members:
        await interaction.response.send_message("No eligible members found in your voice channel.", ephemeral=True)
        return

    try:
        index = await get_true_random_int(0, len(eligible_members) - 1)
        selected_member = eligible_members[index]
        duration_seconds = await get_true_random_int(10, 60)
        await add_mute(selected_member, duration_seconds, interaction.channel)
        await interaction.response.send_message(
            f"Russian Roulette! {selected_member.mention} has been muted for {duration_seconds} seconds!",
            delete_after=duration_seconds + 5,
        )
    except discord.Forbidden:
        await interaction.response.send_message("I do not have permission to mute that user.", ephemeral=True)
    except Exception as e:
        await interaction.response.send_message(f"An error occurred: {e}", ephemeral=True)
    
# Replace the token below with your actual bot token.
bot.run("YOUR_BOT_TOKEN")