# SlideshowToGIF Creator

A local tool for reviewing AI-generated animation frames, lining them up by hand, and exporting GIF / MP4 / WebM.
Your source images are never modified. All alignment is stored in `project.json`.

## Run

Requires Python 3.9+ and `ffmpeg` on PATH. There are no pip dependencies.

Double-click `start.bat` (or run `python server.py`). The editor opens at http://127.0.0.1:8765/.
Keep the console window open while you work.

**App icon:** run `make_shortcut.bat` once to get a "Frame Aligner" shortcut with the app icon on your desktop.
In Chrome or Edge you can also use **Install app** in the address bar to open the editor in its own window with the icon.

## Images stay where they are

**Add frames** and **Add folder** open a normal Windows file picker. The images are *linked* from where they
are, so nothing is copied and the app stays small. If an original is later moved or deleted, its thumbnail shows
**FILE NOT FOUND**.

* **Keep copies of added images** (side panel, Storage): copies picked images into the project instead, so the
  project survives if the originals go away.
* **Dropped images** are always copied, because a browser never tells a page where a dropped file lives on disk.
* **Split sheet into frames…** saves its cut-out frames inside the project, since they are new images.

## Projects

The project button next to the logo switches between projects and can create, rename, clear, or delete them.
It can also **delete all other projects**. Every destructive action asks first, and none of them touch your
original images. Each project is only a small `project.json`, plus any copies described above.

## Export

Choose GIF, MP4, WebM and/or **PNGs** (the aligned frame sequence), then click **Export**. Files are named after
the project and never overwrite existing files: `Fox walk.gif`, then `Fox walk (2).gif`, and so on.
Under **Storage → Export to**, pick **Downloads** (the default), **App folder** (`exports/` here), or any **Custom…** folder.

**Sprite sheets:** if one image holds a grid of frames, select it and click **Split sheet into frames…**
in the side panel. Set columns, rows and an optional trim (pixels removed from each cell edge, for borders
between cells). The preview numbers the cells in playback order.

## App folder layout

```
settings.json                export folder, copy toggle, last open project
projects/<id>/project.json   name, canvas, fps, loop, edges, markers, frames[{file,x,y,scale,rotation,duration}]
projects/<id>/files/         only if needed: dropped images, split-sheet frames, "keep copies"
exports/                     only if "App folder" is chosen as the export target
```

A frame's `file` is either an absolute path (a linked original) or `files/...` (a copy inside the project).
`duration` is in milliseconds; `null` means `1000 / fps`.

## Frame transform vs viewport

* **Frame transform** (x, y, scale, rotation) is the alignment. It is saved and applied on export.
  Drag the image, use the wheel (Shift = finer), the arrows (Shift = 10 px), Q/E to rotate, or type values in the side panel.
* **Viewport** (Ctrl+wheel, right/middle-drag, F = fit, 1 = 100%, double-click = reset) only changes how you see the canvas.
  It is never saved or exported.

Compare modes (O cycles them): **Onion** (reference blended on top), **Difference** (black where the frames match),
and **Split** (current on the left, reference on the right, drag the divider). **Blink** (B) flips between the two.

Press **?** in the toolbar for all shortcuts. Note that the arrow keys move the image, so frame stepping uses **A / D**
(or PageUp / PageDown).

## Code map

* `server.py`: projects and settings (atomic JSON writes), native file pickers, serving linked images, export and ffmpeg encoding.
* `static/render.js`: the one place where a frame transform is drawn. Preview, playback and export all use it.
  Automatic registration or interpolation would plug in here, or would write `x/y/scale/rotation` into `project.json`.
* `static/app.js`: the editor UI.
* `test_server.py`: self-check covering uploads, path safety, project round-trip, and encoded durations.
