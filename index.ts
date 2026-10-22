// Import mp3tag.js with CJS/ESM interoperability safety: Deno's npm loader can
// sometimes surface the CommonJS export object instead of the class itself,
// triggering "This expression is not constructable". We normalize here.
import MP3TagModule from "npm:mp3tag.js";

// Narrow unknown values to a constructable class.
type MP3TagCtor = new (
    buffer: ArrayBuffer | Uint8Array | Buffer,
    verbose?: boolean,
) => {
    read: (...args: unknown[]) => unknown;
    save: (...args: unknown[]) => unknown;
    error: string;
    tags: Record<string, unknown>;
};

function pickMP3Tag(mod: unknown): MP3TagCtor {
    if (typeof mod === "function") return mod as MP3TagCtor; // UMD default export is the class itself
    if (mod && typeof mod === "object") {
        const m = mod as { default?: unknown; MP3Tag?: unknown };
        if (typeof m.default === "function") return m.default as MP3TagCtor;
        if (typeof m.MP3Tag === "function") return m.MP3Tag as MP3TagCtor;
    }
    throw new Error("Unable to resolve MP3Tag constructor export");
}
const MP3Tag = pickMP3Tag(MP3TagModule);
import { Buffer } from "node:buffer";

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
    const fileBytes = Deno.readFileSync(filename);
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
    Deno.writeFileSync(filename, outBytes as Uint8Array);
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

const urlArg = Deno.args[0];
if (!urlArg) {
    console.error(
        "ERROR: Missing URL argument. Usage: deno run <permissions> index.ts <series_page_url>",
    );
    Deno.exit(1);
}
console.log(`Fetching metadata from URL: ${urlArg}`);
const fetched = await fetchRawInputFromUrl(urlArg);
if (!fetched) {
    console.error(
        "ERROR: Unable to obtain data-player JSON from provided URL. Aborting (no fallback).\nCheck the page structure or provide a different URL.",
    );
    Deno.exit(1);
}
const input: RawInputShape = fetched;
const seriesTitle = unescapeCharacters(input.data.series.title);
await Deno.mkdir(seriesTitle, { recursive: true });
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
    {
        const cmd = new Deno.Command("yt-dlp", {
            args: [dashUrl, "--output", filenameBeforeConversion],
        });
        const { code, stderr } = await cmd.output();
        if (code !== 0) {
            throw new Error(new TextDecoder().decode(stderr));
        }
    }
    console.log("\tDownload finished.");

    console.log("\tConversion started.");
    {
        const cmd = new Deno.Command("ffmpeg", {
            args: ["-y", "-i", filenameBeforeConversion, finalFilename],
        });
        const { code, stderr } = await cmd.output();
        if (code !== 0) {
            throw new Error(new TextDecoder().decode(stderr));
        }
    }
    console.log("\tConversion finished.");

    writeId3Tags(finalFilename, author, bookTitle, episodeTitle, track);
    console.log("\tID3 tags written.");

    // Remove original .m4a file after successful conversion & tagging to keep only mp3.
    try {
        // Basic sanity: ensure MP3 exists and is non-empty before deleting source.
        const mp3Info = await Deno.stat(finalFilename);
        if (mp3Info.size > 0) {
            await Deno.remove(filenameBeforeConversion);
            console.log("\tOriginal .m4a deleted.");
        } else {
            console.warn("\tMP3 file seems empty; preserving original .m4a.");
        }
    } catch (e) {
        console.warn("\tCould not delete original .m4a:", e);
    }
}
