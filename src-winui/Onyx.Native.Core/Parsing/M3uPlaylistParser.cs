using System.Text.RegularExpressions;
using Onyx.Native.Core.Models;

namespace Onyx.Native.Core.Parsing;

public sealed partial class M3uPlaylistParser
{
    public PlaylistImport Parse(string playlistText, string fileName)
    {
        var normalizedText = playlistText.TrimStart('\uFEFF');
        var lines = normalizedText.Split(["\r\n", "\n"], StringSplitOptions.None);
        var channels = new List<Channel>();

        PendingChannelMeta? pendingChannel = null;
        string? fallbackGroup = null;
        var disabledChannelCount = 0;
        var skippedEntryCount = 0;

        foreach (var rawLine in lines)
        {
            var line = rawLine.Trim();

            if (line.Length == 0)
            {
                continue;
            }

            if (line.StartsWith("#EXTINF", StringComparison.OrdinalIgnoreCase))
            {
                if (pendingChannel is not null)
                {
                    skippedEntryCount++;
                }

                pendingChannel = ParseExtinfLine(line, channels.Count + 1, fallbackGroup);
                fallbackGroup = pendingChannel.Group;
                continue;
            }

            if (line.StartsWith("#EXTGRP:", StringComparison.OrdinalIgnoreCase))
            {
                fallbackGroup = ChannelFactory.SanitizeLabel(line[8..], "Ungrouped", 80);

                if (pendingChannel is not null)
                {
                    pendingChannel = pendingChannel with { Group = fallbackGroup };
                }

                continue;
            }

            if (line.StartsWith('#'))
            {
                continue;
            }

            var channel = ChannelFactory.BuildChannel(new ChannelSeed(
                pendingChannel?.Name ?? $"Channel {channels.Count + 1}",
                line,
                pendingChannel?.Group ?? fallbackGroup ?? "Ungrouped",
                line,
                pendingChannel?.Logo,
                pendingChannel?.TvgId,
                pendingChannel?.TvgName));

            if (!channel.IsPlayable)
            {
                disabledChannelCount++;
            }

            channels.Add(channel);
            pendingChannel = null;
            fallbackGroup = null;
        }

        if (pendingChannel is not null)
        {
            skippedEntryCount++;
        }

        if (channels.Count == 0)
        {
            throw new InvalidOperationException("The playlist did not contain any channels that could be listed.");
        }

        var groups = channels
            .Select(channel => channel.Group)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.CurrentCulture)
            .ToArray();

        return new PlaylistImport(
            ChannelFactory.SanitizeLabel(Path.GetFileNameWithoutExtension(fileName), "Imported playlist", 80),
            channels,
            groups,
            DateTimeOffset.UtcNow,
            disabledChannelCount,
            skippedEntryCount);
    }

    private static Dictionary<string, string> ParseAttributes(string source)
    {
        var attributes = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (Match match in AttributePattern().Matches(source))
        {
            attributes[match.Groups[1].Value] = match.Groups[2].Value;
        }

        return attributes;
    }

    private static int FindMetadataSeparator(string source)
    {
        var insideQuotes = false;

        for (var index = 0; index < source.Length; index++)
        {
            var character = source[index];

            if (character == '"')
            {
                insideQuotes = !insideQuotes;
            }

            if (character == ',' && !insideQuotes)
            {
                return index;
            }
        }

        return -1;
    }

    private static PendingChannelMeta ParseExtinfLine(string line, int fallbackIndex, string? fallbackGroup)
    {
        var colonIndex = line.IndexOf(':');
        var extinfContent = colonIndex >= 0 ? line[(colonIndex + 1)..] : string.Empty;
        var separatorIndex = FindMetadataSeparator(extinfContent);
        var metadataPart = separatorIndex >= 0 ? extinfContent[..separatorIndex] : extinfContent;
        var displayName = separatorIndex >= 0 ? extinfContent[(separatorIndex + 1)..] : string.Empty;
        var attributes = ParseAttributes(metadataPart);

        attributes.TryGetValue("tvg-name", out var tvgName);
        attributes.TryGetValue("group-title", out var groupTitle);
        attributes.TryGetValue("tvg-logo", out var logo);
        attributes.TryGetValue("tvg-id", out var tvgId);

        return new PendingChannelMeta(
            ChannelFactory.SanitizeLabel(tvgName ?? displayName, $"Channel {fallbackIndex}", 120),
            ChannelFactory.SanitizeLabel(groupTitle ?? fallbackGroup ?? "Ungrouped", "Ungrouped", 80),
            ChannelFactory.SanitizeOptionalLabel(logo, 240),
            ChannelFactory.SanitizeOptionalLabel(tvgId, 120),
            ChannelFactory.SanitizeOptionalLabel(tvgName, 120));
    }

    [GeneratedRegex("([A-Za-z0-9_-]+)=\"([^\"]*)\"")]
    private static partial Regex AttributePattern();

    private sealed record PendingChannelMeta(
        string Name,
        string Group,
        string? Logo,
        string? TvgId,
        string? TvgName);
}
