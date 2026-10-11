import { convertAtsToGeo, convertEts2ToGeo } from "../map/converters";
import { getBearing } from "../map/maths";
import type { GameType, TelemetryPacket } from "~/types";

export function getTruckState(
    data: TelemetryPacket,
    lastPosition: [number, number] | null,
    selectedGame: GameType,
    currentHeadingOffset: number,
    speedSamples: number[],
    maxSamples: number,
) {
    const { x, z } = data.truck.current.position;
    let truckCoords: [number, number];

    if (Math.abs(x) < 0.001 && Math.abs(z) < 0.001) {
        truckCoords = [0, 0];
    } else {
        truckCoords =
            selectedGame === "ets2"
                ? convertEts2ToGeo(x, z)
                : convertAtsToGeo(x, z);
    }

    const truckSpeed = Math.max(
        0,
        Math.floor(data.truck.current.dashboard.speedKph),
    );

    const avgSpeed = updateMovingAverage(truckSpeed, speedSamples, maxSamples);

    const rawGameHeading = data.truck.current.heading;
    const { heading, newOffset } = getCorrectHeading(
        rawGameHeading,
        truckSpeed,
        truckCoords,
        lastPosition,
        currentHeadingOffset,
    );

    return {
        truckCoords,
        truckSpeed,
        truckHeading: heading,
        headingOffset: newOffset,
        avgSpeed,
    };
}

export function getGameState(data: TelemetryPacket) {
    const name = data.game.toLowerCase();
    const gameConnected = name === "ets2" || name === "ats";

    const scale = data.common.mapScale;

    const hasInGameMarker =
        data.navigation.distance > 100 && data.job.income === 0;

    const { formatted, raw } = convertTelemtryTime(data.common.gameTime);
    const day = raw.toUTCString().slice(0, 3);
    const gameTime = `${day} ${formatted}`;

    return {
        gameConnected,
        hasInGameMarker,
        gameTime,
        scale,
    };
}

export function getNavigationState(data: TelemetryPacket) {
    const fuel = parseInt(data.truck.current.dashboard.fuelAmount.toFixed(1));
    const speedLimit = Math.max(0, Math.round(data.navigation.speedLimitKph));

    const totalMinutes = data.common.nextRestStopMinutes;
    const hours = Math.max(0, Math.floor(totalMinutes / 60));
    const mins = Math.max(0, totalMinutes % 60);

    const restStoptime = `${hours.toString().padStart(2, "0")}:${mins
        .toString()
        .padStart(2, "0")}`;

    return { fuel, speedLimit, restStoptime, restStopMinutes: totalMinutes };
}

// Job (source|destination|income) whose trailer has already been picked up,
// so detaching it mid-trip doesn't send the route back to the source company.
let pickedUpJobKey = "";

export function getJobState(data: TelemetryPacket, selectedGame: GameType) {
    let companyTarget = "";
    let cityTarget = "";
    let trailerCoords: [number, number] = [0, 0];

    const hasActiveJob = data.specialEvents.onJob;

    const destinationCity = data.job.cityDestinationId;
    const destinationCompany = data.job.companyDestinationId;

    const sourceCity = data.job.citySourceId;
    const sourceCompany = data.job.companySourceId;

    const jobKey = `${sourceCompany}|${destinationCompany}|${data.job.income}`;
    if (!hasActiveJob) pickedUpJobKey = "";

    const trailer = data.trailers?.[0];
    const isTrailerAvailable =
        !!trailer && trailer.position.y !== 0 && trailer.position.x !== 0;
    const isTrailerAttached = !!trailer?.attached;
    const cargoNotLoaded = data.job.cargoLoaded === false;

    if (hasActiveJob && isTrailerAttached && !cargoNotLoaded) {
        pickedUpJobKey = jobKey;
    }

    // Same as the in-game GPS: while the cargo still has to be picked up
    // (trailer waiting at the source, or own trailer not loaded yet), go to
    // the source company first. Applies to every job type, not only
    // external contracts.
    const mustPickUp =
        hasActiveJob &&
        !!sourceCompany &&
        pickedUpJobKey !== jobKey &&
        ((isTrailerAvailable && !isTrailerAttached) || cargoNotLoaded);

    if (mustPickUp) {
        companyTarget = sourceCompany;
        cityTarget = sourceCity;
    } else {
        companyTarget = destinationCompany;
        cityTarget = destinationCity;
    }

    return { hasActiveJob, cityTarget, companyTarget, trailerCoords };
}

/**
 * Checks if telemetry bridge is reachable
 * @param ip Ip to get data from
 * @param timeoutMs How long to wait before giving up
 * @returns boolean - true if running, false if not
 */
