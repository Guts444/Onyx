using System.Net;
using Onyx.Native.Core.Parsing;
using Onyx.Native.Core.Services;

namespace Onyx.Native.Tests.Services;

[TestClass]
public sealed class XtreamImportTests
{
    [TestMethod]
    public async Task ImportXtreamLiveAsync_maps_live_streams_to_channels()
    {
        var service = new LocalPlaylistImportService(
            new M3uPlaylistParser(),
            new HttpClient(new FakeXtreamHandler())
            {
                BaseAddress = new Uri("http://example.test")
            });

        var playlist = await service.ImportXtreamLiveAsync("example.test:8080", "demo", "secret");

        Assert.AreEqual("stream.example.test Xtream", playlist.Name);
        Assert.AreEqual(2, playlist.Channels.Count);
        Assert.AreEqual("News One", playlist.Channels[0].Name);
        Assert.AreEqual("News", playlist.Channels[0].Group);
        Assert.AreEqual("http://stream.example.test:8080/live/demo/secret/100.ts", playlist.Channels[0].Stream);
        Assert.AreEqual("Sports Direct", playlist.Channels[1].Name);
        Assert.AreEqual("Sports", playlist.Channels[1].Group);
        Assert.AreEqual("https://cdn.example.test/live/sports.m3u8", playlist.Channels[1].Stream);
        Assert.AreEqual(0, playlist.DisabledChannelCount);
    }

    [TestMethod]
    public async Task ImportXtreamLiveAsync_reports_auth_failure_message()
    {
        var service = new LocalPlaylistImportService(
            new M3uPlaylistParser(),
            new HttpClient(new FakeXtreamHandler(authenticated: false)));

        try
        {
            _ = await service.ImportXtreamLiveAsync("example.test", "demo", "secret");
            Assert.Fail("Expected an Xtream auth failure.");
        }
        catch (InvalidOperationException error)
        {
            Assert.AreEqual("Xtream login failed: Invalid credentials.", error.Message);
        }
    }

    private sealed class FakeXtreamHandler : HttpMessageHandler
    {
        private readonly bool _authenticated;

        public FakeXtreamHandler(bool authenticated = true)
        {
            _authenticated = authenticated;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var query = request.RequestUri?.Query ?? string.Empty;
            var response = query switch
            {
                var value when value.Contains("get_live_categories", StringComparison.Ordinal) =>
                    """
                    [
                      { "category_id": "1", "category_name": "News" },
                      { "category_id": "2", "category_name": "Sports" }
                    ]
                    """,
                var value when value.Contains("get_live_streams", StringComparison.Ordinal) =>
                    """
                    [
                      {
                        "stream_id": "100",
                        "name": "News One",
                        "category_id": "1",
                        "stream_icon": "https://example.test/news.png",
                        "epg_channel_id": "news.one"
                      },
                      {
                        "stream_id": "200",
                        "name": "Sports Direct",
                        "category_id": "2",
                        "direct_source": "https://cdn.example.test/live/sports.m3u8"
                      }
                    ]
                    """,
                _ when _authenticated =>
                    """
                    {
                      "user_info": {
                        "auth": 1,
                        "allowed_output_formats": ["m3u8", "ts"]
                      },
                      "server_info": {
                        "server_protocol": "http",
                        "url": "stream.example.test",
                        "port": "8080"
                      }
                    }
                    """,
                _ =>
                    """
                    {
                      "user_info": {
                        "auth": 0,
                        "message": "Invalid credentials"
                      },
                      "server_info": {
                        "server_protocol": "http",
                        "url": "stream.example.test",
                        "port": "8080"
                      }
                    }
                    """
            };

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(response)
            });
        }
    }
}
