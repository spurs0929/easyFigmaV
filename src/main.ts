import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import Tooltip from 'primevue/tooltip'

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
