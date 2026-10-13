# Third-party notices

Ergnova itself is licensed under the GNU Affero General Public License,
version 3 or (at your option) any later version (`AGPL-3.0-or-later`) — see
[LICENSE](LICENSE). This file lists third-party material that is bundled in,
or was derived into, this repository, along with the notices those licenses
require. Dependencies that are only *installed* at build time (npm / NuGet
packages) are not copied into this repository and are not listed here; see
"Build-time dependencies" below.

## 1. Open Sans (fonts)

- **Files:** `Ergnova/Resources/Fonts/OpenSans-Regular.ttf`,
  `Ergnova/Resources/Fonts/OpenSans-Semibold.ttf`
- **Used by:** the native .NET MAUI shell's default control styles
  (`Ergnova/Resources/Styles/Styles.xaml`). The web UI does not use these files.
- **Copyright:** Digitized data copyright © 2010–2011, Google Corporation
  (from the font files' embedded metadata)
- **License:** Apache License, Version 2.0 — full text in
  [Appendix A](#appendix-a--apache-license-20) below.
  <http://www.apache.org/licenses/LICENSE-2.0>

## 2. Icon shapes from Lucide and Feather

Seven of the icons in the inline SVG sprite at the top of `web/index.html`
use geometry identical to icons from these two open-source sets. Everything
else in that sprite was not found to match either set.

| Sprite symbol | Source icon | Set | License |
| --- | --- | --- | --- |
| `icon-play`, `icon-pause` | `play`, `pause` | [Lucide](https://lucide.dev) | ISC |
| `icon-nav-workout` | `blocks` | [Lucide](https://lucide.dev) | ISC |
| `icon-activity`, `icon-plus`, `icon-minus`, `icon-x` | `activity`, `plus`, `minus`, `x` | [Feather](https://feathericons.com) | MIT |

Lucide is © Lucide Icons and Contributors (ISC). Where Lucide's own icons
derive from Feather, Feather's MIT license applies; Feather is © Cole Bemis.
Full texts are in Appendices B and C.

## 3. .NET MAUI project template

The native shell in `Ergnova/` was created from the .NET MAUI project
template. These files originated from that template (and some are still
largely template code), so they are **not** marked with Ergnova's own SPDX
header; the template's MIT license below applies to the template-derived parts:

- `Ergnova/App.xaml`, `Ergnova/AppShell.xaml`, `Ergnova/AppShell.xaml.cs`
- `Ergnova/Platforms/Android/MainApplication.cs`
- `Ergnova/Platforms/iOS/Program.cs`, `Ergnova/Platforms/iOS/AppDelegate.cs`
- `Ergnova/Platforms/MacCatalyst/Program.cs`, `Ergnova/Platforms/MacCatalyst/AppDelegate.cs`
- `Ergnova/Platforms/Windows/App.xaml`, `Ergnova/Platforms/Windows/App.xaml.cs`
- `Ergnova/Resources/Styles/Colors.xaml`, `Ergnova/Resources/Styles/Styles.xaml`

> The MIT License (MIT)
>
> Copyright (c) .NET Foundation and Contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## 4. Nutrition and reference data

- **`web/src/data/nutrition/ingredients.json`** — nutrient values for the
  bundled ingredient set are sourced from USDA FoodData Central:
  U.S. Department of Agriculture, Agricultural Research Service.
  FoodData Central. <https://fdc.nal.usda.gov/>. USDA data is in the public
  domain (CC0 1.0); this credit is given as a courtesy and for provenance.
- **`web/src/core/label-rounding.js`, `web/src/metrics/daily-values.js`** —
  implement U.S. FDA Nutrition Facts labeling rules and reference Daily Values
  (21 CFR 101.9), which are U.S. government works in the public domain.

## 5. Bluetooth device protocol references

- **ProForm 750R rower** (`web/src/ble/proform-device.js`): the device's GATT
  service/characteristic UUIDs and its command/telemetry byte values were
  initially cross-referenced against the open-source
  [qdomyos-zwift](https://github.com/cagnulein/qdomyos-zwift) project
  (© its contributors, licensed GPL-3.0). Ergnova's code is an independent
  implementation, and the protocol constants are facts about the physical
  device. The service/characteristic UUIDs, the initialization and polling
  frames, and three of the resistance-level frames were re-verified
  byte-for-byte against a Bluetooth capture from a real unit; the remaining
  resistance-level frames (levels 1, 4 and 6-24) are cross-referenced from
  qdomyos-zwift only. qdomyos-zwift is credited here regardless. GPL-3.0
  material may be combined with AGPL-3.0 work under section 13 of both licenses.

## 6. Web fonts (Inter, Space Grotesk, IBM Plex)

- **Files:** `web/public/fonts/*.woff2` (Latin subset; weights and families as
  declared in `web/public/fonts/fonts.css`). The files are copied as-is
  from the `@fontsource/*` npm packages, version 5.3.0 (which distribute
  Latin-subset woff2 builds of the upstream fonts).
- **Used by:** the web UI (Inter) and the two pages in `web/public/reference/`
  (Space Grotesk, IBM Plex Sans, IBM Plex Mono). They are served from this
  repository, so no request is made to Google Fonts or any other font host.
- **License:** SIL Open Font License, Version 1.1. The full license text and
  copyright line for each family sit next to the font files and are shipped
  with every build:

| Family | Copyright | License text |
| --- | --- | --- |
| Inter | © 2016 The Inter Project Authors (<https://github.com/rsms/inter>) | `web/public/fonts/OFL-Inter.txt` |
| Space Grotesk | © 2020 The Space Grotesk Project Authors (<https://github.com/floriankarsten/space-grotesk>) | `web/public/fonts/OFL-SpaceGrotesk.txt` |
| IBM Plex Sans | © 2019 IBM Corp. | `web/public/fonts/OFL-IBMPlexSans.txt` |
| IBM Plex Mono | © 2017 IBM Corp. | `web/public/fonts/OFL-IBMPlexMono.txt` |

The font files are not covered by Ergnova's AGPL license; they remain under
the OFL. Do not sell the font files by themselves.

## 7. Build-time dependencies

- **npm** (`web/package.json` / `web/package-lock.json`): development-only build
  tooling (Vite and its plugins). No npm package is shipped as a runtime
  dependency of the app. Their licenses (predominantly MIT) are declared in
  each package.
- **NuGet** (`Ergnova/Ergnova.csproj`): `Microsoft.Maui.Controls` 10.0.101,
  `Microsoft.Extensions.Logging.Debug` 10.0.0, `CommunityToolkit.Maui` 15.0.1,
  `Shiny.BluetoothLE` 5.9.0 and `Shiny.Hosting.Maui` 5.9.0 (the two Shiny
  packages are pinned to the versions that `dotnet list package` resolved), plus
  their transitive dependencies, are restored at build time and are included in
  built binaries. They are not copied into this repository.
  - Shiny (© Allan Ritchie): the `Shiny.BluetoothLE` 5.9.0 and
    `Shiny.Hosting.Maui` 5.9.0 packages each declare
    `<license type="expression">MIT</license>` in their `.nuspec`, and the
    upstream repository, <https://github.com/shinyorg/shiny>, is MIT-licensed.
    The .NET MAUI, .NET
    extensions, CommunityToolkit.Maui and System.Reactive packages are likewise
    MIT. The Android build also pulls in Xamarin/AndroidX/Google binding
    packages (Apache-2.0 upstream libraries), and the Windows build pulls in
    Windows App SDK and WebView2 packages that are distributed under Microsoft's
    own license terms. For example, `Microsoft.WindowsAppSDK` 2.0.1 (copyright
    © Microsoft Corporation) declares a license *file* (`license.txt` inside the
    package) rather than an SPDX expression, and requires license acceptance.
    These terms apply to the Windows build only and are not part of Ergnova's
    own license. Its Microsoft Software License Terms (Windows App SDK) allow
    using it to develop and test applications for Windows and allow
    redistributing the files its NuGet package places beside your application
    ("Distributable Code", section 3), but anyone **distributing a built
    Windows app** that includes those files must, among other things: add
    significant primary functionality of their own, require distributors and end
    users to accept terms that protect Microsoft at least as much as that
    agreement, indemnify Microsoft against claims arising from distributing or
    using the app, keep Microsoft's notices intact, and not put the Microsoft
    code under a license that requires it to be disclosed in source form or
    modifiable by others. Source-only distribution of this repository does not
    include any Microsoft code. Read the full `license.txt` in the package
    before publishing Windows binaries.
  - Anyone distributing built apps should review the license of each package
    version they ship (the `<license>` entry in each package's `.nuspec` under
    the NuGet cache), and include the notices those licenses require.

## 8. Trademarks

The name "Ergnova" and the Ergnova flame logo are the project author's own;
see [BRANDING.md](BRANDING.md) for how they may be used.

Garmin, FIT, TCX, Zwift, TrainingPeaks, Strava, ProForm, iFit, ANT+, Bluetooth
and other product or format names are trademarks of their respective owners.
They appear in this project only to describe file-format and device
compatibility. Ergnova is not affiliated with or endorsed by any of them.

---

## Appendix A — Apache License 2.0

Applies to: Open Sans (section 1).

```text
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other entities that control, are controlled by, or are under common control with that entity. For the purposes of this definition, "control" means (i) the power, direct or indirect, to cause the direction or management of such entity, whether by contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising permissions granted by this License.

"Source" form shall mean the preferred form for making modifications, including but not limited to software source code, documentation source, and configuration files.

"Object" form shall mean any form resulting from mechanical transformation or translation of a Source form, including but not limited to compiled object code, generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form, made available under the License, as indicated by a copyright notice that is included in or attached to the work (an example is provided in the Appendix below).

"Derivative Works" shall mean any work, whether in Source or Object form, that is based on (or derived from) the Work and for which the editorial revisions, annotations, elaborations, or other modifications represent, as a whole, an original work of authorship. For the purposes of this License, Derivative Works shall not include works that remain separable from, or merely link (or bind by name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original version of the Work and any modifications or additions to that Work or Derivative Works thereof, that is intentionally submitted to Licensor for inclusion in the Work by the copyright owner or by an individual or Legal Entity authorized to submit on behalf of the copyright owner. For the purposes of this definition, "submitted" means any form of electronic, verbal, or written communication sent to the Licensor or its representatives, including but not limited to communication on electronic mailing lists, source code control systems, and issue tracking systems that are managed by, or on behalf of, the Licensor for the purpose of discussing and improving the Work, but excluding communication that is conspicuously marked or otherwise designated in writing by the copyright owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf of whom a Contribution has been received by Licensor and subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Work, where such license applies only to those patent claims licensable by such Contributor that are necessarily infringed by their Contribution(s) alone or by combination of their Contribution(s) with the Work to which such Contribution(s) was submitted. If You institute patent litigation against any entity (including a cross-claim or counterclaim in a lawsuit) alleging that the Work or a Contribution incorporated within the Work constitutes direct or contributory patent infringement, then any patent licenses granted to You under this License for that Work shall terminate as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:

     (a) You must give any other recipients of the Work or Derivative Works a copy of this License; and

     (b) You must cause any modified files to carry prominent notices stating that You changed the files; and

     (c) You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and

     (d) If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the Derivative Works, in at least one of the following places: within a NOTICE text file distributed as part of the Derivative Works; within the Source form or documentation, if provided along with the Derivative Works; or, within a display generated by the Derivative Works, if and wherever such third-party notices normally appear. The contents of the NOTICE file are for informational purposes only and do not modify the License. You may add Your own attribution notices within Derivative Works that You distribute, alongside or as an addendum to the NOTICE text from the Work, provided that such additional attribution notices cannot be construed as modifying the License.

     You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions. Notwithstanding the above, nothing herein shall supersede or modify the terms of any separate license agreement you may have executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to in writing, Licensor provides the Work (and each Contributor provides its Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied, including, without limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the Work and assume any risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether in tort (including negligence), contract, or otherwise, unless required by applicable law (such as deliberate and grossly negligent acts) or agreed to in writing, shall any Contributor be liable to You for damages, including any direct, indirect, special, incidental, or consequential damages of any character arising as a result of this License or out of the use or inability to use the Work (including but not limited to damages for loss of goodwill, work stoppage, computer failure or malfunction, or any and all other commercial damages or losses), even if such Contributor has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work or Derivative Works thereof, You may choose to offer, and charge a fee for, acceptance of support, warranty, indemnity, or other liability obligations and/or rights consistent with this License. However, in accepting such obligations, You may act only on Your own behalf and on Your sole responsibility, not on behalf of any other Contributor, and only if You agree to indemnify, defend, and hold each Contributor harmless for any liability incurred by, or claims asserted against, such Contributor by reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work.

To apply the Apache License to your work, attach the following boilerplate notice, with the fields enclosed by brackets "[]" replaced with your own identifying information. (Don't include the brackets!)  The text should be enclosed in the appropriate comment syntax for the file format. We also recommend that a file or class name and description of purpose be included on the same "printed page" as the copyright notice for easier identification within third-party archives.

Copyright [yyyy] [name of copyright owner]

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Appendix B — ISC License (Lucide)

Applies to: icons from Lucide (section 2).

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Appendix C — MIT License (Feather)

Applies to: icons from Feather (section 2).

```text
The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
