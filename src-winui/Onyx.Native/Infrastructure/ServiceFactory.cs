using Onyx.Native.Core.Parsing;
using Onyx.Native.Core.Services;
using Onyx.Native.Core.Storage;
using Onyx.Native.ViewModels;

namespace Onyx.Native.Infrastructure;

public static class ServiceFactory
{
    public static MainViewModel CreateMainViewModel(IPlaybackService playback)
    {
        var persistence = new JsonFilePersistenceService();
        var parser = new M3uPlaylistParser();
        var playlistImport = new LocalPlaylistImportService(parser);
        var sourceProfiles = new LocalSourceProfileService(persistence);
        var epg = new StubEpgService();
        var credentials = new WindowsCredentialService();

        return new MainViewModel(
            playlistImport,
            persistence,
            sourceProfiles,
            epg,
            playback,
            credentials);
    }
}
