namespace Onyx.Native.Core.Services;

public interface IPersistenceService
{
    Task<T> LoadAsync<T>(string key, T fallback, CancellationToken cancellationToken = default);

    Task SaveAsync<T>(string key, T value, CancellationToken cancellationToken = default);

    Task DeleteAsync(string key, CancellationToken cancellationToken = default);
}
