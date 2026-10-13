# Ergnova logo pack

Built from `logo.png` (the flame/chevron mark) with colors sampled from
`framed-logo.png` (background `#242A2A`, corner radius ≈ 19.5% — matches the
rounded variant below).

## The four styles

- **transparent-sizes/** — mark only, transparent background, generously
  filled (~88% of canvas). Use this for **Windows taskbar** and anywhere else
  you're displaying the logo directly with no OS-applied masking.
- **rounded-sizes/** — mark on the dark background, full-bleed square with
  rounded corners baked in (matches `framed-logo.png`'s look). For places
  *outside* the native icon pipeline where you want a pre-styled badge —
  README headers, marketing/store-listing images, social avatars, etc.
- **sharp-sizes/** — same composition, hard square corners, no rounding
  baked in. This is the one to feed into OS icon systems (see below) —
  Android/iOS/Windows all apply their *own* corner treatment at the OS level,
  so a pre-rounded source produces double-rounding artifacts.
- **masters/** — the four 2048px source files everything above was
  downsampled from, if you need to regenerate other sizes later.

There's a fifth, unlisted variant baked into `maui-source/` only:
**transparent-safezone** — the mark at a smaller ~55% fill, transparent bg.
Android's adaptive-icon mask (and the splash-screen equivalent) crops
anything near the edges of the source image, so the foreground/splash source
needs extra padding that a general-purpose transparent icon doesn't.

## Windows taskbar

`windows/appicon.ico` is a proper multi-resolution icon (16/24/32/48/256px,
transparent) built from the transparent master. MAUI's own resizetizer
*should* produce a working transparent taskbar icon from the `MauiIcon`
wiring below, but Windows taskbar transparency via MauiIcon has a history of
version-dependent quirks (github.com/dotnet/maui#7207, #22964). If the
resizetizer's Windows output still shows an unwanted background box after
wiring it up, this `.ico` is your direct fallback — reference it explicitly
via `Platforms/Windows/app.manifest`'s icon settings instead of relying on
the generated one.

## MAUI project wiring

Copy `maui-source/Resources/AppIcon/*` and `maui-source/Resources/Splash/*`
into your project's matching folders (overwriting the placeholder
`appicon.png`/`splash.png`), then set your `.csproj`'s icon/splash items to:

```xml
<MauiIcon Include="Resources\AppIcon\appicon.png"
          ForegroundFile="Resources\AppIcon\appiconfg.png"
          Color="#242A2A" />

<MauiSplashScreen Include="Resources\Splash\splash.png"
                   Color="#242A2A"
                   BaseSize="400,400" />
```

- `appicon.png` (sharp, full-bleed) is the fallback combined icon and what
  iOS/older Windows contexts render directly — since iOS applies its own
  rounding, this one must stay square.
- `appiconfg.png` (transparent, safe-zone padded) is the Android
  adaptive-icon foreground layer, composited over the `Color` background —
  Android applies its own mask shape (circle/squircle/rounded-square
  depending on the launcher) on top of this at runtime.
- `splash.png` (transparent, display-padded) becomes the Android splash
  screen's foreground icon, centered on the `Color` backdrop. Adjust
  `BaseSize` to taste — it controls how large the icon renders within the
  splash screen, independent of the source image's own padding.

## Web/PWA manifest

`web-manifest/` contains files named to drop directly into
`web/public/icons/`, matching the exact filenames `vite.config.js`'s
`VitePWA` manifest already expects (`icon-16.png` through `icon-1024.png`).
These are built from the **sharp** style, consistent with how installed
PWA/home-screen icons are conventionally treated (again, the OS applies its
own masking on Android/iOS home screens, same reasoning as the native icon
guidance above).
