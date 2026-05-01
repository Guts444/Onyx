using Onyx.Native.Core.Models;

namespace Onyx.Native.Core.Services;

public sealed class StubPlaybackService : IPlaybackService
{
    public Channel? CurrentChannel { get; private set; }

    public event EventHandler<PlaybackStatusUpdate>? StatusChanged;

    public Task PlayAsync(Channel channel, CancellationToken cancellationToken = default)
    {
        CurrentChannel = channel;
        StatusChanged?.Invoke(this, new PlaybackStatusUpdate("Stub playback service selected."));
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken = default)
    {
        CurrentChannel = null;
        StatusChanged?.Invoke(this, new PlaybackStatusUpdate("Playback stopped."));
        return Task.CompletedTask;
    }
}
