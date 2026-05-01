namespace Onyx.Native.Core.Models;

public sealed record PlaybackSession(
    string? SourceId,
    string? ChannelId,
    bool ShouldResume,
    string? ResumeSourceId,
    string? ResumeChannelId,
    bool ResumeInFullscreen)
{
    public static PlaybackSession Empty { get; } = new(null, null, false, null, null, false);
}
