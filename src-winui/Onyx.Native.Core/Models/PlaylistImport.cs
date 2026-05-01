namespace Onyx.Native.Core.Models;

public sealed record PlaylistImport(
    string Name,
    IReadOnlyList<Channel> Channels,
    IReadOnlyList<string> Groups,
    DateTimeOffset ImportedAt,
    int DisabledChannelCount,
    int SkippedEntryCount);
