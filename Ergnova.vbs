' SPDX-License-Identifier: AGPL-3.0-or-later
' SPDX-FileCopyrightText: 2026 seancconner

' ============================================================================
' Ergnova launcher
'
' Remembers a default launch method and offers it every time you run this:
'
'   1. Dev server        - npm run dev
'                          (Vite dev server, then Chrome in app mode)
'   2. Preview build     - npm run build, then npm run preview
'                          (production bundle served by Vite, then Chrome)
'   3. MAUI app, Windows - npm run build:maui + build the MAUI project, then
'                          open the native Windows app
'   4. MAUI app, Android - npm run build:maui + build the MAUI project, then
'                          deploy to and launch on a connected Android
'                          device/emulator. Walks through adb's "pair" and
'                          "connect" steps first (Android 11+ wireless
'                          debugging) if no authorized device is already
'                          attached, or if you ask to pair a different one.
'
' First run:  asks which method should be the default, saves it, launches it.
' After that: a small prompt - Enter launches the default, "No" lets you
'             change the default, Esc / Cancel closes without launching.
'
' The default is stored per Windows user in the registry, at
'   HKCU\Software\Ergnova\Launcher\DefaultMode
' so nothing gets written into the project folder. Delete that value (or
' choose "No" at the prompt) to pick a different one. (An older "maui" value
' from before this was split in two is read as MODE_MAUI_WINDOWS, since that
' is what it used to launch.)
'
' For the two Chrome-based modes, Chrome is opened sized for a 27" 1440p
' monitor, with DevTools auto-opened and Device Mode switched on. Docking
' DevTools to the right and picking the S25+ device are one-time manual steps -
' see the note near the bottom of this file for why.
' ============================================================================

Option Explicit

Const SETTINGS_KEY     = "HKCU\Software\Ergnova\Launcher\DefaultMode"
Const LAUNCHER_TITLE   = "Ergnova launcher"

Const MODE_DEV          = "dev"
Const MODE_PREVIEW      = "preview"
Const MODE_MAUI_WINDOWS = "mauiwin"
Const MODE_MAUI_ANDROID = "mauiandroid"

' The value this same setting used before the MAUI option was split in two -
' recognised only so an existing saved default keeps working. See LoadDefaultMode.
Const MODE_MAUI_LEGACY  = "maui"

' Vite pins server.port to 5173 in vite.config.js, but "vite preview" has its
' own separate default port (4173), so the two modes need different URLs.
Const DEV_URL           = "http://localhost:5173"
Const PREVIEW_URL       = "http://localhost:4173"

' Target frameworks for the MAUI builds - must match Ergnova.csproj
Const MAUI_WINDOWS_TFM  = "net10.0-windows10.0.19041.0"
Const MAUI_ANDROID_TFM  = "net10.0-android"

Dim WshShell, FSO
Dim scriptDir, webDir, mauiDir
Dim monitorWidth, monitorHeight
Dim defaultMode, menuChoice, newMode

Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

' Get the exact directory where this script is saved; everything below is
' resolved relative to it, no matter where the script is launched from.
scriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
webDir    = FSO.BuildPath(scriptDir, "web")
mauiDir   = FSO.BuildPath(scriptDir, "Ergnova")

' --- Monitor settings: adjust here if you switch monitors -----------------
monitorWidth  = 2560   ' 27" @ 1440p horizontal resolution
monitorHeight = 1415   ' leaves ~25px clearance for the Windows taskbar

' ============================================================================
' Main flow
' ============================================================================
defaultMode = LoadDefaultMode()

If defaultMode = "" Then
    ' ---- First launch: nothing saved yet, so ask, save, then go ------------
    defaultMode = AskForMode("", "First launch - which launch method should be the default?")
    If defaultMode = "" Then WScript.Quit   ' cancelled: ask again next time
    SaveDefaultMode defaultMode
Else
    ' ---- Later launches: Enter = launch, No = change default, Esc = close ---
    ' Yes is the default button, so a bare Enter launches. After changing the
    ' default this loops back to the same prompt showing the new default, so a
    ' single Enter then launches it (or Esc closes without launching).
    Do
        menuChoice = MsgBox("Default launch method:" & vbCrLf & _
                            "     " & ModeLabel(defaultMode) & vbCrLf & vbCrLf & _
                            "Yes  (Enter)  -  launch it" & vbCrLf & _
                            "No  -  change the default" & vbCrLf & _
                            "Cancel  (Esc)  -  close", _
                            vbYesNoCancel + vbQuestion + vbSystemModal, LAUNCHER_TITLE)
        Select Case menuChoice
            Case vbYes
                Exit Do
            Case vbNo
                newMode = AskForMode(defaultMode, "Change the default launch method.")
                If newMode <> "" Then
                    defaultMode = newMode
                    SaveDefaultMode defaultMode
                End If
            Case Else
                WScript.Quit
        End Select
    Loop
