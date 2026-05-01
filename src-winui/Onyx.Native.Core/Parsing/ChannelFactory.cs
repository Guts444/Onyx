using System.Globalization;
using System.Text.RegularExpressions;
using Onyx.Native.Core.Models;

namespace Onyx.Native.Core.Parsing;

public sealed record NormalizedStreamReference(
    string Stream,
    bool IsPlayable,
    string? PlayabilityError);

public static partial class ChannelFactory
{
    private static readonly HashSet<string> AllowedProtocols = new(StringComparer.OrdinalIgnoreCase)
    {
        "http",
        "https",
        "rtsp",
        "rtmp",
        "rtmps",
        "udp",
        "tcp",
        "mms",
        "mmsh",
        "rtp",
        "srt",
        "file"
    };

    public static string SanitizeLabel(string? value, string fallback, int maxLength)
    {
        var cleaned = CollapseWhitespace()
            .Replace(ControlCharacters().Replace(value ?? string.Empty, " "), " ")
            .Trim();

        if (cleaned.Length == 0)
        {
            return fallback;
        }

        return cleaned.Length <= maxLength ? cleaned : cleaned[..maxLength];
    }

    public static string? SanitizeOptionalLabel(string? value, int maxLength)
    {
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }

        var cleaned = SanitizeLabel(value, string.Empty, maxLength);
        return cleaned.Length == 0 ? null : cleaned;
    }

    public static NormalizedStreamReference NormalizeStreamReference(string stream)
    {
        var trimmedStream = stream.Trim();

        if (WindowsPathPattern().IsMatch(trimmedStream) || trimmedStream.StartsWith(@"\\", StringComparison.Ordinal))
        {
            return new NormalizedStreamReference(trimmedStream, true, null);
        }

        if (!Uri.TryCreate(trimmedStream, UriKind.Absolute, out var uri))
        {
            return new NormalizedStreamReference(
                trimmedStream,
                false,
                "Unsupported stream format or malformed URL.");
        }

        if (!AllowedProtocols.Contains(uri.Scheme))
        {
            return new NormalizedStreamReference(
                trimmedStream,
                false,
                $"Unsupported stream protocol: {uri.Scheme}:");
        }

        return new NormalizedStreamReference(uri.AbsoluteUri, true, null);
    }

    public static Channel BuildChannel(ChannelSeed seed)
    {
        var name = SanitizeLabel(seed.Name, "Unnamed channel", 120);
        var group = SanitizeLabel(seed.Group, "Ungrouped", 80);
        var normalizedStream = NormalizeStreamReference(seed.Stream);

        return new Channel(
            CreateChannelId(name, group, normalizedStream.Stream),
            name,
            group,
            normalizedStream.Stream,
            (seed.OriginalStream ?? seed.Stream).Trim(),
            normalizedStream.IsPlayable,
            normalizedStream.PlayabilityError,
            SanitizeOptionalLabel(seed.Logo, 240),
            SanitizeOptionalLabel(seed.TvgId, 120),
            SanitizeOptionalLabel(seed.TvgName, 120));
    }

    private static string CreateChannelId(string name, string group, string stream)
    {
        var seed = $"{name}\u0001{group}\u0001{stream}";

        unchecked
        {
            var hash = 0;
            foreach (var character in seed)
            {
                hash = (hash << 5) - hash + character;
            }

            var positiveHash = hash == int.MinValue ? int.MaxValue : Math.Abs(hash);
            return $"channel_{positiveHash.ToString("x", CultureInfo.InvariantCulture)}";
        }
    }

    [GeneratedRegex("[\\u0000-\\u001F\\u007F]+")]
    private static partial Regex ControlCharacters();

    [GeneratedRegex("\\s+")]
    private static partial Regex CollapseWhitespace();

    [GeneratedRegex("^[a-zA-Z]:\\\\")]
    private static partial Regex WindowsPathPattern();
}

public sealed record ChannelSeed(
    string Name,
    string Stream,
    string? Group = null,
    string? OriginalStream = null,
    string? Logo = null,
    string? TvgId = null,
    string? TvgName = null);
