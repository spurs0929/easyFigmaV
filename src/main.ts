import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import Tooltip from 'primevue/tooltip'
// PrimeVue 不會自己載入圖示字型。少了這一行，<i class="pi …"> 沒有樣式也沒有字型，
// 畫面上是空的（PresenceMembers 的連線中 / 重連中 / 停止狀態）。
import 'primeicons/primeicons.css'

import App from './App.vue'
import router from './router'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    // v1 固定 dark-only：.dark 常駐在 index.html 的 <html>，沒有切換機制。
    options: { darkModeSelector: '.dark' },
  },
})
app.directive('tooltip', Tooltip)

app.mount('#app')
