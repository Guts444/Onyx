using Onyx.Native.Core.Services;
using Windows.Security.Credentials;

namespace Onyx.Native.Infrastructure;

public sealed class WindowsCredentialService : ICredentialService
{
    private const string ResourceName = "Onyx.Native Xtream";
    private readonly PasswordVault _vault = new();

    public Task<string?> LoadSecretAsync(string key, CancellationToken cancellationToken = default)
    {
        try
        {
            var credential = _vault.Retrieve(ResourceName, key);
            credential.RetrievePassword();
            return Task.FromResult<string?>(credential.Password);
        }
        catch
        {
            return Task.FromResult<string?>(null);
        }
    }

    public async Task SaveSecretAsync(string key, string secret, CancellationToken cancellationToken = default)
    {
        await DeleteSecretAsync(key, cancellationToken);

        if (!string.IsNullOrEmpty(secret))
        {
            _vault.Add(new PasswordCredential(ResourceName, key, secret));
        }
    }

    public Task DeleteSecretAsync(string key, CancellationToken cancellationToken = default)
    {
        try
        {
            var credential = _vault.Retrieve(ResourceName, key);
            _vault.Remove(credential);
        }
        catch
        {
            // Missing credentials are fine during profile cleanup.
        }

        return Task.CompletedTask;
    }
}
