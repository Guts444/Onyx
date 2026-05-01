using Onyx.Native.Core.Models;

namespace Onyx.Native.Core.Services;

public interface IPlaylistImportService
{
    Task<PlaylistImport> ImportLocalFileAsync(string filePath, CancellationToken cancellationToken = default);

    Task<PlaylistImport> ImportRemoteM3uAsync(string url, CancellationToken cancellationToken = default);

    Task<PlaylistImport> ImportXtreamLiveAsync(
        string domain,
        string username,
        string password,
        CancellationToken cancellationToken = default);
}