End If

Select Case defaultMode
    Case MODE_DEV
        LaunchDevServer
    Case MODE_PREVIEW
        LaunchPreview
    Case MODE_MAUI_WINDOWS
        LaunchMauiWindows
    Case MODE_MAUI_ANDROID
        LaunchMauiAndroid
End Select

WScript.Quit

' ============================================================================
' Launch methods
' ============================================================================

' 1. npm run dev -> Chrome
Sub LaunchDevServer()
    WshShell.CurrentDirectory = webDir
    EnsureWebDeps

    ' Start the Vite dev server (1 = normal window, so you can see its output)
    WshShell.Run "cmd.exe /c npm run dev", 1, False

    ' Wait for the server to spin up. Increase this if your machine is slower.
    WScript.Sleep 4000

    OpenInChrome DEV_URL
End Sub

' 2. npm run build, then npm run preview -> Chrome
Sub LaunchPreview()
    Dim exitCode
    WshShell.CurrentDirectory = webDir
    EnsureWebDeps

    ' Build first. The True at the end makes this wait until the build has
    ' finished, and hands back its exit code. On failure the window stays open
    ' (pause) so the error can actually be read, and nothing else is launched.
    exitCode = WshShell.Run("cmd.exe /c npm run build || (echo. & echo Build failed - press any key to close this window. & pause >nul & exit /b 1)", 1, True)
    If exitCode <> 0 Then WScript.Quit 1

    ' Then serve the fresh build
    WshShell.Run "cmd.exe /c npm run preview", 1, False
    WScript.Sleep 4000

    OpenInChrome PREVIEW_URL
End Sub

