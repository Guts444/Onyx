using Onyx.Native.Core.Models;

namespace Onyx.Native.Core.Services;

public interface ISourceProfileService
{
    Task<IReadOnlyList<SavedPlaylistSource>> LoadAsync(CancellationToken cancellationToken = default);

    Task SaveAsync(IReadOnlyList<SavedPlaylistSource> sources, CancellationToken cancellationToken = default);
}
