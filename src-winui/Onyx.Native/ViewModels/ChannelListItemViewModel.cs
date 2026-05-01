using Onyx.Native.Core.Models;

namespace Onyx.Native.ViewModels;

public sealed class ChannelListItemViewModel : ObservableObject
{
    private bool _isFavorite;
    private bool _isRecent;

    public ChannelListItemViewModel(Channel channel, bool isFavorite, bool isRecent)
    {
        Channel = channel;
        _isFavorite = isFavorite;
        _isRecent = isRecent;
    }

    public Channel Channel { get; }

    public string Id => Channel.Id;

    public string Name => Channel.Name;

    public string Group => Channel.Group;

    public string Stream => Channel.Stream;

    public string Status => Channel.IsPlayable ? "Ready" : Channel.PlayabilityError ?? "Unavailable";

    public bool IsPlayable => Channel.IsPlayable;

    public bool IsFavorite
    {
        get => _isFavorite;
        private set => SetProperty(ref _isFavorite, value);
    }

    public bool IsRecent
    {
        get => _isRecent;
        private set => SetProperty(ref _isRecent, value);
    }

    public string FavoriteLabel => IsFavorite ? "Favorite" : string.Empty;

    public string RecentLabel => IsRecent ? "Recent" : string.Empty;

    public void UpdateFlags(bool isFavorite, bool isRecent)
    {
        var favoriteChanged = SetProperty(ref _isFavorite, isFavorite, nameof(IsFavorite));
        var recentChanged = SetProperty(ref _isRecent, isRecent, nameof(IsRecent));

        if (favoriteChanged)
        {
            OnPropertyChanged(nameof(FavoriteLabel));
        }

        if (recentChanged)
        {
            OnPropertyChanged(nameof(RecentLabel));
        }
    }
}
