import MP3Tag from "mp3tag.js";

import { Buffer } from "node:buffer";
import fs from 'node:fs';
import fsPromises from 'fs/promises'
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

interface EpisodeAudioLink {
    url: string;
    variant: string;
    linkType: string;
    [k: string]: unknown;
}
interface EpisodeData {
    title: string;
    part: string; // numeric string
    audioLinks: EpisodeAudioLink[];
    [k: string]: unknown;
}
interface RawInputShape {
    data: {
        series: { title: string };
        playlist: EpisodeData[];
    };
}

function unescapeCharacters(str: string): string {
    return JSON.parse(`"${str}"`);
}

function writeId3Tags(
    filename: string,
    author: string,
    bookTitle: string,
    episodeTitle: string,
    track: string,
): void {
    const fileBytes = fs.readFileSync(filename);
    const nodeBuf = Buffer.from(fileBytes);
    // mp3tag.js expects a Buffer / ArrayBuffer; Buffer works in Deno via node shim
    const mp3tag = new MP3Tag(nodeBuf);
    mp3tag.read();

    if (mp3tag.error !== "") {
        throw new Error(mp3tag.error);
    }
    mp3tag.tags.title = episodeTitle;
    mp3tag.tags.artist = author;
    mp3tag.tags.album = bookTitle;
    mp3tag.tags.track = track;

    const modified = mp3tag.save({ strict: true, id3v2: { padding: 4096 } });
    const outBytes = modified instanceof Uint8Array
        ? modified
        : modified instanceof ArrayBuffer
        ? new Uint8Array(modified)
        : Array.isArray(modified)
        ? new Uint8Array(modified)
        : (() => {
            // Fallback: coerce to string then to bytes
            const str = String(modified as unknown);
            return new TextEncoder().encode(str);
        })();
    fs.writeFileSync(filename, outBytes as Uint8Array);
}

function splitSeriesTitle(seriesTitle: string): [string, string] {
    const first = seriesTitle.indexOf(":");
    return [seriesTitle.slice(0, first), seriesTitle.slice(first + 2)];
}

// Very small helper to extract data-player JSON with a regex to avoid adding heavy HTML parser dependency.
// It looks for an element whose class attribute contains "mujRozhlasPlayer" (token match) and has a data-player attribute.
const DATA_PLAYER_REGEX =
    /<[^>]*class=["'][^"'>]*\bmujRozhlasPlayer\b[^"'>]*[^>]*data-player=("([^"]+)"|'([^']+)')[^>]*>/i;

async function fetchRawInputFromUrl(
    url: string,
): Promise<RawInputShape | null> {
    try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) {
            console.error(
                `Failed to fetch ${url}: ${res.status} ${res.statusText}`,
            );
            return null;
        }
        const html = await res.text();
        const match = DATA_PLAYER_REGEX.exec(html);
        const dataPlayer = match ? match[2] ?? match[3] : null;
        if (!dataPlayer) {
            console.error(
                "Could not locate .mujRozhlasPlayer[data-player] element in page.",
            );
            return null;
        }
        // data-player content is JSON-like; ensure proper quoting
        try {
            const parsed = JSON.parse(dataPlayer);
            return parsed as RawInputShape;
        } catch (e) {
            console.error("Failed to parse data-player JSON:", e);
            return null;
        }
    } catch (e) {
        console.error("Network/parse error while fetching URL:", e);
        return null;
    }
}

const urlArg = process.argv[2];
if (!urlArg) {
    console.error(
        "ERROR: Missing URL argument. Usage: deno run <permissions> index.ts <series_page_url>",
    );
    process.exit(1);
}
console.log(`Fetching metadata from URL: ${urlArg}`);
const fetched = await fetchRawInputFromUrl(urlArg);
if (!fetched) {
    console.error(
        "ERROR: Unable to obtain data-player JSON from provided URL. Aborting (no fallback).\nCheck the page structure or provide a different URL.",
    );
    process.exit(1);
}
const input: RawInputShape = fetched;
const seriesTitle = unescapeCharacters(input.data.series.title);
fs.mkdirSync(seriesTitle, { recursive: true });
const [author, bookTitle] = splitSeriesTitle(seriesTitle);

const playlist = input.data.playlist;

for (const episode of playlist) {
    if (!episode.audioLinks || episode.audioLinks.length === 0) {
        console.warn(`Skipping episode with no audioLinks: ${episode.title}`);
        continue;
    }
    const episodeTitle = unescapeCharacters(episode.title);
    const track = episode.part;
    // Pick best link preference: dash > hls > mp3 download
    const preferredOrder = ["dash", "hls", "mp3"];
    const chosen = preferredOrder
        .map((v) => episode.audioLinks.find((l) => l.variant === v))
        .find((l): l is EpisodeAudioLink => Boolean(l)) ||
        episode.audioLinks[0];
    const dashUrl = unescapeCharacters(chosen.url);
    const filenameBeforeConversion = `${seriesTitle}/${episodeTitle}.m4a`;
    const finalFilename = `${seriesTitle}/${episodeTitle}.mp3`;

    console.log(`${episodeTitle}`);
    console.log("\tDownload started.");
    try {
        await run("yt-dlp", [dashUrl, "--output", filenameBeforeConversion]);
    } catch (e: unknown) {
        console.log(`\t Download failed. ${e}`)
        process.exit(1);
    }
    console.log("\tDownload finished.");

    console.log("\tConversion started.");
    try {
        await run("ffmpeg", ["-y", "-i", filenameBeforeConversion, finalFilename]);
    } catch (e: unknown) {
        console.log(`\t Conversion failed. ${e}`)
        process.exit(1);
    }
    console.log("\tConversion finished.");

    writeId3Tags(finalFilename, author, bookTitle, episodeTitle, track);
    console.log("\tID3 tags written.");

    // Remove original .m4a file after successful conversion & tagging to keep only mp3.
    try {
        // Basic sanity: ensure MP3 exists and is non-empty before deleting source.
        const mp3Info = await fsPromises.stat(finalFilename);
        if (mp3Info.size > 0) {
            await fsPromises.rm(filenameBeforeConversion);
            console.log("\tOriginal .m4a deleted.");
        } else {
            console.warn("\tMP3 file seems empty; preserving original .m4a.");
        }
    } catch (e) {
        console.warn("\tCould not delete original .m4a:", e);
    }
}
