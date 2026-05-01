namespace Onyx.Native.Core.Models;

public sealed record EpgProgrammeSummary(
    long StartMs,
    long? StopMs,
    string Title,
    string? SubTitle,
    string? Description,
    string? Icon);
