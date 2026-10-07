<img align="left" width="150" height="150" alt="SlideshowToGIF Creator icon" src="https://github.com/user-attachments/assets/74a08819-c89f-4df1-bcfc-f87e72dc07a1" />

<h1>SlideshowToGIF Creator</h1>

A local tool for <strong>reviewing AI-generated animation frames</strong>, manually aligning them, and exporting the result as <strong>GIF, MP4, or WebM</strong>.

Your source images are <strong>never modified</strong>. All alignment and project settings are stored in <code>project.json</code>.

<br clear="left">

<img width="2549" height="1144" alt="SlideshowToGIF Creator interface" src="https://github.com/user-attachments/assets/f47a34b4-d4c9-4ce0-8010-aef6fae3b148" />

## Run

**Requirements**

- Python 3.9+
- `ffmpeg` available on `PATH`
- No pip dependencies

```bash
python server.py [project_dir]
```

If `project_dir` is omitted, it defaults to `./project`.

The app opens at:

```text
http://127.0.0.1:8765/
```

### App shortcut

Run `make_shortcut.bat` once to create a **Frame Aligner** desktop shortcut with the app icon.

In Chrome or Edge, you can also use **Install app** from the address bar to open the editor in its own window with the icon.

---

## Adding frames

Drop multiple images anywhere onto the editor window, or click **Add frames**.

You can also drop images directly onto a thumbnail to insert them **before that frame**.

Imported files are copied into:

```text
project_dir/frames/
```

Frames are ordered naturally by filename:

```text
frame_001
frame_001_5
frame_002
...
```

If you manually copy images into the `frames/` directory, click **Rescan** to load them into the project.

---

## Sprite sheets

If a single image contains a grid of animation frames:

1. Select the image.
2. Click **Split sheet into frames…** in the side panel.
3. Set the number of **columns** and **rows**.
4. Optionally set a **trim** value to remove pixels from each cell edge, useful for borders or spacing between cells.

The preview shows each cell numbered in playback order.

Extracted cells are saved as separate files:

```text
sheet_01.png
sheet_02.png
sheet_03.png
...
```

The original sprite sheet is preserved.

<img width="800" height="480" alt="Sprite sheet splitting interface" src="https://github.com/user-attachments/assets/8decbc9f-aead-43bf-97b3-d037548b7423" />

---

## Project layout

```text
project_dir/
├── frames/
│   └── source images
│
├── project.json
│   └── canvas, fps, loop, out-of-bounds mode,
│       markers, and frame transforms
│
└── output/
    ├── aligned/
    │   ├── frame_0001.png
    │   ├── frame_0002.png
    │   └── ...
    │
    ├── anim.gif
    ├── anim.mp4
    └── anim.webm
```

Source images inside `frames/` are treated as **read-only** by the tool.

Aligned master frames inside `output/aligned/` are rewritten on every export.

Each frame entry in `project.json` stores:

```text
file
x
y
scale
rotation
duration
```

`duration` is stored in **milliseconds**.

When `duration` is `null`, the frame duration is calculated from:

```text
1000 / fps
```

---

## Frame transform vs viewport

The editor separates **frame alignment** from **viewport navigation**.

### Frame transform

Frame transforms affect the exported animation and are saved in `project.json`.

They include:

```text
x
y
scale
rotation
```

| Action | Control |
| --- | --- |
| Move frame | Drag |
| Scale | Mouse wheel |
| Fine scale | Shift + wheel |
| Move 1 px | Arrow keys |
| Move 10 px | Shift + arrow keys |
| Rotate | Q / E |
| Exact values | Side panel |

### Viewport

Viewport controls only change how you **see the canvas** while editing.

They are **never saved or exported**.

| Action | Control |
| --- | --- |
| Zoom viewport | Ctrl + wheel |
| Pan viewport | Right-drag / middle-drag |
| Fit canvas | F |
| 100% zoom | 1 |
| Reset viewport | Double-click |

---

## Frame comparison

Use comparison modes to line up neighboring frames precisely.

Press **O** to cycle through:

- **Onion** — blends the reference frame over the current frame
- **Difference** — matching areas become black
- **Split** — current frame on the left, reference frame on the right; drag the divider

Press **B** for **Blink mode**, which rapidly switches between the two frames.

> **Note:** Arrow keys move the current image, so frame navigation uses **A / D** or **PageUp / PageDown**.

Press **?** in the toolbar to view the complete shortcut list.

---

## Code map

### `server.py`

Handles:

- Static files
- Project loading and saving
- Atomic project writes
- Image uploads
- Export
- FFmpeg encoding

### `static/render.js`

The central rendering path for frame transforms.

Preview, playback, and export all use the same transform logic here.

Future features such as **automatic registration** or **frame interpolation** could either plug into this rendering path or write calculated:

```text
x / y / scale / rotation
```

values directly into `project.json`.

### `static/app.js`

Contains the editor UI and interaction logic.

### `test_server.py`

Self-checks for:

- Uploads
- Path safety
- Project round-tripping
- Encoded frame durations
