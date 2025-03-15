import discord
from discord.ext import commands
from discord import app_commands
import asyncio
import math

# Set up intents: members, voice_states, and reactions are required.
intents = discord.Intents.default()
intents.members = True
intents.voice_states = True
intents.reactions = True

bot = commands.Bot(command_prefix="!", intents=intents)

# Dictionary to track vote mute messages.
# Structure: { message_id: { "target": discord.Member, "votes": set(user_ids), "duration": int } }
vote_mute_messages = {}

# Helper: Check if the interaction invoker has mute permissions.
def has_mute_permission(interaction: discord.Interaction) -> bool:
    return interaction.user.guild_permissions.mute_members

# Helper: Parse a duration string.
# e.g. "30s" => 30 seconds, "1m" => 60 seconds; if no unit, assume seconds.
def parse_duration(duration_str: str):
    try:
        if duration_str[-1].lower() == "m":
            return int(float(duration_str[:-1]) * 60)
        elif duration_str[-1].lower() == "s":
            return int(float(duration_str[:-1]))
        else:
            return int(float(duration_str))
    except ValueError:
        return None

@bot.event
async def on_ready():
    print(f"Logged in as {bot.user}!")
    try:
        synced = await bot.tree.sync()
        print(f"Synced {len(synced)} command(s).")
    except Exception as e:
        print("Error syncing commands:", e)
    
    # Compute the total number of members across all guilds
    total_members = sum(guild.member_count for guild in bot.guilds)
    # Set the bot's status to "Silencing (x) idiots"
    await bot.change_presence(activity=discord.Game(name=f"Silencing {total_members} people"))

# Command: Immediate mute (permission-restricted).
@bot.tree.command(name="mute", description="Mute a user in a voice channel immediately. (Requires proper permissions)")
async def mute(interaction: discord.Interaction, user: discord.Member):
    if not has_mute_permission(interaction):
        await interaction.response.send_message("You do not have permission to use this command.", ephemeral=True)
        return
    if user.voice is None:
        await interaction.response.send_message(f"{user.display_name} is not in a voice channel.", ephemeral=True)
        return
    try:
        await user.edit(mute=True)
        await interaction.response.send_message(f"{user.display_name} has been muted.", delete_after=60)
    except discord.Forbidden:
        await interaction.response.send_message("I do not have permission to mute that user.", ephemeral=True)
    except Exception as e:
        await interaction.response.send_message(f"An error occurred: {e}", ephemeral=True)

# Command: Immediate unmute (permission-restricted).
@bot.tree.command(name="unmute", description="Unmute a user in a voice channel. (Requires proper permissions)")
async def unmute(interaction: discord.Interaction, user: discord.Member):
    if not has_mute_permission(interaction):
        await interaction.response.send_message("You do not have permission to use this command.", ephemeral=True)
        return
    if user.voice is None:
        await interaction.response.send_message(f"{user.display_name} is not in a voice channel.", ephemeral=True)
        return
    try:
        await user.edit(mute=False)
        await interaction.response.send_message(f"{user.display_name} has been unmuted.", delete_after=60)
    except discord.Forbidden:
        await interaction.response.send_message("I do not have permission to unmute that user.", ephemeral=True)
    except Exception as e:
        await interaction.response.send_message(f"An error occurred: {e}", ephemeral=True)

# Command: Vote to mute with a custom duration.
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
        await interaction.response.send_message("Invalid duration format. Use e.g., 30s for 30 seconds or 1m for 1 minute.", ephemeral=True)
        return

    vote_message = await interaction.channel.send(
        f"Vote to mute {user.mention} for {duration_seconds} seconds! React with 👍 to vote. A majority of eligible members in the call is required.",
        delete_after=60
    )
    await vote_message.add_reaction("👍")
    vote_mute_messages[vote_message.id] = {"target": user, "votes": set(), "duration": duration_seconds}
    await interaction.response.send_message("Vote started!", ephemeral=True)

# Reaction event: Process added votes.
@bot.event
async def on_reaction_add(reaction: discord.Reaction, user: discord.Member):
    # Ignore bots.
    if user.bot:
        return

    message_id = reaction.message.id
    if message_id not in vote_mute_messages:
        return

    # Only process the 👍 reaction.
    if str(reaction.emoji) != "👍":
        return

    vote_data = vote_mute_messages[message_id]
    target = vote_data["target"]

    # Ensure the reactor is in the same voice channel as the target.
    if user.voice is None or user.voice.channel != target.voice.channel:
        return

    vote_data["votes"].add(user.id)

    # Determine eligible voters: non-bot members in the target's voice channel (excluding the target).
    channel_members = [member for member in target.voice.channel.members if not member.bot and member.id != target.id]
    total_voters = len(channel_members)
    majority = math.floor(total_voters / 2) + 1

    # Count only votes from those who are still in the voice channel.
    valid_votes = sum(1 for voter_id in vote_data["votes"] if any(member.id == voter_id for member in channel_members))

    if valid_votes >= majority:
        try:
            await target.edit(mute=True)
            duration_seconds = vote_data["duration"]
            await reaction.message.channel.send(
                f"{target.display_name} has been muted for {duration_seconds} seconds by majority vote!",
                delete_after=45
            )
            vote_mute_messages.pop(message_id, None)
            await asyncio.sleep(duration_seconds)
            if target.voice is not None:
                await target.edit(mute=False)
                await reaction.message.channel.send(
                    f"{target.display_name} has been unmuted after {duration_seconds} seconds.",
                    delete_after=15
                )
        except discord.Forbidden:
            await reaction.message.channel.send("I do not have permission to mute that user.", delete_after=60)
        except Exception as e:
            await reaction.message.channel.send(f"An error occurred: {e}", delete_after=60)

# Reaction event: Process reaction removals (updates vote counts).
@bot.event
async def on_reaction_remove(reaction: discord.Reaction, user: discord.Member):
    if user.bot:
        return

    message_id = reaction.message.id
    if message_id in vote_mute_messages:
        if str(reaction.emoji) == "👍":
            vote_data = vote_mute_messages[message_id]
            vote_data["votes"].discard(user.id)

# Replace the token below with your actual bot token.
bot.run("YOUR TOKEN")
