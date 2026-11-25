import MP3Tag from "mp3tag.js";

import { Buffer } from "node:buffer";
import fs from 'node:fs';
import fsPromises from 'fs/promises'
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from 'node:readline';

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
    since?: string; // ISO date
    audioLinks: EpisodeAudioLink[];
    [k: string]: unknown;
}
interface RawInputShape {
    data: {
        series: { title: string; totalParts?: string };
        playlist: EpisodeData[];
    };
}

function unescapeCharacters(str: string): string {
    return JSON.parse(`"${str}"`);
}

interface Id3Info {
    title: string;
    author: string;
    album: string;
    track: string; // "n/total"
    year: string;
    narrator: string | null;
}

function writeId3Tags(filename: string, info: Id3Info): void {
    const fileBytes = fs.readFileSync(filename);
    const nodeBuf = Buffer.from(fileBytes);
    const mp3tag = new MP3Tag(nodeBuf);
    mp3tag.read();

    if (mp3tag.error !== "") {
        throw new Error(mp3tag.error);
    }
    mp3tag.tags.title = info.title;
    mp3tag.tags.artist = info.author;
    mp3tag.tags.album = info.album;
    mp3tag.tags.track = info.track;
    mp3tag.tags.year = info.year;
    mp3tag.tags.genre = "Audiobook";
    mp3tag.tags.v2!.TPE2 = info.author; // album artist (groups the book on Android)
    if (info.narrator) mp3tag.tags.v2!.TCOM = info.narrator;

    // ID3v2.3 + UTF-16 is the most widely supported combination on Android players.
    const modified = mp3tag.save({
        strict: true,
        id3v2: { version: 3, encoding: "utf-16", padding: 4096 },
    });
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

// Characters not allowed in file names on FAT/exFAT/Android shared storage.
function sanitizeFilename(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, "_").replace(/[. ]+$/, "").trim();
}

function decodeHtmlEntities(str: string): string {
    return str
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'");
}

// Page contains e.g. `<strong>Čte:</strong> Igor Dostálek </div>`.
function extractNarrator(html: string): string | null {
    // Labels seen: "Čte:", "Účinkuje:", "Účinkují:", "Připravil a čte:".
    const match = /<strong>\s*(?:[^<:]*\s)?(?:čte|účinkuj[eí]):\s*<\/strong>([^<]*)</iu.exec(html);
    const name = match ? decodeHtmlEntities(match[1]).trim() : "";
    return name || null;
}

// Very small helper to extract data-player JSON with a regex to avoid adding heavy HTML parser dependency.
// It looks for an element whose class attribute contains "mujRozhlasPlayer" (token match) and has a data-player attribute.
const DATA_PLAYER_REGEX =
    /<[^>]*class=["'][^"'>]*\bmujRozhlasPlayer\b[^"'>]*[^>]*data-player=("([^"]+)"|'([^']+)')[^>]*>/i;

async function fetchRawInputFromUrl(
    url: string,
): Promise<{ input: RawInputShape; html: string } | null> {
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
            return { input: parsed as RawInputShape, html };
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
        "ERROR: Missing URL argument. Usage: node index.ts <series_page_url>",
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
const { input, html } = fetched;
const seriesTitle = unescapeCharacters(input.data.series.title);
const [author, bookTitle] = splitSeriesTitle(seriesTitle);
const narrator = extractNarrator(html);
const playlist = input.data.playlist;
const totalParts = Number(input.data.series.totalParts) || playlist.length;
const firstAired = playlist.find((e) => e.since)?.since;
const year = String(firstAired ? new Date(firstAired).getFullYear() : new Date().getFullYear());
const outputDir = sanitizeFilename(`${author} - ${bookTitle}`);

console.log(`Author: ${author}`);
console.log(`Book title: ${bookTitle}`);
console.log(`Narrator: ${narrator ?? "(unknown)"}`);
console.log(`Year: ${year}, parts: ${totalParts}`);
console.log(`Output directory: ${outputDir}`);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const response = await (new Promise((resolve, _reject) => {
  rl.question('Continue (y/n)?\n', (response) => {
    resolve(response)
    rl.close();
  })
}))

if (response === 'n') {
  process.exit(0);
}

fs.mkdirSync(outputDir, { recursive: true });

const trackDigits = Math.max(2, String(totalParts).length);

for (const episode of playlist) {
    if (!episode.audioLinks || episode.audioLinks.length === 0) {
        console.warn(`Skipping episode with no audioLinks: ${episode.title}`);
        continue;
    }
    const part = Number(episode.part);
    const episodeTitle = `${bookTitle} – díl ${part}`;
    const baseName = sanitizeFilename(
        `${String(part).padStart(trackDigits, "0")}. díl - ${bookTitle}`,
    );
    // Pick best link preference: dash > hls > mp3 download
    const preferredOrder = ["dash", "hls", "mp3"];
    const chosen = preferredOrder
        .map((v) => episode.audioLinks.find((l) => l.variant === v))
        .find((l): l is EpisodeAudioLink => Boolean(l)) ||
        episode.audioLinks[0];
    const dashUrl = unescapeCharacters(chosen.url);
    const filenameBeforeConversion = `${outputDir}/${baseName}.m4a`;
    const finalFilename = `${outputDir}/${baseName}.mp3`;

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
        await run("ffmpeg", [
            "-y", "-i", filenameBeforeConversion,
            "-id3v2_version", "3", // so year is written as TYER (v2.3), not TDRC (v2.4)
            finalFilename,
        ]);
    } catch (e: unknown) {
        console.log(`\t Conversion failed. ${e}`)
        process.exit(1);
    }
    console.log("\tConversion finished.");

    writeId3Tags(finalFilename, {
        title: episodeTitle,
        author,
        album: bookTitle,
        track: `${part}/${totalParts}`,
        year,
        narrator,
    });
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
