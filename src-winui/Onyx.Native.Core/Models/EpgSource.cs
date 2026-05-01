namespace Onyx.Native.Core.Models;

public sealed record EpgSource(
    string Id,
    string Url,
    bool Enabled,
    bool AutoUpdateEnabled,
    bool UpdateOnStartup,
    int UpdateIntervalHours,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);
