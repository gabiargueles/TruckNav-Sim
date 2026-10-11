import { createDecipheriv } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { inflateSync } from "zlib";

/**
 * Reads the in-game GPS route (waypoints set on the game map) from the newest
 * save. The telemetry SDK only exposes the remaining distance of a manual
 * route, but the game stores the waypoints in `economy.stored_gps_ahead_waypoints`
 * -> `gps_waypoint_storage.nav_node_position` every time it saves
 * (autosave while driving, or F5).
 */

type Game = "ats" | "ets2";

export interface SaveGpsRoute {
    /** World coordinates [x, z] of the waypoints still ahead, in order */
    waypoints: [number, number][];
    savedAt: number;
}

const GAME_INFO: Record<Game, { folder: string; appId: string }> = {
    ats: { folder: "American Truck Simulator", appId: "270880" },
    ets2: { folder: "Euro Truck Simulator 2", appId: "227300" },
};

// Key used by the game to encrypt saves (ScsC), the same one SII_Decrypt uses
const SII_KEY = Buffer.from([
    0x2a, 0x5f, 0xcb, 0x17, 0x91, 0xd2, 0x2f, 0xb6, 0x02, 0x45, 0xb3, 0xd8,
    0x36, 0x9e, 0xd0, 0xb2, 0xc2, 0x73, 0x71, 0x56, 0x3f, 0xbf, 0x1f, 0x3c,
    0x9e, 0xdf, 0x6b, 0x11, 0x82, 0x5a, 0x5d, 0x0a,
]);

function listSaveFiles(profilesDir: string): string[] {
    const files: string[] = [];
    if (!existsSync(profilesDir)) return files;

    for (const profile of safeReaddir(profilesDir)) {
        const saveDir = path.join(profilesDir, profile, "save");
        for (const save of safeReaddir(saveDir)) {
            const file = path.join(saveDir, save, "game.sii");
            if (existsSync(file)) files.push(file);
        }
    }
    return files;
}

