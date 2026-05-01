namespace Onyx.Native.Core.Models;

public enum SavedPlaylistSourceKind
{
    LocalM3uFile,
    M3uUrl,
    Xtream
}

public sealed record SavedPlaylistSource(
    string Id,
    SavedPlaylistSourceKind Kind,
    string Name,
    bool Enabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? LastLoadedAt,
    string? LocalFilePath = null,
    string? Url = null,
    string? Domain = null,
    string? Username = null);