export async function isBridgeRunning(
    ip: string,
    timeoutMs: number = 2000,
): Promise<boolean> {
    const wsUrl = `ws://${ip}:30001`;

    return new Promise((resolve) => {
        const testSocket = new WebSocket(wsUrl);

        const timeoutId = setTimeout(() => {
            testSocket.close();
            resolve(false);
        }, timeoutMs);

        testSocket.onopen = () => {
            clearTimeout(timeoutId);
            testSocket.close();
            resolve(true);
        };

        testSocket.onerror = () => {
            clearTimeout(timeoutId);
            testSocket.close();
            resolve(false);
        };
    });
}

function getCorrectHeading(
    rawGameHeading: number,
    truckSpeed: number,
    currentCoords: [number, number],
    lastPosition: [number, number] | null,
    headingOffset: number,
) {
    let internalOffset = headingOffset;

    const rawDegrees = -rawGameHeading * 360;

    if (lastPosition && truckSpeed > 10) {
        const dist = Math.sqrt(
            Math.pow(currentCoords[0] - lastPosition[0], 2) +
                Math.pow(currentCoords[1] - lastPosition[1], 2),
        );

        if (dist > 0.00005) {
            const trueBearing = getBearing(lastPosition, currentCoords);

            let diff = trueBearing - rawDegrees;
            while (diff < -180) diff += 360;
            while (diff > 180) diff -= 360;

            if (Math.abs(diff) < 90) {
                internalOffset += (diff - internalOffset) * 0.1;
            }
        }
    }

    let finalHeading = rawDegrees + internalOffset;
    finalHeading = ((finalHeading % 360) + 360) % 360;

    return { heading: finalHeading, newOffset: internalOffset };
}

function convertTelemtryTime(time: string) {
    const date = new Date(time);
    return {
        formatted: `${date.getUTCHours().toString().padStart(2, "0")}:${date
            .getUTCMinutes()
            .toString()
            .padStart(2, "0")}`,
        raw: date,
    };
}

function updateMovingAverage(
    currentSpeed: number,
    speedSamples: number[],
    maxSamples: number,
) {
    if (currentSpeed > 10) {
        speedSamples.push(currentSpeed);
        if (speedSamples.length > maxSamples) speedSamples.shift();
    }

    if (speedSamples.length === 0) return 80;

    const sum = speedSamples.reduce((a, b) => a + b, 0);
    return sum / speedSamples.length;
}

const SCS_EPOCH_MS = new Date("0001-01-01T00:00:00Z").getTime();
const MAX_RELATIVE_MINUTES = 60 * 24 * 30;

/**
 * Converts a telemetry time value (ISO string based on 0001-01-01, or a
 * plain number of minutes) into minutes.
 */
function telemetryTimeToMinutes(value: unknown): number | null {
    if (value == null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "object" && value !== null) {
        const obj = value as Record<string, unknown>;
        if (typeof obj.value === "number") return obj.value;
        if (typeof obj.date === "string") return telemetryTimeToMinutes(obj.date);
        return null;
    }
    if (typeof value !== "string") return null;

    const parsed = new Date(value.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
    const ms = parsed.getTime();
    if (Number.isNaN(ms)) return null;

    return Math.round((ms - SCS_EPOCH_MS) / 60000);
}

export function getJobDetails(data: TelemetryPacket) {
    const job = data.job ?? ({} as TelemetryPacket["job"]);
    const nav = data.navigation ?? ({} as TelemetryPacket["navigation"]);
    const trailer = data.trailers?.[0];

    const hasActiveJob = !!data.specialEvents?.onJob;

    let remainingMinutes = telemetryTimeToMinutes(job.remainingDeliveryTime);
    if (remainingMinutes != null && remainingMinutes > MAX_RELATIVE_MINUTES) {
        // Value came as an absolute deadline: subtract current game time
        const now = telemetryTimeToMinutes(data.common?.gameTime);
        remainingMinutes = now != null ? remainingMinutes - now : null;
    }
    if (remainingMinutes != null && remainingMinutes > MAX_RELATIVE_MINUTES) {
        remainingMinutes = null; // no deadline
    }

    const cargoDamage = Math.max(
        job.cargo?.cargoDamage ?? 0,
        trailer?.damage?.cargo ?? 0,
    );

    return {
        hasActiveJob,
        cargoLoaded: !!job.cargoLoaded,
        cargoName: job.cargo?.name || "",
        cargoMassKg: job.cargo?.mass ?? 0,
        cargoDamage: Math.min(1, Math.max(0, cargoDamage)),
        income: job.income ?? 0,
        remainingMinutes,
        sourceCityName: job.citySource || job.citySourceId || "",
        sourceCompanyName: job.companySource || job.companySourceId || "",
        destinationCityName: job.cityDestination || job.cityDestinationId || "",
        destinationCompanyName:
            job.companyDestination || job.companyDestinationId || "",
        gpsDistanceKm: Math.max(0, (nav.distance ?? 0) / 1000),
        gpsTimeMinutes: Math.max(0, Math.round((nav.time ?? 0) / 60)),
        jobType: job.jobType || "",
    };
}
