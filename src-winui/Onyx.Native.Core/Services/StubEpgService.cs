using Onyx.Native.Core.Models;

namespace Onyx.Native.Core.Services;

public sealed class StubEpgService : IEpgService
{
    public Task<IReadOnlyList<EpgSource>> LoadSourcesAsync(CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyList<EpgSource>>(Array.Empty<EpgSource>());
    }

    public Task<IReadOnlyList<EpgProgrammeSummary>> GetProgrammeWindowAsync(
        string epgChannelKey,
        DateTimeOffset windowStart,
        DateTimeOffset windowEnd,
        CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyList<EpgProgrammeSummary>>(Array.Empty<EpgProgrammeSummary>());
    }
}
