using System.Collections.ObjectModel;
using System.Security.Cryptography;
using System.Text;
using Onyx.Native.Core.Models;
using Onyx.Native.Core.Services;

namespace Onyx.Native.ViewModels;

public sealed class MainViewModel : ObservableObject
{
    private const string AllChannelsGroupId = "__all__";
    private const string FavoritesGroupId = "__favorites__";
    private const string RecentsGroupId = "__recents__";
    private const string FavoritesStorageKey = "native:favorites";
    private const string RecentsStorageKey = "native:recents";
    private const string PlaybackSessionStorageKey = "native:playback-session";
    private const string SavedXtreamSourcePrefix = "native_xtream_";
    private const int RecentLimit = 12;

    private readonly IPlaylistImportService _playlistImport;
    private readonly IPersistenceService _persistence;
    private readonly ISourceProfileService _sourceProfiles;
    private readonly IEpgService _epg;
    private readonly IPlaybackService _playback;
    private readonly ICredentialService _credentials;
    private readonly HashSet<string> _favoriteIds = new(StringComparer.Ordinal);
    private readonly List<string> _recentIds = [];
    private List<SavedPlaylistSource> _savedSources = [];
    private IReadOnlyList<Channel> _allChannels = [];
    private PlaylistImport? _playlist;
    private NavigationSection _selectedSection = NavigationSection.LiveTv;
    private GroupSummary? _selectedGroup;
    private ChannelListItemViewModel? _selectedChannelItem;
    private Channel? _selectedChannel;
    private string _searchQuery = string.Empty;
    private string _statusMessage = "Import a local M3U or M3U8 file to start the native prototype.";
    private string _playlistSummary = "No source loaded";
    private string _playerTitle = "No channel selected";
    private string _playerStatus = "Select a channel to start native playback.";
    private string _xtreamDomain = string.Empty;
    private string _xtreamUsername = string.Empty;
    private bool _isBusy;

    public MainViewModel(
        IPlaylistImportService playlistImport,
        IPersistenceService persistence,
        ISourceProfileService sourceProfiles,
        IEpgService epg,
        IPlaybackService playback,
        ICredentialService credentials)
    {
        _playlistImport = playlistImport;
        _persistence = persistence;
        _sourceProfiles = sourceProfiles;
        _epg = epg;
        _playback = playback;
        _credentials = credentials;
        _playback.StatusChanged += OnPlaybackStatusChanged;
        ClearSearchCommand = new RelayCommand(() => SearchQuery = string.Empty);
        ToggleFavoriteCommand = new RelayCommand(() => _ = ToggleSelectedFavoriteAsync(), () => SelectedChannel is not null);
        StopPlaybackCommand = new RelayCommand(() => _ = StopPlaybackAsync());
    }

    public ObservableCollection<GroupSummary> Groups { get; } = [];

    public ObservableCollection<ChannelListItemViewModel> Channels { get; } = [];

    public RelayCommand ClearSearchCommand { get; }

    public RelayCommand ToggleFavoriteCommand { get; }

    public RelayCommand StopPlaybackCommand { get; }

    public NavigationSection SelectedSection
    {
        get => _selectedSection;
        set
        {
            if (SetProperty(ref _selectedSection, value))
            {
                OnPropertyChanged(nameof(IsLiveTvVisible));
                OnPropertyChanged(nameof(IsSettingsVisible));
            }
        }
    }

    public bool IsLiveTvVisible => SelectedSection == NavigationSection.LiveTv;

    public bool IsSettingsVisible => SelectedSection == NavigationSection.Settings;

    public GroupSummary? SelectedGroup
    {
        get => _selectedGroup;
        set
        {
            if (SetProperty(ref _selectedGroup, value))
            {
                ApplyChannelFilter();
            }
        }
    }

    public ChannelListItemViewModel? SelectedChannelItem
    {
        get => _selectedChannelItem;
        set
        {
            if (SetProperty(ref _selectedChannelItem, value) && value is not null)
            {
                _ = SelectChannelAsync(value.Channel);
            }
        }
    }

