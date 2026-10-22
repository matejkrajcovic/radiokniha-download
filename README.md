# Czech Radio Radiokniha Downloader (Deno) 📚⬇️

Script downloads [Radiokniha](https://plus.rozhlas.cz/radiokniha-6483132) playlist episodes, converts to MP3, and writes ID3 tags.

## Requirements 🔧

- Deno (latest)
- `yt-dlp` installed in PATH
- `ffmpeg` installed in PATH

## Run ▶️

Permissions required: read/write files and run subprocesses.

Provide the series page URL (the script fetches the page, extracts the `.mujRozhlasPlayer` element's `data-player` JSON and uses it). There is NO fallback to a local file now:

```bash
deno task run https://plus.rozhlas.cz/john-hersey-hirosima-reportazni-roman-o-tom-co-nastalo-po-zablesku-tichu-a-9528460
```

Direct invocation (if not using the task):

```bash
deno run --allow-read=./ --allow-write=./ --allow-run=yt-dlp,ffmpeg --allow-net=plus.rozhlas.cz index.ts https://plus.rozhlas.cz/john-hersey-hirosima-reportazni-roman-o-tom-co-nastalo-po-zablesku-tichu-a-9528460
```

## Notes 📝

- Written in TypeScript; entrypoint is `index.ts` 💻
- MP3 tagging uses `mp3tag.js` via Deno's npm compatibility layer 🎵
- URL argument is mandatory; failure to fetch or parse aborts with an error ❗
- Output files are stored inside a directory named after the series title 📂
