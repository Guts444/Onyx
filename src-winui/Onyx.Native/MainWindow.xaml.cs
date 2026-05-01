using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Onyx.Native.Infrastructure;
using Onyx.Native.ViewModels;
using Windows.Storage.Pickers;
using WinRT.Interop;

namespace Onyx.Native;

public sealed partial class MainWindow : Window
{
    private readonly MpvPlaybackService _playbackService;
    private AppWindow? _appWindow;
    private bool _isFullscreen;

    public MainWindow()
    {
        InitializeComponent();
        _playbackService = new MpvPlaybackService(WindowNative.GetWindowHandle(this), MpvHost);
        ViewModel = ServiceFactory.CreateMainViewModel(_playbackService);
        RootNavigation.DataContext = ViewModel;
        RootNavigation.SelectedItem = RootNavigation.MenuItems[0];
        UpdateSelectedView(NavigationSection.LiveTv);
        Closed += (_, _) => _playbackService.Dispose();
        _ = ViewModel.LoadAsync();
    }

    public MainViewModel ViewModel { get; }

    private async void ImportLocalPlaylist_Click(object sender, RoutedEventArgs e)
    {
        var picker = new FileOpenPicker
        {
            SuggestedStartLocation = PickerLocationId.DocumentsLibrary
        };
        picker.FileTypeFilter.Add(".m3u");
        picker.FileTypeFilter.Add(".m3u8");

        InitializeWithWindow.Initialize(picker, WindowNative.GetWindowHandle(this));
        var file = await picker.PickSingleFileAsync();

        if (file is not null)
        {
            await ViewModel.ImportLocalPlaylistAsync(file.Path);
        }
    }

    private async void ImportXtream_Click(object sender, RoutedEventArgs e)
    {
        await ViewModel.ImportXtreamLiveAsync(
            XtreamPasswordBox.Password,
            RememberXtreamCheckBox.IsChecked == true);

        XtreamPasswordBox.Password = string.Empty;
    }

    private void RootNavigation_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (args.SelectedItem is not NavigationViewItem item || item.Tag is not string tag)
        {
            return;
        }

        ViewModel.SelectedSection = tag == "Settings"
            ? NavigationSection.Settings
            : NavigationSection.LiveTv;
        UpdateSelectedView(ViewModel.SelectedSection);
    }

    private void UpdateSelectedView(NavigationSection section)
    {
        LiveTvView.Visibility = section == NavigationSection.LiveTv ? Visibility.Visible : Visibility.Collapsed;
        SettingsView.Visibility = section == NavigationSection.Settings ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ToggleFullscreen_Click(object sender, RoutedEventArgs e)
    {
        _appWindow ??= AppWindow.GetFromWindowId(
            Win32Interop.GetWindowIdFromWindow(WindowNative.GetWindowHandle(this)));

        if (_isFullscreen)
        {
            _appWindow.SetPresenter(AppWindowPresenterKind.Overlapped);
            _isFullscreen = false;
        }
        else
        {
            _appWindow.SetPresenter(AppWindowPresenterKind.FullScreen);
            _isFullscreen = true;
        }

        _playbackService.UpdateVideoBounds();
    }
}
