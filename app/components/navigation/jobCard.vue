<script lang="ts" setup>
import type { JobDetails } from "~/types";

const props = defineProps<{
    job: JobDetails;
}>();

const { settings, activeSettings, updateGlobal } = useSettings();
const { t } = useTranslations();
const { kmToUserUnits, distanceUnit } = useUnitConversion();

const isExpanded = computed(() => settings.value.jobCardExpanded !== false);

const toggleExpanded = () => {
    updateGlobal("jobCardExpanded", !isExpanded.value);
};

const isImperial = computed(() => activeSettings.value.units !== "metric");

const currencySymbol = computed(() =>
    settings.value.selectedGame === "ats" ? "$" : "€",
);

const incomeText = computed(() => {
    const value = Math.round(props.job.income || 0);
    return `${currencySymbol.value}${value.toLocaleString("en-US")}`;
});

const cargoMassText = computed(() => {
    const kg = props.job.cargoMassKg || 0;
    if (kg <= 0) return "";
    if (isImperial.value) {
        return `${Math.round(kg * 2.20462).toLocaleString("en-US")} lb`;
    }
    return `${(kg / 1000).toFixed(1)} t`;
});

const formatMinutes = (minutes: number) => {
    const total = Math.max(0, Math.round(minutes));
    const days = Math.floor(total / 1440);
    const hours = Math.floor((total % 1440) / 60);
    const mins = total % 60;
    const hm = `${hours}h${mins.toString().padStart(2, "0")}`;
    return days > 0 ? `${days}d ${hm}` : hm;
};

const deadlineText = computed(() => {
    const m = props.job.remainingMinutes;
    if (m == null) return t("jobCard.noDeadline");
    if (m <= 0) return t("jobCard.late");
    return formatMinutes(m);
});

const isDeadlineTight = computed(() => {
    const m = props.job.remainingMinutes;
    if (m == null) return false;
    if (m <= 0) return true;
    return props.job.gpsTimeMinutes > 0 && m < props.job.gpsTimeMinutes * 1.15;
});

const gpsText = computed(() => {
    if (props.job.gpsDistanceKm <= 0.05) return "";
    const dist = kmToUserUnits(Math.round(props.job.gpsDistanceKm));
    const time =
        props.job.gpsTimeMinutes > 0
            ? ` · ${formatMinutes(props.job.gpsTimeMinutes)}`
            : "";
    return `${dist} ${distanceUnit.value}${time}`;
});

const damagePercent = computed(() =>
    Math.round((props.job.cargoDamage || 0) * 100),
);

const statusText = computed(() =>
    props.job.cargoLoaded ? t("jobCard.delivering") : t("jobCard.pickup"),
);

const targetCity = computed(() =>
    props.job.cargoLoaded
        ? props.job.destinationCityName
        : props.job.sourceCityName || props.job.destinationCityName,
);
</script>

<template>
    <div
        class="job-card"
        :class="{ 'is-expanded': isExpanded }"
        @click="toggleExpanded"
    >
        <div class="job-header">
            <Icon name="lucide:package" class="job-icon" size="20" />
            <div class="job-header-text">
                <p class="job-cargo">
                    {{ job.cargoName || t("jobCard.title") }}
                </p>
                <p class="job-sub">
                    <span class="job-status">{{ statusText }}</span>
                    <span v-if="targetCity"> · {{ targetCity }}</span>
                </p>
            </div>
            <p class="job-income">{{ incomeText }}</p>
            <Icon
                v-if="isExpanded"
                name="lucide:chevron-up"
                class="job-chevron"
                size="18"
            />
            <Icon
                v-else
                name="lucide:chevron-down"
                class="job-chevron"
                size="18"
            />
        </div>

        <div v-if="isExpanded" class="job-body">
            <div class="job-route">
                <div class="job-point">
                    <Icon name="lucide:circle-dot" size="14" class="dot-from" />
                    <div>
                        <p class="city">{{ job.sourceCityName || "—" }}</p>
                        <p class="company">{{ job.sourceCompanyName }}</p>
                    </div>
                </div>
                <div class="job-line"></div>
                <div class="job-point">
                    <Icon name="lucide:map-pin" size="14" class="dot-to" />
                    <div>
                        <p class="city">{{ job.destinationCityName || "—" }}</p>
                        <p class="company">{{ job.destinationCompanyName }}</p>
                    </div>
                </div>
            </div>

            <div class="job-stats">
                <div class="stat" :class="{ 'is-warning': isDeadlineTight }">
                    <Icon name="lucide:timer" size="16" />
                    <span class="label">{{ t("jobCard.deadline") }}</span>
                    <span class="value">{{ deadlineText }}</span>
                </div>

                <div v-if="gpsText" class="stat">
                    <Icon name="lucide:route" size="16" />
                    <span class="label">{{ t("jobCard.remaining") }}</span>
                    <span class="value">{{ gpsText }}</span>
                </div>

                <div v-if="cargoMassText" class="stat">
                    <Icon name="lucide:weight" size="16" />
                    <span class="label">{{ t("jobCard.weight") }}</span>
                    <span class="value">{{ cargoMassText }}</span>
                </div>

                <div
                    class="stat"
                    :class="{ 'is-warning': damagePercent >= 5 }"
                >
                    <Icon name="lucide:shield-alert" size="16" />
                    <span class="label">{{ t("jobCard.damage") }}</span>
                    <span class="value">{{ damagePercent }}%</span>
                </div>
            </div>
        </div>
    </div>
</template>

<style
    lang="scss"
    scoped
    src="~/assets/scss/scoped/navigation/jobCard.scss"
></style>
