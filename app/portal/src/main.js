import { createApp } from 'vue';
// Self-hosted fonts (no render-blocking third-party request, no client-IP leak to Google).
import '@fontsource/fraunces/500.css';
import '@fontsource/fraunces/600.css';
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';
import './style.css';
import App from './App.vue';

createApp(App).mount('#app');