' 3. npm run build:maui + MAUI build, then open the native Windows window
Sub LaunchMauiWindows()
    Dim exitCode
    WshShell.CurrentDirectory = mauiDir

    ' Ergnova.csproj's BuildWebApp target runs "npm run build:maui" itself (and
    ' "npm ci" if package-lock.json changed) before compiling, so this one
    ' command covers both the web bundle and the MAUI project. Same wait-and-
    ' pause-on-failure pattern as the preview build above.
    exitCode = WshShell.Run("cmd.exe /c dotnet build -f " & MAUI_WINDOWS_TFM & " || (echo. & echo MAUI build failed - press any key to close this window. & pause >nul & exit /b 1)", 1, True)
    If exitCode <> 0 Then WScript.Quit 1

    ' Show the app. --no-build reuses what was just built. The console window
    ' stays open behind the app and closes when you close the app.
    WshShell.Run "cmd.exe /c dotnet run --no-build -f " & MAUI_WINDOWS_TFM, 1, False
End Sub

' 4. Optional adb pair/connect, then npm run build:maui + MAUI Android build,
'    then deploy to and launch on the device
Sub LaunchMauiAndroid()
    Dim adbPath, exitCode

    adbPath = ResolveAdbPath()
    If adbPath = "" Then
        MsgBox "Couldn't find adb (Android Platform Tools)." & vbCrLf & vbCrLf & _
               "Checked PATH, the ANDROID_HOME / ANDROID_SDK_ROOT environment " & _
               "variables, and the default per-user SDK install location." & vbCrLf & vbCrLf & _
               "Install the Android SDK (e.g. via the MAUI workload or Android " & _
               "Studio), make sure platform-tools is present, then try again.", _
               vbCritical + vbSystemModal, LAUNCHER_TITLE
        WScript.Quit 1
    End If

    If Not EnsureAndroidDeviceReady(adbPath) Then WScript.Quit

    WshShell.CurrentDirectory = mauiDir

    ' "dotnet build -t:Run" both deploys to the connected/selected device and
    ' starts the app - there's no separate "dotnet run" step for Android the
    ' way there is for Windows above. Ergnova.csproj's BuildWebApp target
    ' still runs "npm run build:maui" first, same as the Windows build. Same
    ' wait-and-pause-on-failure pattern as the other build steps.
    exitCode = WshShell.Run("cmd.exe /c dotnet build -t:Run -f " & MAUI_ANDROID_TFM & _
                             " || (echo. & echo MAUI Android build/deploy failed - press any key to close this window. & pause >nul & exit /b 1)", 1, True)
    If exitCode <> 0 Then WScript.Quit 1
End Sub

' ============================================================================
' ADB pair/connect (used by the Android MAUI mode)
' ============================================================================

' Locates adb.exe: PATH first (via "where", the same search CreateProcess
' itself would do for a bare "adb.exe" - resolving it explicitly just lets
' the caller show a clear "not found" message instead of a cryptic failure
' from deep inside Exec later), then ANDROID_HOME / ANDROID_SDK_ROOT, then
' the default per-user install location the MAUI Android workload and
' Android Studio both use on Windows. Returns "" if none of those pan out.
Function ResolveAdbPath()
    Dim whereProc, whereOutput, candidate, sdkRoot

    ResolveAdbPath = ""

    On Error Resume Next
    Set whereProc = WshShell.Exec("cmd.exe /c where adb.exe")
    If Err.Number = 0 Then
        Do While whereProc.Status = 0
            WScript.Sleep 50
        Loop
        If whereProc.ExitCode = 0 Then
            whereOutput = Trim(whereProc.StdOut.ReadAll())
            If whereOutput <> "" Then
                ResolveAdbPath = Trim(Split(whereOutput, vbCrLf)(0))
                Exit Function
            End If
        End If
    End If
    Err.Clear
    On Error GoTo 0

    sdkRoot = WshShell.ExpandEnvironmentStrings("%ANDROID_HOME%")
    If sdkRoot = "%ANDROID_HOME%" Then sdkRoot = ""
    If sdkRoot = "" Then
        sdkRoot = WshShell.ExpandEnvironmentStrings("%ANDROID_SDK_ROOT%")
        If sdkRoot = "%ANDROID_SDK_ROOT%" Then sdkRoot = ""
    End If
    If sdkRoot <> "" Then
        candidate = FSO.BuildPath(FSO.BuildPath(sdkRoot, "platform-tools"), "adb.exe")
        If FSO.FileExists(candidate) Then
            ResolveAdbPath = candidate
            Exit Function
        End If
    End If

    candidate = FSO.BuildPath(WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Android\Sdk\platform-tools"), "adb.exe")
    If FSO.FileExists(candidate) Then
        ResolveAdbPath = candidate
        Exit Function
    End If
End Function

' Runs adb with the given argument string and waits for it to finish,
' returning its combined stdout+stderr as one string.
Function RunAdbCommand(ByVal adbPath, ByVal args)
    Dim proc

    Set proc = WshShell.Exec("""" & adbPath & """ " & args)
    Do While proc.Status = 0
        WScript.Sleep 50
    Loop

    RunAdbCommand = Trim(proc.StdOut.ReadAll() & proc.StdErr.ReadAll())
End Function

' Runs "adb devices -l" and returns a display-ready list of already
' authorized devices/emulators (one per line), or "" if none are ready.
' Devices still showing "unauthorized" or "offline" are left out on purpose -
' deploying to those just fails with a less clear error, so treat them as
' not-ready and let the pairing/connect flow, or a phone's own "Allow USB
' debugging?" prompt, handle them instead.
Function ListAuthorizedAdbDevices(ByVal adbPath)
    Dim rawOutput, line, lines, i, result

    result = ""
    rawOutput = RunAdbCommand(adbPath, "devices -l")

    lines = Split(rawOutput, vbLf)
    For i = 0 To UBound(lines)
        line = Trim(Replace(lines(i), vbCr, ""))
        If line <> "" And InStr(line, "List of devices") = 0 And InStr(line, vbTab & "device") > 0 Then
            result = result & "  " & line & vbCrLf
        End If
    Next

    ListAuthorizedAdbDevices = result
End Function

' Checks for an already-authorized device/emulator; if none is found (or the
' user asks to), walks through Android 11+'s wireless debugging pair/connect
' flow. Returns True to go ahead with the build/deploy, False if cancelled.
Function EnsureAndroidDeviceReady(ByVal adbPath)
    Dim deviceList, choice

    EnsureAndroidDeviceReady = False
    deviceList = ListAuthorizedAdbDevices(adbPath)

    If deviceList <> "" Then
        choice = MsgBox("Device(s) already connected and authorized:" & vbCrLf & vbCrLf & _
                        deviceList & vbCrLf & _
                        "Yes  -  use this device, skip pairing" & vbCrLf & _
                        "No  -  pair/connect a different device over Wi-Fi" & vbCrLf & _
                        "Cancel  -  abort", _
                        vbYesNoCancel + vbQuestion + vbSystemModal, LAUNCHER_TITLE)
        Select Case choice
            Case vbYes
                EnsureAndroidDeviceReady = True
                Exit Function
            Case vbNo
                EnsureAndroidDeviceReady = PairAndConnectAndroidDevice(adbPath)
            Case Else
                Exit Function
        End Select
    Else
        choice = MsgBox("No connected/authorized Android device found." & vbCrLf & vbCrLf & _
                        "Yes  -  pair/connect one now over Wi-Fi" & vbCrLf & _
                        "No  -  plug a device in via USB (accept the ""Allow USB " & _
                        "debugging?"" prompt on it), then retry" & vbCrLf & _
                        "Cancel  -  abort", _
                        vbYesNoCancel + vbQuestion + vbSystemModal, LAUNCHER_TITLE)
        Select Case choice
            Case vbYes
                EnsureAndroidDeviceReady = PairAndConnectAndroidDevice(adbPath)
            Case vbNo
                EnsureAndroidDeviceReady = EnsureAndroidDeviceReady(adbPath)   ' re-check, then loop back through this same prompt
            Case Else
                Exit Function
        End Select
    End If
End Function

' Walks the user through Android 11+'s "Wireless debugging" pairing flow
' (phone: Settings > Developer options > Wireless debugging > Pair device
' with pairing code), then connects to the paired device. Returns True on a
' confirmed pair + connect, False if cancelled or either step fails.
Function PairAndConnectAndroidDevice(ByVal adbPath)
    Dim pairAddress, pairCode, pairResult
    Dim connectAddress, connectResult, hostHint

    PairAndConnectAndroidDevice = False

    pairAddress = Trim(InputBox( _
        "On the phone: Settings > Developer options > Wireless debugging > " & _
        "Pair device with pairing code." & vbCrLf & vbCrLf & _
        "Enter the IP address and port shown there (e.g. 192.168.1.23:41231):", _
        LAUNCHER_TITLE))
    If pairAddress = "" Then Exit Function

    pairCode = Trim(InputBox("Enter the 6-digit pairing code shown on the same screen:", LAUNCHER_TITLE))
    If pairCode = "" Then Exit Function

    pairResult = RunAdbCommand(adbPath, "pair " & pairAddress & " " & pairCode)
    If InStr(1, pairResult, "Successfully paired", vbTextCompare) = 0 Then
        MsgBox "adb pair didn't report success:" & vbCrLf & vbCrLf & pairResult, _
               vbExclamation + vbSystemModal, LAUNCHER_TITLE
        Exit Function
    End If

    ' The connect port is the one on the MAIN wireless debugging screen, not
    ' the pairing-code screen - Android generates a fresh, different port for
    ' pairing each time, separate from the port used for the actual adb
    ' connection. Pre-fill just the host, since it's almost always the same
    ' phone/network as the pairing address above.
    hostHint = pairAddress
    If InStr(hostHint, ":") > 0 Then hostHint = Left(hostHint, InStr(hostHint, ":") - 1)

    connectAddress = Trim(InputBox( _
        "Now enter the IP address and port shown on the MAIN Wireless " & _
        "debugging screen (usually a DIFFERENT port than the pairing screen " & _
        "above), e.g. " & hostHint & ":37251:", _
        LAUNCHER_TITLE, hostHint & ":"))
    If connectAddress = "" Or Right(connectAddress, 1) = ":" Then Exit Function

    connectResult = RunAdbCommand(adbPath, "connect " & connectAddress)
    If InStr(1, connectResult, "connected to", vbTextCompare) = 0 Then
        MsgBox "adb connect didn't report success:" & vbCrLf & vbCrLf & connectResult, _
               vbExclamation + vbSystemModal, LAUNCHER_TITLE
        Exit Function
    End If

    PairAndConnectAndroidDevice = True
End Function

' ============================================================================
' Dependencies (used by the dev and preview modes)
' ============================================================================

' Makes sure web\node_modules is installed before running any vite command.
' A fresh clone / unzipped copy has no node_modules, which shows up as
' "'vite' is not recognized as an internal or external command". This checks
' for the vite.cmd shim that npm creates on Windows, so it also catches a
' node_modules copied over from another OS (which has no .cmd shims). If it's
' missing, "npm ci" runs first - the same command Ergnova.csproj uses for the
' MAUI build - and the launch is abandoned if the install fails. Once it has
' run successfully this check is just a quick file lookup on later launches.
Sub EnsureWebDeps()
    Dim exitCode
    If FSO.FileExists(FSO.BuildPath(webDir, "node_modules\.bin\vite.cmd")) Then Exit Sub

    exitCode = WshShell.Run("cmd.exe /c npm ci || (echo. & echo npm ci failed - press any key to close this window. & pause >nul & exit /b 1)", 1, True)
    If exitCode <> 0 Then WScript.Quit 1
End Sub

' ============================================================================
' Chrome (used by the dev and preview modes)
' ============================================================================
Sub OpenInChrome(ByVal url)
    Dim chromePath, chromeProc

    ' Resolve Chrome's actual install path from the registry. .Run could get
    ' away with a bare "chrome.exe" because it goes through ShellExecute,
    ' which checks the "App Paths" registry key - but .Exec calls
    ' CreateProcess directly, which does NOT check that key, so a bare
    ' filename now fails with "The system cannot find the file specified."
    On Error Resume Next
    chromePath = WshShell.RegRead("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe\")
    If Err.Number <> 0 Or chromePath = "" Then
        Err.Clear
        chromePath = WshShell.RegRead("HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe\")
    End If
    On Error GoTo 0
    If chromePath = "" Then
        ' Registry lookup failed for some reason - fall back to the usual install locations
        chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
        If Not FSO.FileExists(chromePath) Then
            chromePath = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
        End If
    End If

    ' Launch Chrome in app mode, sized and positioned to fill the 1440p
    ' monitor, with DevTools set to auto-open alongside it. .Exec (instead
    ' of .Run) gives us back a ProcessID, which lets us grab focus reliably
    ' below instead of guessing from the window's (unpredictable,
    ' page-title-driven) caption text.
    Set chromeProc = WshShell.Exec("""" & chromePath & """ --app=""" & url & """ --auto-open-devtools-for-tabs " & _
                 "--window-position=0,0 --window-size=" & monitorWidth & "," & monitorHeight)
    ' If the taskbar still clips the bottom edge on your setup, swap the line
    ' above for this maximized version instead:
    ' Set chromeProc = WshShell.Exec("""" & chromePath & """ --app=""" & url & """ --auto-open-devtools-for-tabs --start-maximized")

    ' Wait for Chrome and DevTools to finish rendering, then bring the
    ' window into focus.
    WScript.Sleep 2500
    WshShell.AppActivate chromeProc.ProcessID
    WScript.Sleep 300

    ' Toggle Device Mode on, via a small PowerShell helper instead of
    ' SendKeys. SendKeys sends the Ctrl and Shift down-events as separate,
    ' sequential low-level events, and for a two-modifier chord like
    ' Ctrl+Shift+M (or Ctrl+Shift+P, which is what kept opening the Print
    ' dialog) there's a real race: if Chrome reads keyboard state before
    ' Shift's event has landed, it sees a different, unintended shortcut.
    ' ToggleDeviceMode.ps1 uses the Windows SendInput API instead, which
    ' submits all key states in one atomic batch, removing that race
    ' entirely rather than just waiting longer around it.
    WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & _
                 scriptDir & "\ToggleDeviceMode.ps1""", 0, True
End Sub

' ============================================================================
' Saved default + prompts
' ============================================================================

' Returns the saved default ("dev" / "preview" / "maui"), or "" if none is saved
' yet (or the stored value isn't one we recognise).
Function LoadDefaultMode()
    Dim saved
    saved = ""
    On Error Resume Next
    saved = CStr(WshShell.RegRead(SETTINGS_KEY))
    If Err.Number <> 0 Then
        Err.Clear
        saved = ""
    End If
    On Error GoTo 0

    ' Pre-split saved value: "maui" used to mean the Windows build, so keep
    ' honoring that rather than dropping back to "not set" on upgrade.
    If saved = MODE_MAUI_LEGACY Then saved = MODE_MAUI_WINDOWS

    If saved <> MODE_DEV And saved <> MODE_PREVIEW And saved <> MODE_MAUI_WINDOWS And saved <> MODE_MAUI_ANDROID Then saved = ""
    LoadDefaultMode = saved
End Function

Sub SaveDefaultMode(ByVal modeToSave)
    On Error Resume Next
    WshShell.RegWrite SETTINGS_KEY, modeToSave, "REG_SZ"
    If Err.Number <> 0 Then
        MsgBox "Couldn't save the default launch method:" & vbCrLf & Err.Description & vbCrLf & vbCrLf & _
               "It will still be used for this launch, but you'll be asked again next time.", _
               vbExclamation + vbSystemModal, LAUNCHER_TITLE
        Err.Clear
    End If
    On Error GoTo 0
End Sub

Function ModeLabel(ByVal modeId)
    Select Case modeId
        Case MODE_DEV
            ModeLabel = "Dev server  (npm run dev)"
        Case MODE_PREVIEW
            ModeLabel = "Preview build  (npm run build, then npm run preview)"
        Case MODE_MAUI_WINDOWS
            ModeLabel = "MAUI app, Windows  (npm run build:maui, build MAUI, then open it)"
        Case MODE_MAUI_ANDROID
            ModeLabel = "MAUI app, Android  (adb pair/connect if needed, npm run build:maui, build MAUI, deploy & launch)"
        Case Else
            ModeLabel = "(not set)"
    End Select
End Function

' Shows the 1 / 2 / 3 / 4 picker. Returns the chosen mode, or "" if the box was
' cancelled or left empty. The box is pre-filled with the current default (or 1
' on first launch) so Enter alone keeps it.
Function AskForMode(ByVal currentMode, ByVal heading)
    Dim defaultText, note, answer

    AskForMode = ""
    Select Case currentMode
        Case MODE_PREVIEW
            defaultText = "2"
        Case MODE_MAUI_WINDOWS
            defaultText = "3"
        Case MODE_MAUI_ANDROID
            defaultText = "4"
        Case Else
            defaultText = "1"
    End Select

    note = ""
    Do
        answer = Trim(InputBox(note & heading & vbCrLf & vbCrLf & _
                               "  1   =   " & ModeLabel(MODE_DEV) & vbCrLf & _
                               "  2   =   " & ModeLabel(MODE_PREVIEW) & vbCrLf & _
                               "  3   =   " & ModeLabel(MODE_MAUI_WINDOWS) & vbCrLf & _
                               "  4   =   " & ModeLabel(MODE_MAUI_ANDROID) & vbCrLf & vbCrLf & _
                               "Type 1, 2, 3 or 4, then press Enter:", _
                               LAUNCHER_TITLE, defaultText))
        Select Case answer
            Case ""
                Exit Function
            Case "1"
                AskForMode = MODE_DEV
                Exit Function
            Case "2"
                AskForMode = MODE_PREVIEW
                Exit Function
            Case "3"
                AskForMode = MODE_MAUI_WINDOWS
                Exit Function
            Case "4"
                AskForMode = MODE_MAUI_ANDROID
                Exit Function
            Case Else
                note = "'" & answer & "' isn't a valid choice." & vbCrLf & vbCrLf
        End Select
    Loop
End Function

' ----------------------------------------------------------------------------
' Two one-time manual setup steps (not scripted - see below for why):
'
' 1. Dock DevTools to the right, once, using the toolbar's "..." menu or
'    the Command Menu (Ctrl+Shift+P, typed by hand - it's only the
'    *scripted* version of this chord that's unreliable). Dock side is a
'    setting Chrome remembers per profile, not something reset each
'    session, so it stays right on every future run of this script with
'    no automation needed - which also means there's no keystroke left
'    here that could misfire into a Print dialog.
'
' 2. Add the S25+ as a custom device, once: Chrome's built-in device list
'    doesn't include the Galaxy S25+ by name. Its real viewport is
'    412 x 891 CSS px at a ~3.5 device pixel ratio (1440x3120 physical
'    resolution / 3.5). In the device toolbar: Dimensions dropdown > Edit
'    > Add custom device -> Width 412, Height 891, Device pixel ratio 3.5,
'    check Mobile/touch. Chrome remembers the last-used device per
'    profile too, so selecting it once means it's already selected on
'    every future run.
' ----------------------------------------------------------------------------
