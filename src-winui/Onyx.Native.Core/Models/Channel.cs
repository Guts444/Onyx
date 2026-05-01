namespace Onyx.Native.Core.Models;

public sealed record Channel(
    string Id,
    string Name,
    string Group,
    string Stream,
    string OriginalStream,
    bool IsPlayable,
    string? PlayabilityError,
    string? Logo,
    string? TvgId,
    string? TvgName);
