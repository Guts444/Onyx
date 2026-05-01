using Onyx.Native.Core.Models;

namespace Onyx.Native.Core.Services;

public sealed class LocalSourceProfileService : ISourceProfileService
{
    private const string StorageKey = "native:saved-sources";
    private readonly IPersistenceService _persistence;

    public LocalSourceProfileService(IPersistenceService persistence)
    {
        _persistence = persistence;
    }

    public async Task<IReadOnlyList<SavedPlaylistSource>> LoadAsync(CancellationToken cancellationToken = default)
    {
        var sources = await _persistence.LoadAsync(
            StorageKey,
            Array.Empty<SavedPlaylistSource>(),
            cancellationToken);
        return sources;
    }

    public Task SaveAsync(IReadOnlyList<SavedPlaylistSource> sources, CancellationToken cancellationToken = default)
    {
        return _persistence.SaveAsync(StorageKey, sources, cancellationToken);
    }
}
