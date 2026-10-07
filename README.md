<img align="left" width="160" height="160" alt="SlideshowToGIF Creator icon" src="https://github.com/user-attachments/assets/74a08819-c89f-4df1-bcfc-f87e72dc07a1" />

# SlideshowToGIF Creator

A local tool for **reviewing AI-generated animation frames**, manually aligning them, and exporting the result as **GIF, MP4, or WebM**.

Your source images are **never modified**. All frame alignment and project settings are stored in `project.json`.

<br clear="left"/>

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

Drop multiple images anywhere