    public Channel? SelectedChannel
    {
        get => _selectedChannel;
        private set
        {
            if (SetProperty(ref _selectedChannel, value))
            {
                ToggleFavoriteCommand.RaiseCanExecuteChanged();
                OnPropertyChanged(nameof(SelectedChannelName));
                OnPropertyChanged(nameof(FavoriteButtonLabel));
            }
        }
    }

    public string SelectedChannelName => SelectedChannel?.Name ?? "No channel selected";

    public string FavoriteButtonLabel => SelectedChannel is not null && _favoriteIds.Contains(SelectedChannel.Id)
        ? "Remove favorite"
        : "Add favorite";

    public string SearchQuery
    {
        get => _searchQuery;
        set
        {
            if (SetProperty(ref _searchQuery, value))
            {
                ApplyChannelFilter();
            }
        }
    }

    public string StatusMessage
    {
        get => _statusMessage;
        private set => SetProperty(ref _statusMessage, value);
    }

    public string PlaylistSummary
    {
        get => _playlistSummary;
        private set => SetProperty(ref _playlistSummary, value);
    }

    public string PlayerTitle
    {
        get => _playerTitle;
        private set => SetProperty(ref _playerTitle, value);
    }

    public string PlayerStatus
    {
        get => _playerStatus;
        private set => SetProperty(ref _playerStatus, value);
    }

    public string XtreamDomain
    {
        get => _xtreamDomain;
        set => SetProperty(ref _xtreamDomain, value);
    }

    public string XtreamUsername
    {
        get => _xtreamUsername;
        set => SetProperty(ref _xtreamUsername, value);
    }

    public bool IsBusy
    {
        get => _isBusy;
        private set
        {
            if (SetProperty(ref _isBusy, value))
            {
                OnPropertyChanged(nameof(CanImport));
            }
        }
    }

    public bool CanImport => !IsBusy;

    public async Task LoadAsync()
    {
        var favorites = await _persistence.LoadAsync<IReadOnlyList<string>>(FavoritesStorageKey, []);
        var recents = await _persistence.LoadAsync<IReadOnlyList<string>>(RecentsStorageKey, []);

        _favoriteIds.Clear();
        foreach (var favoriteId in favorites.Where(id => !string.IsNullOrWhiteSpace(id)))
        {
            _favoriteIds.Add(favoriteId);
        }

        _recentIds.Clear();
        _recentIds.AddRange(recents.Where(id => !string.IsNullOrWhiteSpace(id)).Take(RecentLimit));

        _savedSources = (await _sourceProfiles.LoadAsync()).ToList();
        _ = await _epg.LoadSourcesAsync();

        var xtreamSource = _savedSources.FirstOrDefault(source => source.Kind == SavedPlaylistSourceKind.Xtream);
        if (xtreamSource is not null)
        {
            XtreamDomain = xtreamSource.Domain ?? string.Empty;
            XtreamUsername = xtreamSource.Username ?? string.Empty;
        }

        RebuildGroups();
        ApplyChannelFilter();
    }

    public async Task ImportLocalPlaylistAsync(string filePath)
    {
        try
        {
            IsBusy = true;
            StatusMessage = "Importing local playlist...";

            ApplyPlaylist(await _playlistImport.ImportLocalFileAsync(filePath), "Imported local playlist.");
        }
        catch (Exception error)
        {
            StatusMessage = error.Message;
        }
        finally
        {
            IsBusy = false;
        }
    }

