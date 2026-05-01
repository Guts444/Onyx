namespace Onyx.Native.Core.Services;

public interface ICredentialService
{
    Task<string?> LoadSecretAsync(string key, CancellationToken cancellationToken = default);

    Task SaveSecretAsync(string key, string secret, CancellationToken cancellationToken = default);

    Task DeleteSecretAsync(string key, CancellationToken cancellationToken = default);
}
