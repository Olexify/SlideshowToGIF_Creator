# SlideshowToGIF Creator

A local tool for reviewing AI-generated animation frames, lining them up by hand, and exporting GIF / MP4 / WebM.
Your source images are never modified. All alignment is stored in `project.json`.

## Run

Requires Python 3.9+ and `ffmpeg` on PATH. There are no pip dependencies.

```
python server.py [project_dir]      # default: ./project, opens http://127.0.0.1:8765/
```

To add frames, drop several images anywhere on the window at once, or use **Add frames**. Drop onto a thumbnail
to insert the images before it. Frames are copied into
`project_dir/frames/` and placed in natural filename order (`frame_001`, `frame_001_5`, `frame_002`, …).
Images you copy into that folder yourself are picked up with **Rescan**.

**Sprite sheets:** if one image holds a grid of frames, select it and click **Split sheet into frames…**
in the side panel. Set columns, rows and an optional trim (pixels removed from each cell edge, for borders
between cells). The preview numbers the cells in playback order. The cells are saved as new files, such as
`sheet_01.png`, and the original sheet is kept.

## Project layout

```
project_dir/
  frames/            source images (read-only for the tool)
  project.json       canvas, fps, loop, out-of-bounds mode, markers, frames[{file,x,y,scale,rotation,duration}]
  output/aligned/    frame_0001.png … aligned master frames (rewritten on every export)
  output/anim.gif|mp4|webm
```

`duration` is in milliseconds. When it is `null`, the frame uses `1000 / fps`.

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

* `server.py`: static files, project load/save (atomic), uploads, export and ffmpeg encoding.
* `static/render.js`: the one place where a frame transform is drawn. Preview, playback and export all use it.
  Automatic registration or interpolation would plug in here, or would write `x/y/scale/rotation` into `project.json`.
* `static/app.js`: the editor UI.
* `test_server.py`: self-check covering uploads, path safety, project round-trip, and encoded durations.
