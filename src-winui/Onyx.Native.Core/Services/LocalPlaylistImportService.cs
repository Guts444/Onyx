using System.Net.Http.Headers;
using System.Text.Json;
using Onyx.Native.Core.Models;
using Onyx.Native.Core.Parsing;

namespace Onyx.Native.Core.Services;

public sealed class LocalPlaylistImportService : IPlaylistImportService
{
    private const int MaxPlaylistBytes = 32 * 1024 * 1024;
    private const int MaxXtreamBytes = 32 * 1024 * 1024;
    private readonly M3uPlaylistParser _parser;
    private readonly HttpClient _httpClient;

    public LocalPlaylistImportService(M3uPlaylistParser parser, HttpClient? httpClient = null)
    {
        _parser = parser;
        _httpClient = httpClient ?? CreateDefaultHttpClient();
    }

    public async Task<PlaylistImport> ImportLocalFileAsync(
        string filePath,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            throw new ArgumentException("Choose a playlist file first.", nameof(filePath));
        }

        var playlistText = await File.ReadAllTextAsync(filePath, cancellationToken);
        return _parser.Parse(playlistText, Path.GetFileName(filePath));
    }

    public async Task<PlaylistImport> ImportRemoteM3uAsync(
        string url,
        CancellationToken cancellationToken = default)
    {
        var normalizedUrl = NormalizePlaylistUrlInput(url);
        var playlistText = await FetchTextWithLimitAsync(
            normalizedUrl,
            MaxPlaylistBytes,
            "Could not download the playlist",
            cancellationToken);
        return _parser.Parse(playlistText, normalizedUrl.Host);
    }

    public async Task<PlaylistImport> ImportXtreamLiveAsync(
        string domain,
        string username,
        string password,
        CancellationToken cancellationToken = default)
    {
        var trimmedUsername = username.Trim();
        var trimmedPassword = password.Trim();

        if (trimmedUsername.Length == 0 || trimmedPassword.Length == 0)
        {
            throw new InvalidOperationException("Xtream username and password are required.");
        }

        var normalizedDomain = NormalizeXtreamDomainInput(domain);

        using var authDocument = await FetchJsonDocumentAsync(
            BuildPlayerApiUrl(normalizedDomain, trimmedUsername, trimmedPassword, null),
            MaxXtreamBytes,
            "Could not reach the Xtream login endpoint",
            cancellationToken);

        var userInfo = GetRequiredObject(authDocument.RootElement, "user_info");
        if (!IsTruthy(GetProperty(userInfo, "auth")))
        {
            var providerMessage = GetString(GetProperty(userInfo, "message"))
                ?? GetString(GetProperty(userInfo, "status"))
                ?? "authentication failed";
            throw new InvalidOperationException($"Xtream login failed: {providerMessage}.");
        }

        var categories = await FetchCategoriesAsync(
            normalizedDomain,
            trimmedUsername,
            trimmedPassword,
            cancellationToken);

        using var streamsDocument = await FetchJsonDocumentAsync(
            BuildPlayerApiUrl(normalizedDomain, trimmedUsername, trimmedPassword, "get_live_streams"),
            MaxXtreamBytes,
            "Could not download Xtream live streams",
            cancellationToken);

        if (streamsDocument.RootElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException("The Xtream streams response was not an array.");
        }

        var outputExtension = ChooseOutputExtension(authDocument.RootElement);
        var streamOrigin = BuildStreamOrigin(authDocument.RootElement, normalizedDomain);
        var providerName = streamOrigin.Host.Length == 0 ? "Xtream" : streamOrigin.Host;
        var channels = new List<Channel>();
        var disabledChannelCount = 0;

        foreach (var stream in streamsDocument.RootElement.EnumerateArray())
        {
            var streamId = GetString(GetProperty(stream, "stream_id"));
            if (string.IsNullOrWhiteSpace(streamId))
            {
                continue;
            }

            var channelName = GetString(GetProperty(stream, "name")) ?? $"Stream {streamId}";
            var categoryId = GetString(GetProperty(stream, "category_id")) ?? string.Empty;
            var groupName = categories.GetValueOrDefault(categoryId, "Ungrouped");
            var directSource = GetString(GetProperty(stream, "direct_source"));
            var streamUrl = !string.IsNullOrWhiteSpace(directSource)
                ? directSource
                : BuildXtreamStreamUrl(streamOrigin, trimmedUsername, trimmedPassword, streamId, outputExtension);

            var channel = ChannelFactory.BuildChannel(new ChannelSeed(
                channelName,
                streamUrl,
                groupName,
                streamUrl,
                GetString(GetProperty(stream, "stream_icon")),
                GetString(GetProperty(stream, "epg_channel_id")),
                channelName));

            if (!channel.IsPlayable)
            {
                disabledChannelCount++;
            }

            channels.Add(channel);
        }

        if (channels.Count == 0)
        {
            throw new InvalidOperationException("The Xtream account returned no live channels.");
        }

        var groups = channels
            .Select(channel => channel.Group)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.CurrentCulture)
            .ToArray();

        return new PlaylistImport(
            ChannelFactory.SanitizeLabel($"{providerName} Xtream", "Xtream playlist", 80),
            channels,
            groups,
            DateTimeOffset.UtcNow,
            disabledChannelCount,
            0);
    }

    private static HttpClient CreateDefaultHttpClient()
    {
        var handler = new SocketsHttpHandler
        {
            ConnectTimeout = TimeSpan.FromSeconds(15),
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 5
        };

        var client = new HttpClient(handler)
        {
            Timeout = TimeSpan.FromSeconds(45)
        };
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("onyx", "0.1"));
        return client;
    }

    private async Task<Dictionary<string, string>> FetchCategoriesAsync(
        Uri normalizedDomain,
        string username,
        string password,
        CancellationToken cancellationToken)
    {
        using var categoriesDocument = await FetchJsonDocumentAsync(
            BuildPlayerApiUrl(normalizedDomain, username, password, "get_live_categories"),
            MaxXtreamBytes,
            "Could not download Xtream live categories",
            cancellationToken);

        if (categoriesDocument.RootElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException("The Xtream categories response was not an array.");
        }

        var categories = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var category in categoriesDocument.RootElement.EnumerateArray())
        {
            var categoryId = GetString(GetProperty(category, "category_id"));
            if (categoryId is null)
            {
                continue;
            }

            categories[categoryId] = GetString(GetProperty(category, "category_name")) ?? "Ungrouped";
        }

        return categories;
    }

    private async Task<JsonDocument> FetchJsonDocumentAsync(
        Uri url,
        int byteLimit,
        string failureLabel,
        CancellationToken cancellationToken)
    {
        var text = await FetchTextWithLimitAsync(url, byteLimit, failureLabel, cancellationToken);

        try
        {
            return JsonDocument.Parse(text);
        }
        catch (JsonException error)
        {
            throw new InvalidOperationException($"{failureLabel}: the provider response was not valid JSON.", error);
        }
    }

    private async Task<string> FetchTextWithLimitAsync(
        Uri url,
        int byteLimit,
        string failureLabel,
        CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"The request failed with HTTP {(int)response.StatusCode}.");
        }

        if (response.Content.Headers.ContentLength is > 0 and var contentLength
            && contentLength > byteLimit)
        {
            throw new InvalidOperationException("The response is too large to import safely.");
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;

        while ((read = await stream.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + read > byteLimit)
            {
                throw new InvalidOperationException("The response is too large to import safely.");
            }

            buffer.Write(chunk, 0, read);
        }

        var responseText = System.Text.Encoding.UTF8.GetString(buffer.ToArray());
        if (string.IsNullOrWhiteSpace(responseText))
        {
            throw new InvalidOperationException($"{failureLabel}: the server returned an empty response.");
        }

        return responseText;
    }

    internal static Uri NormalizePlaylistUrlInput(string rawInput)
    {
        var trimmedInput = rawInput.Trim();
        if (trimmedInput.Length == 0)
        {
            throw new InvalidOperationException("Enter the playlist URL first.");
        }

        var normalizedInput =
            trimmedInput.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || trimmedInput.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                ? trimmedInput
                : $"https://{trimmedInput}";

        if (!Uri.TryCreate(normalizedInput, UriKind.Absolute, out var parsedUrl))
        {
            throw new InvalidOperationException("The playlist URL is not valid.");
        }

        if (parsedUrl.Scheme is not ("http" or "https"))
        {
            throw new InvalidOperationException("Only http and https playlist URLs are supported.");
        }

        return parsedUrl;
    }

    internal static Uri NormalizeXtreamDomainInput(string rawInput)
    {
        var trimmedInput = rawInput.Trim().TrimEnd('/');

        if (trimmedInput.Length == 0)
        {
            throw new InvalidOperationException("Enter the Xtream domain first.");
        }

        var normalizedInput =
            trimmedInput.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || trimmedInput.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                ? trimmedInput
                : $"http://{trimmedInput}";

        if (!Uri.TryCreate(normalizedInput, UriKind.Absolute, out var parsedUrl))
        {
            throw new InvalidOperationException("The Xtream domain is not valid.");
        }

        if (parsedUrl.Scheme is not ("http" or "https"))
        {
            throw new InvalidOperationException("Xtream domain must use http or https.");
        }

        var builder = new UriBuilder(parsedUrl)
        {
            Query = string.Empty,
            Fragment = string.Empty
        };

        if (!builder.Path.EndsWith('/'))
        {
            builder.Path = $"{builder.Path.TrimEnd('/')}/";
        }

        return builder.Uri;
    }

    private static Uri BuildPlayerApiUrl(Uri baseUrl, string username, string password, string? action)
    {
        var builder = new UriBuilder(new Uri(baseUrl, "player_api.php"));
        var query = new List<string>
        {
            $"username={Uri.EscapeDataString(username)}",
            $"password={Uri.EscapeDataString(password)}"
        };

        if (action is not null)
        {
            query.Add($"action={Uri.EscapeDataString(action)}");
        }

        builder.Query = string.Join('&', query);
        return builder.Uri;
    }

    private static string ChooseOutputExtension(JsonElement authResponse)
    {
        var formats = GetProperty(GetProperty(authResponse, "user_info"), "allowed_output_formats");
        if (formats?.ValueKind != JsonValueKind.Array)
        {
            return "ts";
        }

        var availableFormats = formats.Value
            .EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : null)
            .Where(format => !string.IsNullOrWhiteSpace(format))
            .Cast<string>()
            .ToArray();

        if (availableFormats.Contains("ts", StringComparer.OrdinalIgnoreCase))
        {
            return "ts";
        }

        if (availableFormats.Contains("m3u8", StringComparer.OrdinalIgnoreCase))
        {
            return "m3u8";
        }

        return availableFormats.FirstOrDefault() ?? "ts";
    }

    private static Uri BuildStreamOrigin(JsonElement authResponse, Uri fallbackUrl)
    {
        var serverInfo = GetRequiredObject(authResponse, "server_info");
        var scheme = GetString(GetProperty(serverInfo, "server_protocol")) ?? fallbackUrl.Scheme;
        var host = GetString(GetProperty(serverInfo, "url")) ?? fallbackUrl.Host;

        if (host.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || host.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            host = new Uri(host).Host;
        }

        var portKey = scheme.Equals("https", StringComparison.OrdinalIgnoreCase)
            ? "https_port"
            : "port";
        var port = GetString(GetProperty(serverInfo, portKey)) is { } portText
            && int.TryParse(portText, out var parsedPort)
                ? parsedPort
                : fallbackUrl.Port;

        var isDefaultPort =
            (scheme.Equals("http", StringComparison.OrdinalIgnoreCase) && port is 80 or -1)
            || (scheme.Equals("https", StringComparison.OrdinalIgnoreCase) && port is 443 or -1);

        var builder = new UriBuilder(scheme, host)
        {
            Path = "/"
        };

        if (!isDefaultPort && port > 0)
        {
            builder.Port = port;
        }

        return builder.Uri;
    }

    private static string BuildXtreamStreamUrl(
        Uri streamOrigin,
        string username,
        string password,
        string streamId,
        string extension)
    {
        return new Uri(
            streamOrigin,
            $"live/{Uri.EscapeDataString(username)}/{Uri.EscapeDataString(password)}/{Uri.EscapeDataString(streamId)}.{extension}")
            .ToString();
    }

    private static JsonElement GetRequiredObject(JsonElement value, string key)
    {
        return GetProperty(value, key)
            ?? throw new InvalidOperationException($"The provider response is missing `{key}`.");
    }

    private static JsonElement? GetProperty(JsonElement? value, string key)
    {
        return value is { ValueKind: JsonValueKind.Object } element && element.TryGetProperty(key, out var property)
            ? property
            : null;
    }

    private static string? GetString(JsonElement? value)
    {
        return value?.ValueKind switch
        {
            JsonValueKind.String => string.IsNullOrWhiteSpace(value.Value.GetString())
                ? null
                : value.Value.GetString()!.Trim(),
            JsonValueKind.Number => value.Value.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => null
        };
    }

    private static bool IsTruthy(JsonElement? value)
    {
        return value?.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.Number => value.Value.TryGetInt64(out var number) && number != 0,
            JsonValueKind.String => value.Value.GetString() is { } text
                && text.Trim() is "1" or "true" or "True" or "yes",
            _ => false
        };
    }
}
