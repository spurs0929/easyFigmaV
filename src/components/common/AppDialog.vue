<script setup lang="ts">
import { computed } from 'vue'
import Dialog from 'primevue/dialog'

const props = withDefaults(
  defineProps<{
    header: string
    /** 請求進行中：暫時鎖住所有關閉入口，避免畫面在結果回來前消失。 */
    busy?: boolean
    /** false 代表只能透過 footer 的動作離開，例如必須二選一的衝突對話框。 */
    dismissible?: boolean
    /**
     * 點遮罩是否關閉。與 dismissible 分開：各對話框原本的遮罩行為不一致，
     * 預設沿用 PrimeVue 的 false。被 busy / dismissible 鎖住時一律無效。
     */
    dismissableMask?: boolean
    /** CSS width。尺寸種類還少，先直接收值，等需求穩定再收斂成語意化的 size。 */
    width?: string
  }>(),
  {
    busy: false,
    dismissible: true,
    dismissableMask: false,
    width: 'min(420px, 92vw)',
  },
)

const visible = defineModel<boolean>('visible', { required: true })

const locked = computed(() => props.busy || !props.dismissible)

/**
 * X、Esc、點遮罩最後都會走 PrimeVue 的 update:visible。
 * 三個入口已經用 props 關掉，這裡再擋一次，讓「鎖住時不會關閉」不依賴
 * PrimeVue 內部有哪些關閉路徑（例如自訂 header 拿到的 closeCallback）。
 */
const visibleModel = computed({
  get: () => visible.value,
  set: (value: boolean) => {
    if (!value && locked.value) return
    visible.value = value
  },
})
</script>

<template>
  <Dialog
    v-model:visible="visibleModel"
    modal
    :draggable="false"
    :header="header"
    :closable="!locked"
    :close-on-escape="!locked"
    :dismissable-mask="dismissableMask && !locked"
    :style="{ width }"
  >
    <slot />
    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </Dialog>
</template>