    public async Task ImportXtreamLiveAsync(string password, bool rememberLogin)
    {
        var trimmedDomain = XtreamDomain.Trim();
        var trimmedUsername = XtreamUsername.Trim();
        var trimmedPassword = password.Trim();

        try
        {
            IsBusy = true;
            StatusMessage = "Signing in to Xtream...";

            var savedSource = FindSavedXtreamSource(trimmedDomain, trimmedUsername);
            if (trimmedPassword.Length == 0 && savedSource is not null)
            {
                trimmedPassword = await _credentials.LoadSecretAsync(savedSource.Id) ?? string.Empty;
            }

            if (trimmedPassword.Length == 0)
            {
                throw new InvalidOperationException("Enter the Xtream password or save a login first.");
            }

            var playlist = await _playlistImport.ImportXtreamLiveAsync(
                trimmedDomain,
                trimmedUsername,
                trimmedPassword);
            ApplyPlaylist(playlist, "Imported Xtream live TV.");

            if (rememberLogin)
            {
                await SaveXtreamSourceAsync(trimmedDomain, trimmedUsername, trimmedPassword);
            }
        }
        catch (Exception error)
        {
            StatusMessage = error.Message;
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task SelectChannelAsync(Channel channel)
    {
        SelectChannelWithoutListFeedback(channel);

        if (!channel.IsPlayable)
        {
            return;
        }

        await _playback.PlayAsync(channel);
        await PushRecentAsync(channel.Id);
        await _persistence.SaveAsync(
            PlaybackSessionStorageKey,
            new PlaybackSession(null, channel.Id, false, null, null, false));
    }

    private void SelectChannelWithoutListFeedback(Channel channel)
    {
        SelectedChannel = channel;
        PlayerTitle = channel.Name;
        PlayerStatus = channel.IsPlayable
            ? "Loading stream with native libmpv..."
            : channel.PlayabilityError ?? "This channel is unavailable.";

        foreach (var item in Channels)
        {
            if (item.Id == channel.Id && SelectedChannelItem != item)
            {
                _selectedChannelItem = item;
                OnPropertyChanged(nameof(SelectedChannelItem));
                break;
            }
        }
    }

    private void ApplyPlaylist(PlaylistImport playlist, string statusPrefix)
    {
        _playlist = playlist;
        _allChannels = playlist.Channels;

        PlaylistSummary =
            $"{playlist.Name}: {playlist.Channels.Count:N0} channels, {playlist.Groups.Count:N0} groups";
        StatusMessage = playlist.DisabledChannelCount > 0
            ? $"{statusPrefix} {playlist.Channels.Count:N0} channels loaded. {playlist.DisabledChannelCount:N0} entries are marked unavailable."
            : $"{statusPrefix} {playlist.Channels.Count:N0} channels loaded.";

        RebuildGroups();
        SelectedGroup = Groups.FirstOrDefault(group => group.Id == AllChannelsGroupId);

        var firstPlayable = _allChannels.FirstOrDefault(channel => channel.IsPlayable) ?? _allChannels.FirstOrDefault();
        if (firstPlayable is not null)
        {
            SelectChannelWithoutListFeedback(firstPlayable);
        }
    }

    private async Task StopPlaybackAsync()
    {
        await _playback.StopAsync();
        PlayerStatus = "Playback stopped.";
    }

    private async Task SaveXtreamSourceAsync(string domain, string username, string password)
    {
        var sourceId = CreateXtreamSourceId(domain, username);
        var now = DateTimeOffset.UtcNow;
        var existing = _savedSources.FirstOrDefault(source => source.Id == sourceId);
        var source = new SavedPlaylistSource(
            sourceId,
            SavedPlaylistSourceKind.Xtream,
            "Saved Xtream Login",
            true,
            existing?.CreatedAt ?? now,
            now,
            now,
            null,
            null,
            domain,
            username);

        _savedSources.RemoveAll(item => item.Id == sourceId);
        _savedSources.Add(source);
        await _sourceProfiles.SaveAsync(_savedSources);
        await _credentials.SaveSecretAsync(sourceId, password);
    }

    private SavedPlaylistSource? FindSavedXtreamSource(string domain, string username)
    {
        var domainKey = NormalizeSourceDomainKey(domain);
        var usernameKey = username.Trim();

        return _savedSources.FirstOrDefault(source =>
            source.Kind == SavedPlaylistSourceKind.Xtream
            && NormalizeSourceDomainKey(source.Domain ?? string.Empty) == domainKey
            && string.Equals(source.Username?.Trim(), usernameKey, StringComparison.Ordinal));
    }

    private static string CreateXtreamSourceId(string domain, string username)
    {
        var seed = $"{NormalizeSourceDomainKey(domain)}\u0001{username.Trim()}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(seed))).ToLowerInvariant();
        return $"{SavedXtreamSourcePrefix}{hash[..24]}";
    }

    private static string NormalizeSourceDomainKey(string domain)
    {
        return domain.Trim().TrimEnd('/').ToLowerInvariant();
    }

    private void OnPlaybackStatusChanged(object? sender, PlaybackStatusUpdate update)
    {
        PlayerStatus = update.Message;
        if (update.IsError)
        {
            StatusMessage = update.Message;
        }
    }

    private async Task ToggleSelectedFavoriteAsync()
    {
        if (SelectedChannel is null)
        {
            return;
        }

        if (!_favoriteIds.Add(SelectedChannel.Id))
        {
            _favoriteIds.Remove(SelectedChannel.Id);
        }

        await _persistence.SaveAsync(FavoritesStorageKey, _favoriteIds.Order(StringComparer.Ordinal).ToArray());
        OnPropertyChanged(nameof(FavoriteButtonLabel));
        RebuildGroups();
        ApplyChannelFilter();
    }

    private async Task PushRecentAsync(string channelId)
    {
        _recentIds.Remove(channelId);
        _recentIds.Insert(0, channelId);

        if (_recentIds.Count > RecentLimit)
        {
            _recentIds.RemoveRange(RecentLimit, _recentIds.Count - RecentLimit);
        }

        await _persistence.SaveAsync(RecentsStorageKey, _recentIds.ToArray());
        RebuildGroups();
        RefreshChannelFlags();
    }

    private void RebuildGroups()
    {
        var previousGroupId = SelectedGroup?.Id ?? AllChannelsGroupId;
        Groups.Clear();
        Groups.Add(new GroupSummary(AllChannelsGroupId, "All channels", _allChannels.Count));
        Groups.Add(new GroupSummary(FavoritesGroupId, "Favorites", _allChannels.Count(channel => _favoriteIds.Contains(channel.Id))));
        Groups.Add(new GroupSummary(RecentsGroupId, "Recents", _allChannels.Count(channel => _recentIds.Contains(channel.Id))));

        foreach (var group in _allChannels
            .GroupBy(channel => channel.Group)
            .OrderBy(group => group.Key, StringComparer.CurrentCultureIgnoreCase))
        {
            Groups.Add(new GroupSummary(group.Key, group.Key, group.Count()));
        }

        _selectedGroup = Groups.FirstOrDefault(group => group.Id == previousGroupId) ?? Groups.FirstOrDefault();
        OnPropertyChanged(nameof(SelectedGroup));
    }

    private void ApplyChannelFilter()
    {
        var channels = FilterByGroup(_allChannels, SelectedGroup?.Id ?? AllChannelsGroupId);
        var query = SearchQuery.Trim();

        if (query.Length > 0)
        {
            channels = channels.Where(channel =>
                channel.Name.Contains(query, StringComparison.CurrentCultureIgnoreCase)
                || channel.Group.Contains(query, StringComparison.CurrentCultureIgnoreCase)
                || (channel.TvgId?.Contains(query, StringComparison.CurrentCultureIgnoreCase) ?? false)
                || (channel.TvgName?.Contains(query, StringComparison.CurrentCultureIgnoreCase) ?? false));
        }

        Channels.Clear();
        foreach (var channel in channels)
        {
            Channels.Add(new ChannelListItemViewModel(
                channel,
                _favoriteIds.Contains(channel.Id),
                _recentIds.Contains(channel.Id)));
        }

        if (SelectedChannel is not null)
        {
            SelectChannelWithoutListFeedback(SelectedChannel);
        }
    }

    private IEnumerable<Channel> FilterByGroup(IEnumerable<Channel> channels, string selectedGroupId)
    {
        return selectedGroupId switch
        {
            FavoritesGroupId => channels.Where(channel => _favoriteIds.Contains(channel.Id)),
            RecentsGroupId => channels.Where(channel => _recentIds.Contains(channel.Id))
                .OrderBy(channel =>
                {
                    var index = _recentIds.IndexOf(channel.Id);
                    return index < 0 ? int.MaxValue : index;
                }),
            AllChannelsGroupId => channels,
            _ => channels.Where(channel => string.Equals(channel.Group, selectedGroupId, StringComparison.Ordinal))
        };
    }

    private void RefreshChannelFlags()
    {
        foreach (var item in Channels)
        {
            item.UpdateFlags(_favoriteIds.Contains(item.Id), _recentIds.Contains(item.Id));
        }
    }
}
