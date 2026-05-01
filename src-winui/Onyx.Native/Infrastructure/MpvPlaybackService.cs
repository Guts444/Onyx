using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.UI.Xaml;
using Onyx.Native.Core.Models;
using Onyx.Native.Core.Services;
using Windows.Foundation;

namespace Onyx.Native.Infrastructure;

public sealed class MpvPlaybackService : IPlaybackService, IDisposable
{
    private const int WsChild = 0x40000000;
    private const int WsVisible = 0x10000000;
    private const int WsClipSiblings = 0x04000000;
    private const int SwpNoZOrder = 0x0004;
    private const int SwpShowWindow = 0x0040;

    private readonly IntPtr _parentWindowHandle;
    private readonly FrameworkElement _hostElement;
    private IntPtr _videoWindowHandle;
    private IntPtr _mpvHandle;
    private bool _mpvInitialized;
    private bool _disposed;

    public MpvPlaybackService(IntPtr parentWindowHandle, FrameworkElement hostElement)
    {
        _parentWindowHandle = parentWindowHandle;
        _hostElement = hostElement;
        _hostElement.Loaded += (_, _) => UpdateVideoBounds();
        _hostElement.SizeChanged += (_, _) => UpdateVideoBounds();
        _hostElement.LayoutUpdated += (_, _) => UpdateVideoBounds();
    }

    public event EventHandler<PlaybackStatusUpdate>? StatusChanged;

    public Task PlayAsync(Channel channel, CancellationToken cancellationToken = default)
    {
        if (!channel.IsPlayable)
        {
            RaiseStatus(channel.PlayabilityError ?? "This channel is unavailable.", true);
            return Task.CompletedTask;
        }

        if (!EnsureMpvInitialized())
        {
            return Task.CompletedTask;
        }

        UpdateVideoBounds();

        var result = Command("loadfile", channel.Stream, "replace");
        if (result < 0)
        {
            RaiseStatus($"libmpv could not start playback: {GetError(result)}", true);
            return Task.CompletedTask;
        }

        RaiseStatus($"Playing {channel.Name}");
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken = default)
    {
        if (_mpvInitialized)
        {
            var result = Command("stop");
            if (result < 0)
            {
                RaiseStatus($"libmpv could not stop playback: {GetError(result)}", true);
                return Task.CompletedTask;
            }
        }

        RaiseStatus("Playback stopped.");
        return Task.CompletedTask;
    }

