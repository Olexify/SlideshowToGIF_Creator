<img align="left" width="150" height="150" alt="SlideshowToGIF Creator icon" src="https://github.com/user-attachments/assets/74a08819-c89f-4df1-bcfc-f87e72dc07a1" />

**𝗦𝗹𝗶𝗱𝗲𝘀𝗵𝗼𝘄𝗧𝗼𝗚𝗜𝗙 𝗖𝗿𝗲𝗮𝘁𝗼𝗿**

A local tool for **reviewing AI-generated animation frames**, manually aligning them, and exporting the result as **GIF, MP4, or WebM**.

Your source images are **never modified or copied**: they are linked from wherever they are on disk. All alignment and project settings are stored in a small `project.json` per project.

<br clear="left">

<img width="2549" height="1144" alt="SlideshowToGIF Creator interface" src="https://github.com/user-attachments/assets/f47a34b4-d4c9-4ce0-8010-aef6fae3b148" />

## Run

**Requirements**

- Python 3.9+
- `ffmpeg` available on `PATH`
- No pip dependencies

Double-click `start.bat`, or run:

```bash
python server.py
```

Keep the console window open while you work. The app opens at:

```text
http://127.0.0.1:8765/
```

### App shortcut

Run `make_shortcut.bat` once to create a **Frame Aligner** desktop shortcut with the app icon.

In Chrome or Edge, you can also use **Install app** from the address bar to open the editor in its own window with the icon.

---

## Adding frames

Click **Add frames** (pick images) or **Add folder** (every image in a folder). A normal Windows file picker opens.

The images are **linked where they are**. Nothing is copied, so the app stays lightweight.
If an original is later moved or deleted, its thumbnail shows **FILE NOT FOUND**.

Frames are ordered naturally by filename:

```text
frame_001
frame_001_5
frame_002
...
```

| Option | What happens |
| --- | --- |
| **Keep copies of added images** (side panel → Storage) | Picked images are copied into the project, so it survives if the originals go away |
| Drop images onto the window | Copied into the project, because a browser never tells a page where a dropped file lives on disk |
| Drop images onto a thumbnail | Same, inserted **before that frame** |

---

## Projects

Click the project name next to the logo to open the project menu:

- Switch between projects to work on several GIFs at once
- **New project**, **Rename this project**
- **Clear this project**: removes all frames and alignment to start again
- **Delete this project** / **Delete all other projects**

Every destructive action asks for confirmation. None of them touch your original images, only the app's own project data.

---

## Export

Choose **GIF**, **MP4**, **WebM** and/or **PNGs** (the aligned frame sequence), then click **Export**.

Files are named after the project and never overwrite existing files: `Fox walk.gif`, then `Fox walk (2).gif`, and so on.

Under **Storage → Export to**, pick:

| Option | Folder |
| --- | --- |
| **Downloads** (default) | your Downloads folder |
| **App folder** | `exports/` inside the app |
| **Custom…** | any folder you choose |

---

## Sprite sheets

If a single image contains a grid of animation frames:

1. Select the image.
2. Click **Split sheet into frames…** in the side panel.
3. Set the number of **columns** and **rows**.
4. Optionally set a **trim** value to remove pixels from each cell edge, useful for borders or spacing between cells.

The preview shows each cell numbered in playback order.

After splitting, the sheet moves to the **Processed** group at the end of the timeline.

---

## Processed group

Images that shouldn't be part of the animation, such as a sprite sheet after splitting, can be marked
**processed** with the ✓ button on a thumbnail or **Mark as processed** in the side panel.
They stay in the project in a dimmed **Processed** group at the end of the timeline. They are skipped
by playback, comparison and export. Use **Restore** to put one back into the animation.

## Canvas size

The canvas (output size) is taken from the first image you add. If the current image has a different
size, a notice shows both sizes with a **Use image size** button. When a project has no frames left,
the canvas resets and the next image sets it again.

Extracted cells are saved as separate files inside the project, since they are new images:

```text
sheet_01.png
sheet_02.png
sheet_03.png
...
```

The original sprite sheet is preserved.

<img width="800" height="480" alt="Sprite sheet splitting interface" src="https://github.com/user-attachments/assets/8decbc9f-aead-43bf-97b3-d037548b7423" />

---

## App folder layout

```text
SlideshowToGIF_Creator/
├── settings.json          export folder, copy toggle, last open project
│
├── projects/
│   └── <id>/
│       ├── project.json   name, canvas, fps, loop, out-of-bounds mode,
│       │                  markers, and frame transforms
│       └── files/         only if needed: dropped images, split-sheet
│                          frames, "keep copies"
│
└── exports/               only if "App folder" is the export target
```

A frame's `file` is either an **absolute path** (a linked original) or `files/...` (a copy inside the project).

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

- Projects and settings (atomic JSON writes)
- Native file and folder pickers
- Serving linked images (only images that belong to a project)
- Export and FFmpeg encoding

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

- Linking without copies, and the copy toggle
- Path safety and blocking requests from other websites
- Project create / clear / delete, and that originals are never touched
- Export folder, no overwrites, and encoded frame durations
