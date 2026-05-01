using Microsoft.VisualStudio.TestTools.UnitTesting;
using Onyx.Native.Core.Parsing;

namespace Onyx.Native.Tests.Parsing;

[TestClass]
public sealed class M3uPlaylistParserTests
{
    [TestMethod]
    public void ParseReadsExtinfMetadataAndGroups()
    {
        var parser = new M3uPlaylistParser();
        var playlist = parser.Parse(
            """
            #EXTM3U
            #EXTINF:-1 tvg-id="news.us" tvg-name="News HD" tvg-logo="https://example.test/logo.png" group-title="News",News Display
            https://example.test/live/news.m3u8
            #EXTINF:-1 group-title="Sports",Sports One
            udp://@239.0.0.1:1234
            """,
            "sample.m3u");

        Assert.AreEqual("sample", playlist.Name);
        Assert.AreEqual(2, playlist.Channels.Count);
        CollectionAssert.AreEquivalent(new[] { "News", "Sports" }, playlist.Groups.ToArray());
        Assert.AreEqual("News HD", playlist.Channels[0].Name);
        Assert.AreEqual("news.us", playlist.Channels[0].TvgId);
        Assert.AreEqual("News", playlist.Channels[0].Group);
    }

    [TestMethod]
    public void ParseUsesExtgrpAsFallbackGroup()
    {
        var parser = new M3uPlaylistParser();
        var playlist = parser.Parse(
            """
            #EXTM3U
            #EXTGRP:Local
            C:\media\channel.ts
            """,
            "local.m3u8");

        Assert.AreEqual(1, playlist.Channels.Count);
        Assert.AreEqual("Local", playlist.Channels[0].Group);
        Assert.IsTrue(playlist.Channels[0].IsPlayable);
    }

    [TestMethod]
    public void ParseMarksUnsupportedStreamsUnavailable()
    {
        var parser = new M3uPlaylistParser();
        var playlist = parser.Parse(
            """
            #EXTM3U
            #EXTINF:-1 group-title="Bad",FTP Channel
            ftp://example.test/channel.ts
            """,
            "bad.m3u");

        Assert.AreEqual(1, playlist.DisabledChannelCount);
        Assert.IsFalse(playlist.Channels[0].IsPlayable);
        Assert.AreEqual("Unsupported stream protocol: ftp:", playlist.Channels[0].PlayabilityError);
    }

    [TestMethod]
    public void ParseCountsDanglingMetadataAsSkippedEntry()
    {
        var parser = new M3uPlaylistParser();
        var playlist = parser.Parse(
            """
            #EXTM3U
            #EXTINF:-1 group-title="One",First
            #EXTINF:-1 group-title="Two",Second
            https://example.test/two.m3u8
            """,
            "skipped.m3u");

        Assert.AreEqual(1, playlist.SkippedEntryCount);
        Assert.AreEqual("Second", playlist.Channels[0].Name);
    }

    [TestMethod]
    public void ParseThrowsWhenPlaylistHasNoChannels()
    {
        var parser = new M3uPlaylistParser();

        Assert.ThrowsExactly<InvalidOperationException>(() => parser.Parse("#EXTM3U", "empty.m3u"));
    }
}
