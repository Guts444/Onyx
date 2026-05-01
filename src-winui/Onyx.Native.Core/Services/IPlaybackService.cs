using Onyx.Native.Core.Models;

namespace Onyx.Native.Core.Services;

public sealed record PlaybackStatusUpdate(string Message, bool IsError = false);

public interface IPlaybackService
{
    event EventHandler<PlaybackStatusUpdate>? StatusChanged;

    Task PlayAsync(Channel channel, CancellationToken cancellationToken = default);

    Task StopAsync(CancellationToken cancellationToken = default);
}
