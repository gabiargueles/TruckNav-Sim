<script lang="ts" setup>
const props = defineProps<{
    type: "note" | "warning" | "caution";
}>();

const { t } = useTranslations();
</script>

<template>
    <div class="info-box">
        <div class="title">
            <Icon name="lucide:info" class="icon" />
            <p>{{ t(`common.${type}`) }}</p>
        </div>

        <slot name="content"></slot>
    </div>
</template>

<style
    lang="scss"
    scoped
    src="~/assets/scss/scoped/common/infoBox.scss"
></style>