function safeReaddir(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function findNewestSave(game: Game, documentsDir: string, steamDir: string) {
    const { folder, appId } = GAME_INFO[game];
    const candidates = [
        ...listSaveFiles(path.join(documentsDir, folder, "profiles")),
        ...listSaveFiles(path.join(documentsDir, folder, "steam_profiles")),
    ];

    const userdata = path.join(steamDir, "userdata");
    for (const user of safeReaddir(userdata)) {
        candidates.push(
            ...listSaveFiles(
                path.join(userdata, user, appId, "remote", "profiles"),
            ),
        );
    }

    let newest: { file: string; mtime: number } | null = null;
    for (const file of candidates) {
        try {
            const mtime = statSync(file).mtimeMs;
            if (!newest || mtime > newest.mtime) newest = { file, mtime };
        } catch {
            // file vanished while the game was writing
        }
    }
    return newest;
}

function decodeSave(raw: Buffer): Buffer {
    const magic = raw.subarray(0, 4).toString("latin1");
    if (magic === "ScsC") {
        // magic(4) + hmac(32) + iv(16) + size(4) + aes-256-cbc(zlib(data))
        const iv = raw.subarray(36, 52);
        const decipher = createDecipheriv("aes-256-cbc", SII_KEY, iv);
        const compressed = Buffer.concat([
            decipher.update(raw.subarray(56)),
            decipher.final(),
        ]);
        return inflateSync(compressed);
    }
    return raw;
}

// --- BSII (binary save) reader ---

const ENC_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz_";

function decodeEncodedString(value: bigint): string {
    const base = BigInt(38);
    let s = "";
    while (value > BigInt(0)) {
        const c = Number(value % base);
        value /= base;
        if (c > 0) s += ENC_CHARS[c - 1];
    }
    return s;
}

class Reader {
    pos = 0;
    buf: Buffer;
    constructor(buf: Buffer) {
        this.buf = buf;
    }
    get done() {
        return this.pos >= this.buf.length;
    }
    u8() {
        return this.buf.readUInt8(this.pos++);
    }
    u32() {
        const v = this.buf.readUInt32LE(this.pos);
        this.pos += 4;
        return v;
    }
    i32() {
        const v = this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return v;
    }
    u64() {
        const v = this.buf.readBigUInt64LE(this.pos);
        this.pos += 8;
        return v;
    }
    skip(n: number) {
        this.pos += n;
    }
    string() {
        const len = this.u32();
        const s = this.buf.toString("utf8", this.pos, this.pos + len);
        this.pos += len;
        return s;
    }
    id() {
        const len = this.u8();
        if (len === 0xff) return `_nameless.${this.u64().toString(16)}`;
        const parts: string[] = [];
        for (let i = 0; i < len; i++) parts.push(decodeEncodedString(this.u64()));
        return parts.join(".");
    }
}

// Fixed-size value types: byte length
const FIXED_SIZES: Record<number, number> = {
    0x05: 4, // float
    0x07: 8, // vec2 float
    0x09: 12, // vec3 float
    0x11: 12, // vec3 int32 (fixed point / 256)
    0x17: 16, // quaternion
    0x19: 32, // placement (vec3 + quat, biased)
    0x25: 4,
    0x27: 4,
    0x29: 2,
    0x2b: 2,
    0x2f: 4,
    0x31: 8,
    0x33: 8,
    0x35: 1,
    0x37: 4, // ordinal string index
};

function readValue(r: Reader, type: number): unknown {
    switch (type) {
        case 0x01:
            return r.string();
        case 0x03:
            return decodeEncodedString(r.u64());
        case 0x11:
            return [r.i32(), r.i32(), r.i32()];
        case 0x39:
        case 0x3b:
        case 0x3d:
            return r.id();
    }

    if (FIXED_SIZES[type] !== undefined) {
        r.skip(FIXED_SIZES[type]);
        return undefined;
    }

    // Arrays are the element type + 1, prefixed by a uint32 count
    const elementType = type - 1;
    if (
        (FIXED_SIZES[elementType] !== undefined ||
            [0x01, 0x03, 0x39, 0x3b, 0x3d].includes(elementType)) &&
        type !== 0x38
    ) {
        const count = r.u32();
        const items: unknown[] = [];
        for (let i = 0; i < count; i++) items.push(readValue(r, elementType));
        return items;
    }

    throw new Error(`Unknown BSII value type 0x${type.toString(16)}`);
}

function readGpsFromBsii(buf: Buffer): [number, number][] {
    const r = new Reader(buf);
    r.skip(8); // "BSII" + version

    const structs = new Map<
        number,
        { name: string; fields: { type: number; name: string }[] }
    >();
    const storage = new Map<string, [number, number]>();
    let ahead: string[] = [];

    while (!r.done) {
        const blockType = r.u32();

        if (blockType === 0) {
            if (!r.u8()) continue;
            const id = r.u32();
            const name = r.string();
            const fields: { type: number; name: string }[] = [];
            while (true) {
                const type = r.u32();
                if (type === 0) break;
                const fieldName = r.string();
                if (type === 0x37) {
                    const count = r.u32();
                    for (let i = 0; i < count; i++) {
                        r.u32();
                        r.string();
                    }
                }
                fields.push({ type, name: fieldName });
            }
            structs.set(id, { name, fields });
            continue;
        }

        const struct = structs.get(blockType);
        if (!struct) throw new Error(`Unknown BSII block ${blockType}`);
        const unitId = r.id();

        for (const field of struct.fields) {
            const value = readValue(r, field.type);
            if (
                struct.name === "economy" &&
                field.name === "stored_gps_ahead_waypoints"
            ) {
                ahead = value as string[];
            } else if (
                struct.name === "gps_waypoint_storage" &&
                field.name === "nav_node_position"
            ) {
                const [x, , z] = value as number[];
                storage.set(unitId, [x! / 256, z! / 256]);
            }
        }
    }

    return ahead
        .map((id) => storage.get(id))
        .filter((p): p is [number, number] => !!p);
}

// --- Text save (g_save_format 2) ---

function readGpsFromText(text: string): [number, number][] {
    const aheadMatch = /stored_gps_ahead_waypoints\[\d*\]:\s*(\S+)/g;
    const ahead: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = aheadMatch.exec(text))) ahead.push(m[1]!);

    const storage = new Map<string, [number, number]>();
    const unitRe =
        /gps_waypoint_storage\s*:\s*(\S+)\s*\{[^}]*?nav_node_position:\s*\(([^,]+),[^,]+,([^)]+)\)/g;
    while ((m = unitRe.exec(text))) {
        const x = parseSiiNumber(m[2]!);
        const z = parseSiiNumber(m[3]!);
        if (x !== null && z !== null) storage.set(m[1]!, [x / 256, z / 256]);
    }

    return ahead
        .map((id) => storage.get(id))
        .filter((p): p is [number, number] => !!p);
}

function parseSiiNumber(s: string): number | null {
    const v = Number(s.trim());
    return Number.isFinite(v) ? v : null;
}

let cache: { file: string; mtime: number; route: SaveGpsRoute } | null = null;

export function getGpsRouteFromSave(
    game: Game,
    documentsDir: string,
    steamDir: string,
): SaveGpsRoute | null {
    const newest = findNewestSave(game, documentsDir, steamDir);
    if (!newest) return null;

    if (cache && cache.file === newest.file && cache.mtime === newest.mtime) {
        return cache.route;
    }

    try {
        const data = decodeSave(readFileSync(newest.file));
        const magic = data.subarray(0, 4).toString("latin1");

        let waypoints: [number, number][] = [];
        if (magic === "BSII") {
            waypoints = readGpsFromBsii(data);
        } else if (data.subarray(0, 8).toString("latin1") === "SiiNunit") {
            waypoints = readGpsFromText(data.toString("utf8"));
        } else {
            return null;
        }

        const route = { waypoints, savedAt: newest.mtime };
        cache = { file: newest.file, mtime: newest.mtime, route };
        return route;
    } catch (e) {
        // Usually the game is still writing the file; try again next poll
        console.error("GPS from save failed:", e);
        return null;
    }
}
