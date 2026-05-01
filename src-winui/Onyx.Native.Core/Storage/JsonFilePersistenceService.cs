using System.Text;
using System.Text.Json;
using Onyx.Native.Core.Services;

namespace Onyx.Native.Core.Storage;

public sealed class JsonFilePersistenceService : IPersistenceService
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };

    private readonly string _stateDirectory;

    public JsonFilePersistenceService(string? rootDirectory = null)
    {
        var appDataRoot = rootDirectory
            ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Onyx.Native");

        _stateDirectory = Path.Combine(appDataRoot, "state");
    }

    public async Task<T> LoadAsync<T>(string key, T fallback, CancellationToken cancellationToken = default)
    {
        var path = GetStatePath(key);

        if (!File.Exists(path))
        {
            return fallback;
        }

        await using var stream = File.OpenRead(path);
        var value = await JsonSerializer.DeserializeAsync<T>(stream, SerializerOptions, cancellationToken);
        return value is null ? fallback : value;
    }

    public async Task SaveAsync<T>(string key, T value, CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(_stateDirectory);

        var path = GetStatePath(key);
        await using var stream = File.Create(path);
        await JsonSerializer.SerializeAsync(stream, value, SerializerOptions, cancellationToken);
    }

    public Task DeleteAsync(string key, CancellationToken cancellationToken = default)
    {
        var path = GetStatePath(key);

        if (File.Exists(path))
        {
            File.Delete(path);
        }

        return Task.CompletedTask;
    }

    private string GetStatePath(string key)
    {
        ValidateKey(key);
        return Path.Combine(_stateDirectory, $"{EncodeKey(key)}.json");
    }

    private static void ValidateKey(string key)
    {
        if (key.Length is 0 or > 160)
        {
            throw new ArgumentException("The app state key is not valid.", nameof(key));
        }

        if (!key.All(character => char.IsAsciiLetterOrDigit(character) || character is ':' or '-' or '_' or '.'))
        {
            throw new ArgumentException("The app state key contains unsupported characters.", nameof(key));
        }
    }

    private static string EncodeKey(string key)
    {
        return Convert.ToHexString(Encoding.UTF8.GetBytes(key)).ToLowerInvariant();
    }
}