    public void UpdateVideoBounds()
    {
        if (_disposed)
        {
            return;
        }

        EnsureVideoWindow();

        if (_videoWindowHandle == IntPtr.Zero || _hostElement.ActualWidth <= 0 || _hostElement.ActualHeight <= 0)
        {
            return;
        }

        try
        {
            var point = _hostElement.TransformToVisual(null).TransformPoint(new Point(0, 0));
            _ = SetWindowPos(
                _videoWindowHandle,
                IntPtr.Zero,
                (int)Math.Round(point.X),
                (int)Math.Round(point.Y),
                (int)Math.Round(_hostElement.ActualWidth),
                (int)Math.Round(_hostElement.ActualHeight),
                SwpNoZOrder | SwpShowWindow);
        }
        catch
        {
            // Layout can briefly be unavailable while WinUI is changing presenters.
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        if (_mpvHandle != IntPtr.Zero)
        {
            mpv_terminate_destroy(_mpvHandle);
            _mpvHandle = IntPtr.Zero;
            _mpvInitialized = false;
        }

        if (_videoWindowHandle != IntPtr.Zero)
        {
            _ = DestroyWindow(_videoWindowHandle);
            _videoWindowHandle = IntPtr.Zero;
        }
    }

    private bool EnsureMpvInitialized()
    {
        if (_mpvInitialized)
        {
            return true;
        }

        EnsureVideoWindow();

        if (_videoWindowHandle == IntPtr.Zero)
        {
            RaiseStatus("The native video host could not be created.", true);
            return false;
        }

        try
        {
            _mpvHandle = mpv_create();
            if (_mpvHandle == IntPtr.Zero)
            {
                RaiseStatus("libmpv could not create a playback context.", true);
                return false;
            }

            CheckOption("wid", _videoWindowHandle.ToInt64().ToString(CultureInfo.InvariantCulture));
            CheckOption("vo", "gpu-next");
            CheckOption("hwdec", "auto-safe");
            CheckOption("keep-open", "yes");
            CheckOption("force-window", "yes");
            CheckOption("idle", "yes");
            CheckOption("osc", "no");

            var initResult = mpv_initialize(_mpvHandle);
            if (initResult < 0)
            {
                RaiseStatus($"libmpv could not initialize: {GetError(initResult)}", true);
                return false;
            }

            _mpvInitialized = true;
            RaiseStatus("Native libmpv player ready.");
            return true;
        }
        catch (DllNotFoundException)
        {
            RaiseStatus("libmpv-2.dll was not found. Run `npx tauri-plugin-libmpv-api setup-lib` from the repo root, then start the native app again.", true);
            return false;
        }
        catch (BadImageFormatException)
        {
            RaiseStatus("libmpv-2.dll is not compatible with this app architecture. Use the x64 libmpv build.", true);
            return false;
        }
        catch (Exception error)
        {
            RaiseStatus($"libmpv could not start: {error.Message}", true);
            return false;
        }
    }

    private void EnsureVideoWindow()
    {
        if (_videoWindowHandle != IntPtr.Zero || _parentWindowHandle == IntPtr.Zero)
        {
            return;
        }

        _videoWindowHandle = CreateWindowExW(
            0,
            "STATIC",
            string.Empty,
            WsChild | WsVisible | WsClipSiblings,
            0,
            0,
            1,
            1,
            _parentWindowHandle,
            IntPtr.Zero,
            IntPtr.Zero,
            IntPtr.Zero);
    }

    private void CheckOption(string name, string value)
    {
        var result = mpv_set_option_string(_mpvHandle, name, value);
        if (result < 0)
        {
            throw new InvalidOperationException($"Could not set mpv option `{name}`: {GetError(result)}");
        }
    }

    private int Command(params string[] arguments)
    {
        var argumentPointers = new List<IntPtr>();
        var pointerArray = IntPtr.Zero;

        try
        {
            pointerArray = Marshal.AllocHGlobal((arguments.Length + 1) * IntPtr.Size);

            for (var index = 0; index < arguments.Length; index++)
            {
                var bytes = Encoding.UTF8.GetBytes(arguments[index] + "\0");
                var argumentPointer = Marshal.AllocHGlobal(bytes.Length);
                Marshal.Copy(bytes, 0, argumentPointer, bytes.Length);
                argumentPointers.Add(argumentPointer);
                Marshal.WriteIntPtr(pointerArray, index * IntPtr.Size, argumentPointer);
            }

            Marshal.WriteIntPtr(pointerArray, arguments.Length * IntPtr.Size, IntPtr.Zero);
            return mpv_command(_mpvHandle, pointerArray);
        }
        finally
        {
            foreach (var pointer in argumentPointers)
            {
                Marshal.FreeHGlobal(pointer);
            }

            if (pointerArray != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(pointerArray);
            }
        }
    }

    private static string GetError(int code)
    {
        var pointer = mpv_error_string(code);
        return pointer == IntPtr.Zero
            ? $"mpv error {code}"
            : Marshal.PtrToStringUTF8(pointer) ?? $"mpv error {code}";
    }

    private void RaiseStatus(string message, bool isError = false)
    {
        StatusChanged?.Invoke(this, new PlaybackStatusUpdate(message, isError));
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(
        int dwExStyle,
        string lpClassName,
        string lpWindowName,
        int dwStyle,
        int x,
        int y,
        int nWidth,
        int nHeight,
        IntPtr hWndParent,
        IntPtr hMenu,
        IntPtr hInstance,
        IntPtr lpParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int cx,
        int cy,
        int uFlags);

    [DllImport("libmpv-2.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr mpv_create();

    [DllImport("libmpv-2.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int mpv_initialize(IntPtr ctx);

    [DllImport("libmpv-2.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void mpv_terminate_destroy(IntPtr ctx);

    [DllImport("libmpv-2.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int mpv_set_option_string(
        IntPtr ctx,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string name,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string data);

    [DllImport("libmpv-2.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int mpv_command(IntPtr ctx, IntPtr args);

    [DllImport("libmpv-2.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr mpv_error_string(int error);
}
