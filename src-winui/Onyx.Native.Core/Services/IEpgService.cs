using Onyx.Native.Core.Models;

namespace Onyx.Native.Core.Services;

public interface IEpgService
{
    Task<IReadOnlyList<EpgSource>> LoadSourcesAsync(CancellationToken cancellationToken = default);

    Task<IReadOnlyList<EpgProgrammeSummary>> GetProgrammeWindowAsync(
        string epgChannelKey,
        DateTimeOffset windowStart,
        DateTimeOffset windowEnd,
        CancellationToken cancellationToken = default);
}
